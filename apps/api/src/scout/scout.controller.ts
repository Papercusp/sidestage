import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { bridgeChannel, sseResponse, sseResponseToNode } from '@papercusp/sse';
import { ScoutService } from './scout.service';
import { ScoutTurnBusService } from './scout-turn-bus.service';
import {
  ifNoneMatchMatches,
  transcriptEtag,
  transcriptVersion,
  visibleTranscript,
} from './scout-session.store';
import {
  SCOUT_SESSION_STORE,
  type ScoutChatRequest,
  type ScoutSessionStore,
  type ScoutStreamEvent,
  type ScoutStreamRequest,
} from './scout.types';

/**
 * The slices of the Node/Express objects these endpoints actually touch.
 *
 * Declared structurally rather than imported from `express` on purpose: this
 * app has no `@types/express` dependency (nothing else in it names an express
 * type), and `@papercusp/sse`'s Node bridge is deliberately deps-free for the
 * same reason. A real express req/res satisfies these, and so does a test
 * double — which is what makes these handlers testable without booting HTTP.
 */
interface StreamRequestLike {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'close', listener: () => void): unknown;
}

interface StreamResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy?(err?: Error): void;
}

interface TranscriptResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

/**
 * Scout HTTP endpoints.
 *
 * The streaming contract (P-007) is the one `@papercusp/scout-chat` consumes:
 *   POST /scout/chat/stream  → SSE of session/tool_start/products/token/done
 *   GET  /scout/session/:id  → the ETag'd durable transcript
 *
 * Note this deliberately does NOT use Nest's `@Sse()` decorator (as the sync
 * module does): `@Sse()` is GET-only and owns the response, so it can carry
 * neither a request body nor the `Last-Event-ID` replay this contract needs.
 */
@Controller('scout')
export class ScoutController {
  constructor(
    @Inject(ScoutService) private readonly scout: ScoutService,
    @Inject(ScoutTurnBusService) private readonly turnBus: ScoutTurnBusService,
    @Inject(SCOUT_SESSION_STORE) private readonly sessions: ScoutSessionStore,
  ) {}

  @Post('chat')
  chat(@Body() body: ScoutChatRequest) {
    return this.scout.chat(body);
  }

  /**
   * Reconnect-safe streaming chat.
   *
   * The turn runs DETACHED into a per-turn ring-buffer channel; this endpoint
   * only streams FROM that channel, which is what makes a dropped connection
   * recoverable rather than fatal to the turn.
   *
   *  - New turn: no `turnId` → mint one, start the turn detached, return it in
   *    the `X-Scout-Turn-Id` response header so the client can resume. Streams
   *    from the top.
   *  - Resume: client re-POSTs `{ turnId, lastEventId }` (or a `Last-Event-ID`
   *    header) → stream the SAME channel, replaying everything after that id.
   *    No new turn is started, so a resume can never duplicate the work or the
   *    transcript.
   */
  @Post('chat/stream')
  chatStream(
    @Req() req: StreamRequestLike,
    @Res() res: StreamResponseLike,
    @Body() body: ScoutStreamRequest,
  ): void {
    const lastEventId = Number(req.headers['last-event-id'] ?? body?.lastEventId ?? 0) || 0;

    let turnId: string;
    if (body?.turnId) {
      turnId = body.turnId; // resume an in-flight (or just-finished, still-buffered) turn
    } else {
      turnId = randomUUID();
      this.turnBus.run(turnId, this.scout.stream(body ?? { message: '' })); // detached
    }
    const channel = this.turnBus.channel(turnId);

    // Client disconnect aborts the SSE response (heartbeat + subscription
    // cleanup). The turn keeps running detached on the channel.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const webRes = sseResponse<{ message: ScoutStreamEvent; error: { message: string } }>({
      signal: ac.signal,
      lastEventId,
      replay: () =>
        channel
          .recentSince(lastEventId)
          .map((item) => ({ id: item.id, name: 'message' as const, data: item.event })),
      setup: (sink) =>
        bridgeChannel(channel.subscribe(), sink, ({ id, event }) => ({
          name: 'message',
          data: event,
          opts: { id },
        })),
    });

    sseResponseToNode(webRes, res, { 'X-Scout-Turn-Id': turnId });
  }

  /**
   * The durable transcript of a session, for the client's versioned restore
   * (@papercusp/data-fetch `useVersionedResource`). NOT the live token stream —
   * only the persisted user-facing turns.
   *
   * Versioned: the ETag is message-count + last-write, so `If-None-Match`
   * yields a bodiless 304 whenever nothing has changed.
   */
  @Get('session/:id')
  async sessionTranscript(
    @Param('id') id: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: TranscriptResponseLike,
  ): Promise<string | { error: string }> {
    const session = await this.sessions.get(id);
    if (!session) {
      res.status(404);
      return { error: 'session not found' };
    }

    const version = transcriptVersion(session);
    const etag = transcriptEtag(id, version);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Per-visitor transcript: private, always revalidate — the client's
    // versioned cache + If-None-Match does the real caching.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      res.status(304);
      return '';
    }
    return JSON.stringify({ version, messages: visibleTranscript(session.messages) });
  }
}

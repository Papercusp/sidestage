import {
  Inject,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { interval, merge, of, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ChatService,
  type ChatMessageInput,
  type ChatSseEvent,
  type PresenceInput,
  type TranscriptMomentInput,
} from './chat.service';

interface SyncQuery {
  name?: unknown;
  args?: unknown;
}

interface SyncBatchBody {
  queries?: unknown;
}

interface SyncResult {
  rows: unknown[];
  version: string;
  error?: string;
}

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Post('chat/events/:eventId/messages')
  sendMessage(@Param('eventId') eventId: string, @Body() body: ChatMessageInput) {
    return this.chat.addMessage(eventId, body ?? {});
  }

  @Post('chat/events/:eventId/transcript')
  addTranscriptMoment(@Param('eventId') eventId: string, @Body() body: TranscriptMomentInput) {
    return this.chat.addTranscriptMoment(eventId, body ?? {});
  }

  @Post('chat/events/:eventId/presence')
  joinPresence(@Param('eventId') eventId: string, @Body() body: PresenceInput) {
    return this.chat.touchPresence(eventId, body ?? {});
  }

  @Delete('chat/events/:eventId/presence/:userId')
  leavePresence(@Param('eventId') eventId: string, @Param('userId') userId: string) {
    this.chat.removePresence(eventId, userId);
    return { ok: true };
  }

  @Get('chat/events/:eventId/presence')
  getPresence(@Param('eventId') eventId: string) {
    return this.chat.getPresence(eventId);
  }

  /**
   * Shared sync read contract consumed by @papercusp/sync's SSE/polling
   * adapters. Results stay index-aligned with the incoming query list.
   */
  @Post('sync/rest-query-batch')
  restQueryBatch(@Body() body: SyncBatchBody) {
    const queries = Array.isArray(body?.queries) ? body.queries : [];
    const results: SyncResult[] = queries.map((rawQuery) => this.runQuery(rawQuery as SyncQuery));
    return { results };
  }

  @Sse('sync/sse')
  syncEvents(@Query('eventId') eventId: string): Observable<MessageEvent> {
    const heartbeat = interval(15_000).pipe(
      map(() => this.heartbeat()),
    );
    const initial = of(this.heartbeat());
    const updates = this.chat.updates(eventId).pipe(
      map((event): MessageEvent => event as ChatSseEvent as MessageEvent),
    );
    return merge(initial, heartbeat, updates);
  }

  private runQuery(query: SyncQuery): SyncResult {
    const name = typeof query.name === 'string' ? query.name : '';
    const args = this.readArgs(query.args);
    const eventId = typeof args.eventId === 'string' ? args.eventId : '';
    try {
      let rows: unknown[];
      switch (name) {
        case 'event.chat.messages':
          rows = this.chat.getMessages(eventId);
          break;
        case 'event.chat.presence':
          rows = this.chat.getPresence(eventId);
          break;
        case 'event.chat.stats':
          rows = [this.chat.getStats(eventId)];
          break;
        default:
          return { rows: [], version: String(Date.now()), error: `unknown sync query: ${name || '<empty>'}` };
      }
      // Keep the success shape explicit for in-process callers. JSON transport
      // still omits undefined, while object consumers can distinguish a valid
      // empty result from a missing batch slot without probing property shape.
      return { rows, version: String(Date.now()), error: undefined };
    } catch (error) {
      return {
        rows: [],
        version: String(Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private heartbeat(): MessageEvent {
    const now = Date.now();
    return {
      id: `heartbeat-${now}`,
      type: 'heartbeat',
      data: JSON.stringify({ tsMs: now }),
    };
  }
}

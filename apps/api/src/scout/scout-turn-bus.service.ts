import { Injectable, Logger } from '@nestjs/common';
import { getChannel, type BusChannel } from '@papercusp/sse';
import type { ScoutStreamEvent } from './scout.types';

/**
 * Decouples a scout turn from any single SSE connection.
 *
 * A turn runs DETACHED: `run()` drives the generator and publishes every event
 * into a per-turn `BusChannel` (the @papercusp/sse in-process ring buffer,
 * keyed by turnId). The SSE endpoint streams *from* the channel — so when a
 * connection drops mid-turn the client reconnects with `Last-Event-ID`, the
 * channel replays what it missed, and the stream resumes live. The turn itself
 * never depended on the connection, which is the whole point: a turn that dies
 * with its socket cannot be resumed no matter what the client does.
 *
 * Durability scope, stated: the channel lives in this process's memory.
 * Reconnect survives a CONNECTION drop, not an API restart or a second
 * instance behind a balancer. SideStage's api is single-instance today; going
 * multi-instance would require persisting turn events (persist them — do not
 * use Postgres as the transport).
 *
 * Ported from Restart `apps/scout-service/src/scout/turn-bus.service.ts`.
 */
@Injectable()
export class ScoutTurnBusService {
  private readonly log = new Logger(ScoutTurnBusService.name);

  /** The ring-buffer channel for a turn (created on first access; self-GCs after done() + 0 subscribers). */
  channel(turnId: string): BusChannel<ScoutStreamEvent> {
    return getChannel<ScoutStreamEvent>(this.key(turnId));
  }

  /**
   * Run a turn detached: pump the generator into the channel, then `done()`.
   * Called exactly once per newly minted turnId — a resume request never calls
   * this, it only streams from the existing channel.
   */
  run(turnId: string, gen: AsyncGenerator<ScoutStreamEvent>): void {
    const ch = this.channel(turnId);
    void (async () => {
      try {
        for await (const ev of gen) ch.publish(ev);
      } catch (err) {
        this.log.error(`scout turn ${turnId} failed: ${err}`);
        // Surface a terminal error into the stream — a turn that dies silently
        // leaves the drawer spinning on a reply that will never arrive.
        ch.publish({ type: 'error', message: 'Sorry, something went wrong. Please try again.' });
      } finally {
        ch.done();
      }
    })();
  }

  private key(turnId: string): string {
    return `scout:turn:${turnId}`;
  }
}

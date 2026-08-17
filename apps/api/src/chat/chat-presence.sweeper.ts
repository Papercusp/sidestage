import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { ChatService } from './chat.service';

/**
 * How often stale `chat_presence` rows are swept, in milliseconds.
 *
 * Must stay well under the presence TTL (35s) so a client reading the
 * replicated table directly never shows a ghost participant for materially
 * longer than the REST read path would have.
 */
export const DEFAULT_PRESENCE_SWEEP_INTERVAL_MS = 10_000;

export function presenceSweepIntervalMs(
  raw: string | undefined = process.env.CHAT_PRESENCE_SWEEP_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_PRESENCE_SWEEP_INTERVAL_MS;
  return Math.floor(parsed);
}

/**
 * Presence expiry used to happen as a side effect of `GET /events/:id/chat/presence`:
 * the store pruned rows older than the TTL while answering the read. That makes
 * liveness a property of the READER, not of the durable table — invisible to
 * anything that reads `chat_presence` directly, which is exactly what the Zero /
 * WebSocket transport does. Without this sweeper, a room synced over Zero would
 * accumulate ghost participants indefinitely and `chat_presence` would grow
 * without bound in a room nobody polls over REST.
 *
 * The timer is `unref`'d so it never keeps a process (or a test runner) alive.
 */
@Injectable()
export class ChatPresenceSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatPresenceSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    private readonly intervalMs: number = presenceSweepIntervalMs(),
  ) {}

  onModuleInit(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One sweep. Never throws: a transient database failure must not take the
   * process down, and the next tick retries.
   */
  async sweep(): Promise<string[]> {
    try {
      return await this.chat.expireStalePresence();
    } catch (error) {
      this.logger.warn(`Presence sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

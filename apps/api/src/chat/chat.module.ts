import { forwardRef, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuctionModule } from '../auction/auction.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgChatStore } from '../db/pg-chat-store';
import { EventModule } from '../events/event.module';
import { EventVisibilityGuard } from '../events/event-visibility.guard';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry, type SyncQueryArgs } from '../sync/sync-query.registry';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { CHAT_STORE, InMemoryChatStore, type ChatStore } from './chat.store';
import { ConfiguredProductFocusClassifier } from './product-focus.classifier';

function eventIdFrom(args: SyncQueryArgs): string { return typeof args.eventId === 'string' ? args.eventId : ''; }

@Injectable()
export class ChatSyncQueries implements OnModuleInit {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventVisibilityGuard) private readonly visibility: EventVisibilityGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.chat.messages', (args) => this.chat.getMessages(eventIdFrom(args)));
    this.queries.register('event.chat.transcript', async (args) => {
      const eventId = eventIdFrom(args);
      await this.visibility.assertBuyerVisible(eventId);
      return this.chat.getTranscript(eventId);
    });
    this.queries.register('event.chat.presence', (args) => this.chat.getPresence(eventIdFrom(args)));
    this.queries.register('event.chat.stats', async (args) => [await this.chat.getStats(eventIdFrom(args))]);
    this.queries.register('event.replay.chapters', (args) => this.chat.getReplayChapters(eventIdFrom(args)));
  }
}

@Module({
  imports: [forwardRef(() => AuctionModule), DatabaseModule, forwardRef(() => EventModule), SyncModule],
  controllers: [ChatController],
  providers: [
    { provide: CHAT_STORE, inject: [PG_POOL], useFactory: (pool: Pool | null): ChatStore => pool ? new PgChatStore(pool) : new InMemoryChatStore() },
    ChatService,
    ChatSyncQueries,
    ConfiguredProductFocusClassifier,
  ],
  exports: [ChatService, CHAT_STORE],
})
export class ChatModule {}

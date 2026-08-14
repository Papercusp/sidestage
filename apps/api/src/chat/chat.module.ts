import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry, type SyncQueryArgs } from '../sync/sync-query.registry';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

function eventIdFrom(args: SyncQueryArgs): string {
  return typeof args.eventId === 'string' ? args.eventId : '';
}

@Injectable()
export class ChatSyncQueries implements OnModuleInit {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.chat.messages', (args) => this.chat.getMessages(eventIdFrom(args)));
    this.queries.register('event.chat.presence', (args) => this.chat.getPresence(eventIdFrom(args)));
    this.queries.register('event.chat.stats', (args) => [this.chat.getStats(eventIdFrom(args))]);
    this.queries.register('event.replay.chapters', (args) => this.chat.getReplayChapters(eventIdFrom(args)));
  }
}

@Module({
  imports: [SyncModule],
  controllers: [ChatController],
  providers: [ChatService, ChatSyncQueries],
  exports: [ChatService],
})
export class ChatModule {}

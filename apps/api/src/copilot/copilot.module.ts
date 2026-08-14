import { Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Subscription } from 'rxjs';
import { ActionModule } from '../actions/action.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { ChatService, isBuyerQuestion } from '../chat/chat.service';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { JudgeModule } from '../judge/judge.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CopilotController } from './copilot.controller';
import { SideStageGroundingRetriever } from './copilot.grounding';
import { ConfiguredCopilotReplyModel } from './copilot.model';
import { GroundedCopilotPipeline } from './copilot.pipeline';
import { COPILOT_PIPELINE, COPILOT_PROPOSAL_STORE, type CopilotProposalStore } from './copilot.runtime.types';
import { CopilotProposalService } from './copilot.service';
import { InMemoryCopilotProposalStore, PgCopilotProposalStore } from './copilot.store';

@Injectable()
export class CopilotSyncQueries implements OnModuleInit {
  constructor(
    @Inject(CopilotProposalService) private readonly copilot: CopilotProposalService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.copilot.proposals', (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      return this.copilot.list(eventId);
    });
  }
}

@Injectable()
export class BuyerQuestionCopilotSubscriber implements OnModuleInit, OnModuleDestroy {
  private subscription?: Subscription;

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(CopilotProposalService) private readonly copilot: CopilotProposalService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.chat.messageEvents().subscribe((message) => {
      if (message.role !== 'buyer' || !isBuyerQuestion(message.text)) return;
      void this.copilot.createFromChat(message).catch(() => undefined);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}

@Module({
  imports: [DatabaseModule, SyncModule, ChatModule, CatalogModule, EventConfigModule, ActionModule, JudgeModule],
  controllers: [CopilotController],
  providers: [
    SideStageGroundingRetriever,
    ConfiguredCopilotReplyModel,
    CopilotProposalService,
    CopilotSyncQueries,
    BuyerQuestionCopilotSubscriber,
    {
      provide: COPILOT_PROPOSAL_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null): CopilotProposalStore => (
        pool ? new PgCopilotProposalStore(pool) : new InMemoryCopilotProposalStore()
      ),
    },
    {
      provide: COPILOT_PIPELINE,
      inject: [SideStageGroundingRetriever, ConfiguredCopilotReplyModel],
      useFactory: (retriever: SideStageGroundingRetriever, model: ConfiguredCopilotReplyModel) => (
        // This composition always creates a durable seller-review proposal.
        // Even an event configured for auto may execute only after the seller
        // confirms through CopilotProposalService's fresh-context boundary.
        new GroundedCopilotPipeline({ retriever, model, automationCeiling: 'confirm' })
      ),
    },
  ],
  exports: [CopilotProposalService],
})
export class CopilotModule {}

import { Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Subscription } from 'rxjs';
import { ActionModule } from '../actions/action.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import { EventConfigModule } from '../config/event-config.module';
import { EventModule } from '../events/event.module';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { JudgeModule } from '../judge/judge.module';
import { createVertexAdapter } from '../llm/vertex-adapter';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CopilotController } from './copilot.controller';
import { SideStageGroundingRetriever } from './copilot.grounding';
import { ConfiguredCopilotReplyModel } from './copilot.model';
import { GroundedCopilotPipeline } from './copilot.pipeline';
import { VertexCopilotReplyModel } from './copilot-vertex.model';
import { COPILOT_PIPELINE, COPILOT_PROPOSAL_STORE, type CopilotProposalStore } from './copilot.runtime.types';
import { CopilotProposalService } from './copilot.service';
import { InMemoryCopilotProposalStore, PgCopilotProposalStore } from './copilot.store';

@Injectable()
export class CopilotSyncQueries implements OnModuleInit {
  constructor(
    @Inject(CopilotProposalService) private readonly copilot: CopilotProposalService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.copilot.proposals', async (args, context) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      await this.ownership.requireOwned(eventId, context.principal);
      return this.copilot.list(eventId);
    });
  }
}

@Injectable()
export class BuyerQuestionCopilotSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuyerQuestionCopilotSubscriber.name);
  private subscription?: Subscription;

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(CopilotProposalService) private readonly copilot: CopilotProposalService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.chat.messageEvents().subscribe((message) => {
      if (
        message.role !== 'buyer'
        || message.grounding?.status !== 'seller-queue'
        || message.grounding.route?.destination === 'none'
      ) return;
      void this.copilot.createFromChat(message).catch((error: unknown) => {
        this.logger.error(
          `Failed to deliver queued buyer question ${message.id} to Copilot`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}

@Module({
  imports: [DatabaseModule, SyncModule, ChatModule, CatalogModule, EventConfigModule, EventModule, ActionModule, JudgeModule],
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
      inject: [SideStageGroundingRetriever, ConfiguredCopilotReplyModel, CATALOG_SOURCE],
      useFactory: (
        retriever: SideStageGroundingRetriever,
        configured: ConfiguredCopilotReplyModel,
        catalog: CatalogSource,
      ) => {
        // Gemini drafts replies when Google credentials are present; the
        // deterministic engine remains the fallback inside the Vertex model
        // and the whole model when credentials are absent. The adapter is
        // constructed lazily here — never at import time — so a clone without
        // credentials still boots.
        const adapter = createVertexAdapter(process.env.SIDESTAGE_COPILOT_VERTEX_MODEL);
        const model = adapter ? new VertexCopilotReplyModel(adapter, configured) : configured;
        // This composition always creates a durable seller-review proposal.
        // Even an event configured for auto may execute only after the seller
        // confirms through CopilotProposalService's fresh-context boundary.
        // The research fallback is ALWAYS injected, never gated on a web
        // provider existing. When the catalog covers the asked-for properties
        // it answers alone and no web call happens; when it does not, the
        // unconfigured web source degrades the round, which blocks the draft
        // rather than letting it answer from a catalog that lacks the fact.
        // Gating this on configuration is what previously left the entire
        // research path dead in production.
        const researchFallback = new ParallelResearchFallback(
          new CatalogResearchAdapter(catalog),
          new UnconfiguredWebResearchSource(),
        );
        return new GroundedCopilotPipeline({ retriever, model, researchFallback, automationCeiling: 'confirm' });
      },
    },
  ],
  exports: [CopilotProposalService],
})
export class CopilotModule {}

import { Inject, Injectable } from '@nestjs/common';
import { GuardedActionService } from '../actions/action.service';
import { CATALOG_SOURCE, type CatalogSource, type CatalogVariant } from '../catalog/catalog.types';
import { ChatService, type TranscriptMoment } from '../chat/chat.service';
import { EVENT_POLICY_RESOLVER, type EventPolicyResolver } from '../config/event-policy-resolver';
import type {
  CatalogProductContext,
  GroundingContext,
  GroundingRetriever,
  GroundingSource,
  RetrievalRequest,
  TranscriptGroundingContext,
} from './copilot.types';

function productFrom(variant: CatalogVariant): CatalogProductContext {
  return {
    productId: variant.id,
    title: variant.title,
    description: variant.description,
    priceCents: variant.priceCents,
    attributes: {
      sku: variant.sku,
      brand: variant.brand,
      productType: variant.productType,
      ...(variant.color ? { color: variant.color } : {}),
      ...(variant.size ? { size: variant.size } : {}),
      ...(variant.condition ? { condition: variant.condition } : {}),
      ...(variant.handlingDays !== null ? { handlingDays: variant.handlingDays } : {}),
      availableQty: variant.availableQty,
    },
  };
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((token) => token.length >= 3));
}

function relevantTranscript(question: string, moments: readonly TranscriptMoment[]): TranscriptGroundingContext[] {
  const wanted = tokens(question);
  return moments
    .map((moment) => ({ moment, score: [...tokens(moment.text)].filter((token) => wanted.has(token)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ moment }) => ({
      transcriptId: moment.id,
      text: moment.text,
      startMs: moment.startMs,
      endMs: moment.endMs,
      productId: moment.productId,
      productTitle: moment.productTitle,
    }));
}

@Injectable()
export class SideStageGroundingRetriever implements GroundingRetriever {
  constructor(
    @Inject(CATALOG_SOURCE) private readonly catalog: CatalogSource,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(EVENT_POLICY_RESOLVER) private readonly policies: EventPolicyResolver,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<GroundingContext> {
    const eventItems = this.actions.listItems(request.eventId);
    const [page, policy, transcript] = await Promise.all([
      this.catalog.search({ q: request.query, availability: 'in-stock', pageSize: request.limit }),
      this.policies.resolve(request.eventId, eventItems),
      this.chat.getTranscript(request.eventId),
    ]);
    const catalogProducts = page.rows.map(productFrom);
    const transcriptMoments = relevantTranscript(request.query, transcript);
    const sources: GroundingSource[] = [
      ...eventItems.map((item) => ({
        id: `event-item:${item.eventItemId}`,
        kind: 'event-item' as const,
        label: `${item.title} live event listing`,
      })),
      ...catalogProducts.map((product) => ({
        id: `catalog-product:${product.productId}`,
        kind: 'catalog-product' as const,
        label: `${product.title} verified catalog record`,
      })),
      ...transcriptMoments.map((moment) => ({
        id: `transcript:${moment.transcriptId}`,
        kind: 'transcript' as const,
        label: moment.startMs === undefined ? 'Live transcript' : `Live transcript at ${Math.floor(moment.startMs / 1000)}s`,
      })),
      { id: `policy:${request.eventId}`, kind: 'policy', label: 'Effective seller policy' },
    ];
    return { eventItems, catalogProducts, transcriptMoments, policy, sources };
  }
}

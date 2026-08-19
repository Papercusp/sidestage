import { Inject, Injectable } from '@nestjs/common';
import { GuardedActionService } from '../actions/action.service';
import type { ActionEventItem } from '../actions/action.types';
import { CATALOG_SOURCE, type CatalogSource, type CatalogVariant } from '../catalog/catalog.types';
import { ChatService, type TranscriptMoment } from '../chat/chat.service';
import { EVENT_POLICY_RESOLVER, type EventPolicyResolver } from '../config/event-policy-resolver';
import type {
  CatalogProductContext,
  EventItemContext,
  GroundingContext,
  GroundingRetriever,
  GroundingSource,
  RetrievalRequest,
  TranscriptGroundingContext,
} from './copilot.types';

/**
 * D-035: THE seam between the lineup row and the copilot's grounding
 * vocabulary. `ActionEventItem` spells its fields with the
 * `event_lineup_item` column names because ZQL replicates that table verbatim
 * (D-024); `EventItemContext` spells them the way the prompt-building code
 * reads them. Those are two different jobs, so the translation is written out
 * once, here, instead of being inherited.
 *
 * Add a field to grounding? Map it in this function. Never re-couple the two
 * interfaces to avoid writing a line of mapping.
 */
export function toEventItemContext(item: ActionEventItem): EventItemContext {
  return {
    eventItemId: item.eventItemId,
    productId: item.productId,
    title: item.title,
    description: item.description,
    priceCents: item.currentPriceCents,
    availableQty: item.currentQuantity,
    // D-024 deleted the stored `onStage` boolean; stage presence is derived
    // from the one stage truth. `listingStateOf` (copilot.claims) reads this
    // to tell 'on-stage' from 'listed'.
    onStage: item.stageState === 'on-stage',
    attributes: { ...item.attributes },
  };
}

/**
 * The priced projection the policy resolver needs. It wants a price, not a
 * lineup row — so it gets one, rather than the resolver learning the column
 * names of a table it has no stake in.
 */
export function toPricedEventItem(item: ActionEventItem): { productId: string; priceCents: number } {
  return { productId: item.productId, priceCents: item.currentPriceCents };
}

/**
 * Event price/quantity remain event-scoped, while sellable availability is
 * bounded by the current global catalog row. The action snapshot can further
 * reduce that bound (for example, a pending targeted offer), but can never
 * make stale stock appear larger than the live catalog authority.
 */
export function reconcileEventItemAvailability(
  item: ActionEventItem,
  variant: CatalogVariant | undefined,
): EventItemContext {
  const catalogAvailableQty = variant?.availableQty ?? 0;
  const base = toEventItemContext(item);
  return {
    ...base,
    availableQty: Math.max(0, Math.min(item.currentQuantity, item.listedQuantity, catalogAvailableQty)),
    attributes: {
      ...base.attributes,
      eventListedQty: item.listedQuantity,
      catalogAvailableQty,
    },
  };
}

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
      startMs: moment.startMs ?? undefined,
      endMs: moment.endMs ?? undefined,
      productId: moment.productId ?? undefined,
      productTitle: moment.productTitle ?? undefined,
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
    const actionItems = await this.actions.listItems(request.eventId);
    const [variants, page, policy, transcript] = await Promise.all([
      Promise.all(actionItems.map((item) => this.catalog.variant(item.productId))),
      this.catalog.search({ q: request.query, availability: 'in-stock', pageSize: request.limit }),
      this.policies.resolve(request.eventId, actionItems.map(toPricedEventItem)),
      this.chat.getTranscript(request.eventId),
    ]);
    const eventItems = actionItems.map((item, index) => reconcileEventItemAvailability(item, variants[index]));
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

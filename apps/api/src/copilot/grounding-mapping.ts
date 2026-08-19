import type { ActionEventItem } from '../actions/action.types';
import type { EventItemContext } from './copilot.types';

/**
 * D-035: THE seam between the lineup row and the copilot's grounding
 * vocabulary — and deliberately a LEAF module.
 *
 * `ActionEventItem` spells its fields with the `event_lineup_item` column
 * names because ZQL replicates that table verbatim (D-024); `EventItemContext`
 * spells them the way prompt-building code reads them. Two different jobs, so
 * the translation is written out once rather than inherited.
 *
 * ⚠ WHY THIS FILE EXISTS SEPARATELY FROM `copilot.grounding.ts`: that module
 * imports `GuardedActionService`, and the action service needs this mapper —
 * putting the mapper there creates an import CYCLE that Nest reports as
 * "can't resolve dependencies of the SideStageGroundingRetriever ... argument
 * at index [1]", because the service is undefined at injection time. This file
 * imports TYPES ONLY, so both sides can depend on it. Keep it that way: no
 * runtime import of a service belongs here.
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

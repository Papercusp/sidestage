import type {
  CopilotActionKind,
  CopilotActionProposal,
  CopilotPolicy,
  GroundingContext,
} from '../copilot/copilot.types';

export type GuardedActionKind = CopilotActionKind;
export type ActionAuditKind = GuardedActionKind | 'rollback';
export type ActionItemStageState = 'queued' | 'on-stage' | 'completed';

/**
 * The mutable event-facing state owned by the guarded action service.
 *
 * D-035: this DELIBERATELY does not extend `EventItemContext`. That type is the
 * copilot's LLM grounding vocabulary; this one is the lineup row that
 * `event.actions.items` replicates. They happened to share field names, and
 * inheriting made the two purposes look like one — so a rename demanded by the
 * Zero/REST sync contract (D-024) would have rewritten prompt-building code
 * that has no stake in replication.
 *
 * The single translation seam between them is
 * `reconcileEventItemAvailability` (copilot.grounding.ts), which already
 * constructs an `EventItemContext` field by field. Keep it that way: any new
 * field needed by grounding is mapped THERE, never inherited from here.
 */
export interface ActionEventItem {
  eventItemId: string;
  eventId: string;
  productId: string;
  title: string;
  description?: string;
  /**
   * D-024: these three carry the `event_lineup_item` COLUMN names, not the
   * names the domain used to prefer. ZQL has no projection layer, so the
   * replicated table's shape IS the sync contract — the REST rung has to meet
   * it, and the cheapest way to keep them from drifting again is to spell them
   * the same everywhere between the column and the wire.
   */
  /** `current_price_cents` — current event price, in integer cents. */
  currentPriceCents: number;
  /** `current_quantity` — how many are still sellable right now. */
  currentQuantity: number;
  attributes: Record<string, string | number | boolean>;
  /**
   * Stable event/list price captured when the item is first registered.
   * Optional only at the HTTP registration boundary; GuardedActionService
   * normalizes and preserves it before exposing or mutating the item.
   */
  referencePriceCents?: number;
  /** `listed_quantity` — quantity currently listed for this event item. */
  listedQuantity: number;
  /** Stable seller-authored order within this event's lineup. */
  position?: number;
  /**
   * D-024: the ONLY stage truth. The former `onStage` boolean is deleted, not
   * renamed — it was a projection of this field (`stageState === 'on-stage'`),
   * and carrying both let a caller read a stale boolean beside a fresh state.
   */
  stageState?: ActionItemStageState;
  /** Optimistic-concurrency version supplied by the lineup authority. */
  version?: number;
  /** D-026: integer epoch milliseconds — see StoredActionEventItem. */
  createdAt?: number;
  /** D-026: integer epoch milliseconds — see StoredActionEventItem. */
  updatedAt?: number;
}

export interface TargetedOffer {
  id: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  buyerId: string;
  priceCents: number;
  quantity: number;
  status: 'pending' | 'accepted' | 'expired' | 'cancelled';
  createdAt?: string;
}

export interface ActionStateSnapshot {
  item: ActionEventItem;
  offers: readonly TargetedOffer[];
}

export interface ActionAuditRecord {
  id: string;
  eventId: string;
  actorId: string;
  kind: ActionAuditKind;
  productId: string;
  buyerId?: string;
  reason: string;
  before: ActionStateSnapshot;
  after: ActionStateSnapshot;
  createdAt: string;
  clientRequestId?: string;
  rollbackOf?: string;
  rolledBackAt?: string;
}

/**
 * A price-adjust may also change the event quantity. The P-014 copilot
 * proposal remains intentionally narrow, so the executor validates this
 * optional quantity separately after applying the shared price guard.
 */
export type GuardedActionProposal = CopilotActionProposal & {
  quantity?: number;
};

export interface ApplyActionInput {
  eventId: string;
  actorId: string;
  action: GuardedActionProposal;
  /** Stable mutation key used to return the first audited result on retries. */
  clientRequestId?: string;
}

export interface RegisterActionEventInput {
  policy: CopilotPolicy;
  items: readonly ActionEventItem[];
}

export interface ActionExecutionResult {
  auditId: string;
  status: 'executed';
  state: ActionEventItem;
  offer?: TargetedOffer;
}

export interface RollbackResult extends ActionExecutionResult {
  rolledBackAuditId: string;
}

/**
 * D-035: this used to narrow `eventItems` to `ActionEventItem[]`, which only
 * typechecked while that interface inherited `EventItemContext`. The guard
 * reads grounding fields, so it gets a grounding context — the lineup row is
 * translated by `toEventItemContext` at the one seam rather than smuggled in
 * through a narrowing.
 */
export type ActionGuardContext = GroundingContext;

import type {
  CopilotActionKind,
  CopilotActionProposal,
  CopilotPolicy,
  EventItemContext,
  GroundingContext,
} from '../copilot/copilot.types';

export type GuardedActionKind = CopilotActionKind;
export type ActionAuditKind = GuardedActionKind | 'rollback';
export type ActionItemStageState = 'queued' | 'on-stage' | 'completed';

/** The mutable event-facing state owned by the guarded action service. */
export interface ActionEventItem extends EventItemContext {
  eventId: string;
  /**
   * Stable event/list price captured when the item is first registered.
   * Optional only at the HTTP registration boundary; GuardedActionService
   * normalizes and preserves it before exposing or mutating the item.
   */
  referencePriceCents?: number;
  /** Quantity currently listed for this event item. */
  quantity: number;
  /**
   * True when this item is the one on stage (set by push / swap). Optional at
   * the registration boundary; normalizeItem always stores a boolean.
   */
  onStage?: boolean;
  /** Stable seller-authored order within this event's lineup. */
  position?: number;
  /** Durable lifecycle state; `onStage` remains the compatibility projection. */
  stageState?: ActionItemStageState;
  /** Optimistic-concurrency version supplied by the lineup authority. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
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

export interface ActionGuardContext extends GroundingContext {
  eventItems: readonly ActionEventItem[];
}

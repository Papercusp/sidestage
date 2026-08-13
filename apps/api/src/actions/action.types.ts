import type {
  CopilotActionKind,
  CopilotActionProposal,
  CopilotPolicy,
  EventItemContext,
  GroundingContext,
} from '../copilot/copilot.types';

export type GuardedActionKind = CopilotActionKind;
export type ActionAuditKind = GuardedActionKind | 'rollback';

/** The mutable event-facing state owned by the guarded action service. */
export interface ActionEventItem extends EventItemContext {
  eventId: string;
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

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EVENT_POLICY_RESOLVER, type EventPolicyResolver } from '../config/event-policy-resolver';
import { PolicyActionGuard } from '../copilot/guardrail';
import type { ActionExecutor, CopilotActionProposal, CopilotPolicy } from '../copilot/copilot.types';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import type {
  ActionAuditRecord,
  ActionEventItem,
  ActionExecutionResult,
  ActionGuardContext,
  ActionStateSnapshot,
  ApplyActionInput,
  GuardedActionProposal,
  RegisterActionEventInput,
  RollbackResult,
  TargetedOffer,
} from './action.types';

function cloneItem(item: ActionEventItem): ActionEventItem {
  return { ...item, attributes: { ...item.attributes } };
}

function cloneOffer(offer: TargetedOffer): TargetedOffer {
  return { ...offer };
}

function cloneSnapshot(snapshot: ActionStateSnapshot): ActionStateSnapshot {
  return {
    item: cloneItem(snapshot.item),
    offers: snapshot.offers.map(cloneOffer),
  };
}

function cloneAudit(audit: ActionAuditRecord): ActionAuditRecord {
  return {
    ...audit,
    before: cloneSnapshot(audit.before),
    after: cloneSnapshot(audit.after),
  };
}

function itemKey(eventId: string, productId: string): string {
  return `${eventId}:${productId}`;
}

function assertText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new BadRequestException(`${field} is required`);
  return normalized;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  return value;
}

function sameItem(left: ActionEventItem, right: ActionEventItem): boolean {
  return left.eventId === right.eventId
    && left.eventItemId === right.eventItemId
    && left.productId === right.productId
    && left.referencePriceCents === right.referencePriceCents
    && left.priceCents === right.priceCents
    && left.availableQty === right.availableQty
    && left.quantity === right.quantity;
}

function sameOffers(left: readonly TargetedOffer[], right: readonly TargetedOffer[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((offer, index) => {
    const other = right[index];
    return other
      && offer.id === other.id
      && offer.status === other.status
      && offer.priceCents === other.priceCents
      && offer.quantity === other.quantity;
  });
}

/**
 * In-memory implementation of the P-016 action boundary.
 *
 * The store boundary is deliberately small so a later Postgres adapter can
 * replace it without changing the policy, audit, or rollback contracts. Every
 * successful mutation records an immutable before/after snapshot; rollback is
 * itself a new audited mutation and uses optimistic state matching so it cannot
 * silently erase a newer seller action.
 */
@Injectable()
export class GuardedActionService implements ActionExecutor {
  private readonly guard = new PolicyActionGuard();
  private readonly items = new Map<string, ActionEventItem>();
  private readonly policies = new Map<string, CopilotPolicy>();
  private readonly offers = new Map<string, TargetedOffer>();
  private readonly audits = new Map<string, ActionAuditRecord>();
  private readonly auditOrder: string[] = [];
  private readonly idempotentExecutions = new Map<string, Promise<ActionExecutionResult>>();

  /**
   * WI-38673: when the config-backed resolver is wired (the production DI
   * graph), the Config tab's guardrail toggles / a published seller policy are
   * AUTHORITATIVE at the moment of enforcement — the policy a register caller
   * supplied is only the fallback for resolver-less instances (rehearsals,
   * unit tests), so an HTTP caller cannot bring its own policy to the guard.
   */
  constructor(
    @Optional() @Inject(EVENT_POLICY_RESOLVER) private readonly policyResolver: EventPolicyResolver | null = null,
    @Optional() @Inject(SyncInvalidationService) private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  registerEvent(eventIdInput: string, input: RegisterActionEventInput): ActionEventItem[] {
    const eventId = assertText(eventIdInput, 'eventId');
    if (!input || !Array.isArray(input.items)) throw new BadRequestException('items are required');
    this.policies.set(eventId, { ...input.policy, priceFloorCentsByProduct: { ...input.policy.priceFloorCentsByProduct }, blockedActionKinds: [...input.policy.blockedActionKinds] });
    for (const item of input.items) {
      const normalized = this.normalizeItem(eventId, item);
      this.items.set(itemKey(eventId, normalized.productId), normalized);
    }
    const items = this.listItems(eventId);
    this.invalidateEventItems(eventId);
    return items;
  }

  listItems(eventIdInput: string): ActionEventItem[] {
    const eventId = assertText(eventIdInput, 'eventId');
    return [...this.items.values()]
      .filter((item) => item.eventId === eventId)
      .map(cloneItem);
  }

  getAudit(auditIdInput: string): ActionAuditRecord {
    const auditId = assertText(auditIdInput, 'auditId');
    const audit = this.audits.get(auditId);
    if (!audit) throw new NotFoundException(`Audit ${auditId} was not found`);
    return cloneAudit(audit);
  }

  /** Lookup seam for owner-checking an audit id before exposing its resource. */
  findAudit(auditIdInput: string): ActionAuditRecord | undefined {
    const auditId = auditIdInput?.trim();
    if (!auditId) return undefined;
    const audit = this.audits.get(auditId);
    return audit ? cloneAudit(audit) : undefined;
  }

  listAudit(eventIdInput: string): ActionAuditRecord[] {
    const eventId = assertText(eventIdInput, 'eventId');
    return this.auditOrder
      .map((id) => this.audits.get(id))
      .filter((audit): audit is ActionAuditRecord => Boolean(audit && audit.eventId === eventId))
      .map(cloneAudit);
  }

  listOffersForBuyer(buyerIdInput: string): TargetedOffer[] {
    const buyerId = assertText(buyerIdInput, 'buyerId');
    return [...this.offers.values()]
      .filter((offer) => offer.buyerId === buyerId)
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
      .map(cloneOffer);
  }

  /** ActionExecutor seam used by GroundedCopilotPipeline auto mode. */
  async execute(action: CopilotActionProposal, metadata: { eventId: string; buyerId?: string }): Promise<ActionExecutionResult> {
    const result = await this.apply({
      eventId: metadata.eventId,
      actorId: 'copilot',
      action: { ...action, buyerId: action.buyerId ?? metadata.buyerId },
    });
    return result;
  }

  /**
   * The policy the guard enforces (WI-38673). With a resolver present it is
   * resolved from the saved event config / published seller policy at the
   * moment of enforcement, with per-product floors derived from the event's
   * verified item prices; the registered policy is only the resolver-less
   * fallback.
   */
  private async resolveEnforcementPolicy(eventId: string, registered: CopilotPolicy): Promise<CopilotPolicy> {
    if (!this.policyResolver) return registered;
    const items = this.listItems(eventId).map((item) => ({
      productId: item.productId,
      priceCents: item.referencePriceCents ?? item.priceCents,
    }));
    return this.policyResolver.resolve(eventId, items);
  }

  async apply(input: ApplyActionInput): Promise<ActionExecutionResult> {
    const requestId = input?.clientRequestId?.trim();
    if (!requestId) return this.applyOnce(input);

    const eventId = assertText(input?.eventId, 'eventId');
    const key = `${eventId}\u0000${requestId}`;
    const existing = this.idempotentExecutions.get(key);
    if (existing) return structuredClone(await existing);

    const pending = this.applyOnce({ ...input, eventId, clientRequestId: requestId });
    this.idempotentExecutions.set(key, pending);
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (this.idempotentExecutions.get(key) === pending) this.idempotentExecutions.delete(key);
      throw error;
    }
  }

  private async applyOnce(input: ApplyActionInput): Promise<ActionExecutionResult> {
    const eventId = assertText(input?.eventId, 'eventId');
    const actorId = assertText(input?.actorId, 'actorId');
    const action = this.normalizeAction(input?.action);
    const current = this.items.get(itemKey(eventId, action.productId));
    if (!current) throw new NotFoundException(`Event item ${action.productId} was not found`);
    const registered = this.policies.get(eventId);
    if (!registered) throw new NotFoundException(`Event ${eventId} was not registered`);
    const policy = await this.resolveEnforcementPolicy(eventId, registered);

    const context = this.guardContext(eventId, policy, current);
    // P-014's shared guard treats quantity as a targeted-offer-only field. A
    // price-adjust quantity is still supported by P-016, but its stock bounds
    // are checked below after the shared price/policy decision.
    const guardAction = action.kind === 'price-adjust' && action.quantity !== undefined
      ? { ...action, quantity: undefined }
      : action;
    const guardrail = await this.guard.evaluate(guardAction, context);
    if (!guardrail.allowed) {
      throw new BadRequestException({ code: guardrail.code, message: guardrail.explanation });
    }

    const before = this.snapshot(eventId, current);
    const afterItem = cloneItem(current);
    let offer: TargetedOffer | undefined;
    if (action.kind === 'targeted-offer') {
      const quantity = assertPositiveInteger(action.quantity ?? 0, 'quantity');
      if (quantity > current.availableQty) throw new ConflictException(`Only ${current.availableQty} units remain available`);
      afterItem.availableQty -= quantity;
      offer = {
        id: randomUUID(),
        eventId,
        eventItemId: current.eventItemId,
        productId: current.productId,
        buyerId: assertText(action.buyerId, 'buyerId'),
        priceCents: action.priceCents ?? 0,
        quantity,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      this.offers.set(offer.id, offer);
    } else if (action.kind === 'markdown' || action.kind === 'price-adjust') {
      afterItem.priceCents = assertPositiveInteger(action.priceCents ?? 0, 'priceCents');
      if (action.kind === 'price-adjust' && action.quantity !== undefined) {
        const quantity = assertPositiveInteger(action.quantity, 'quantity');
        if (quantity > current.availableQty) throw new ConflictException(`Quantity cannot exceed ${current.availableQty} available units`);
        afterItem.quantity = quantity;
      }
    } else if (action.kind === 'push') {
      // One item on stage per event: pushing clears any previous stage flag.
      for (const [key, item] of this.items) {
        if (item.eventId === eventId && item.onStage && item.productId !== current.productId) {
          this.items.set(key, { ...cloneItem(item), onStage: false });
        }
      }
      afterItem.onStage = true;
    } else if (action.kind === 'swap') {
      const targetKey = itemKey(eventId, action.swapToProductId ?? '');
      const target = this.items.get(targetKey);
      if (!target) throw new NotFoundException(`Swap target ${action.swapToProductId} is not a verified event item`);
      afterItem.onStage = false;
      this.items.set(targetKey, { ...cloneItem(target), onStage: true });
    } else if (action.kind === 'stock-adjust') {
      const quantity = assertNonNegativeInteger(action.quantity ?? 0, 'quantity');
      if (quantity > current.availableQty) throw new ConflictException(`Quantity cannot exceed ${current.availableQty} available units`);
      afterItem.quantity = quantity;
    }

    this.items.set(itemKey(eventId, current.productId), afterItem);
    const after = this.snapshot(eventId, afterItem);
    const audit = this.recordAudit({ eventId, actorId, action, before, after, offer });
    this.invalidateEventItems(eventId);
    this.invalidatePricingHistory(eventId, action.productId);
    if (offer) this.invalidateBuyerOrders(offer.buyerId);
    return { auditId: audit.id, status: 'executed', state: cloneItem(afterItem), offer: offer && cloneOffer(offer) };
  }

  async rollback(auditIdInput: string, actorIdInput: string, reasonInput = 'Seller rollback'): Promise<RollbackResult> {
    const auditId = assertText(auditIdInput, 'auditId');
    const actorId = assertText(actorIdInput, 'actorId');
    const reason = assertText(reasonInput, 'reason');
    const original = this.audits.get(auditId);
    if (!original) throw new NotFoundException(`Audit ${auditId} was not found`);
    if (original.rolledBackAt) throw new ConflictException(`Audit ${auditId} was already rolled back`);

    const current = this.items.get(itemKey(original.eventId, original.productId));
    if (!current || !sameItem(current, original.after.item)) {
      throw new ConflictException(`Audit ${auditId} is stale; a newer item write must be reconciled first`);
    }
    const currentSnapshot = this.snapshot(original.eventId, current);
    if (!sameOffers(currentSnapshot.offers, original.after.offers)) {
      throw new ConflictException(`Audit ${auditId} is stale; a newer offer write must be reconciled first`);
    }

    const before = currentSnapshot;
    const restored = cloneItem(original.before.item);
    this.items.set(itemKey(original.eventId, restored.productId), restored);
    for (const offer of original.after.offers) {
      if (!original.before.offers.some((previous) => previous.id === offer.id)) this.offers.delete(offer.id);
    }
    const after = this.snapshot(original.eventId, restored);
    const rollbackAudit = this.recordAudit({
      eventId: original.eventId,
      actorId,
      action: {
        kind: original.kind === 'rollback' ? 'price-adjust' : original.kind,
        productId: original.productId,
        priceCents: restored.priceCents,
        buyerId: original.buyerId,
        reason,
      },
      before,
      after,
      rollbackOf: original.id,
      auditKind: 'rollback',
    });
    original.rolledBackAt = rollbackAudit.createdAt;
    this.invalidateEventItems(original.eventId);
    this.invalidatePricingHistory(original.eventId, original.productId);
    if (original.buyerId) this.invalidateBuyerOrders(original.buyerId);
    return {
      auditId: rollbackAudit.id,
      rolledBackAuditId: original.id,
      status: 'executed',
      state: cloneItem(restored),
    };
  }

  private invalidateBuyerOrders(buyerId: string): void {
    this.syncInvalidations?.invalidate('orders.byBuyer', { buyerId });
  }

  private invalidateEventItems(eventId: string): void {
    this.syncInvalidations?.invalidate('event.actions.items', { eventId });
  }

  private invalidatePricingHistory(eventId: string, productId: string): void {
    this.syncInvalidations?.invalidate('event.pricingHistory', { eventId, productId });
  }

  private normalizeItem(eventId: string, item: ActionEventItem): ActionEventItem {
    if (!item || item.eventId !== eventId) throw new BadRequestException('Each item must belong to the registered event');
    const eventItemId = assertText(item.eventItemId, 'eventItemId');
    const productId = assertText(item.productId, 'productId');
    const title = assertText(item.title, 'title');
    const priceCents = assertPositiveInteger(item.priceCents, 'priceCents');
    const previous = this.items.get(itemKey(eventId, productId));
    const referencePriceCents = assertPositiveInteger(
      previous?.referencePriceCents ?? item.referencePriceCents ?? priceCents,
      'referencePriceCents',
    );
    const availableQty = assertNonNegativeInteger(item.availableQty, 'availableQty');
    const quantity = assertPositiveInteger(item.quantity, 'quantity');
    if (quantity > availableQty && availableQty > 0) throw new BadRequestException('quantity cannot exceed availableQty');
    return { ...item, eventId, eventItemId, productId, title, referencePriceCents, priceCents, availableQty, quantity, onStage: item.onStage ?? false, attributes: { ...item.attributes } };
  }

  private normalizeAction(action: GuardedActionProposal): GuardedActionProposal {
    if (!action || !['markdown', 'price-adjust', 'targeted-offer', 'push', 'swap', 'stock-adjust'].includes(action.kind)) {
      throw new BadRequestException('A supported action kind is required');
    }
    return {
      ...action,
      productId: assertText(action.productId, 'productId'),
      ...(action.swapToProductId !== undefined ? { swapToProductId: assertText(action.swapToProductId, 'swapToProductId') } : {}),
      reason: assertText(action.reason, 'reason'),
    };
  }

  private guardContext(eventId: string, policy: CopilotPolicy, item: ActionEventItem): ActionGuardContext {
    return {
      eventItems: [cloneItem(item)],
      catalogProducts: [],
      policy,
      sources: [
        { id: `event-item:${item.eventItemId}`, kind: 'event-item', label: `${item.title} event item` },
        { id: `policy:${eventId}`, kind: 'policy', label: `${eventId} event policy` },
      ],
    };
  }

  private snapshot(eventId: string, item: ActionEventItem): ActionStateSnapshot {
    return {
      item: cloneItem(item),
      offers: [...this.offers.values()]
        .filter((offer) => offer.eventId === eventId && offer.productId === item.productId)
        .map(cloneOffer),
    };
  }

  private recordAudit(input: {
    eventId: string;
    actorId: string;
    action: GuardedActionProposal;
    before: ActionStateSnapshot;
    after: ActionStateSnapshot;
    offer?: TargetedOffer;
    rollbackOf?: string;
    auditKind?: ActionAuditRecord['kind'];
  }): ActionAuditRecord {
    const audit: ActionAuditRecord = {
      id: randomUUID(),
      eventId: input.eventId,
      actorId: input.actorId,
      kind: input.auditKind ?? input.action.kind,
      productId: input.action.productId,
      buyerId: input.action.buyerId,
      reason: input.action.reason,
      before: cloneSnapshot(input.before),
      after: cloneSnapshot(input.after),
      createdAt: new Date().toISOString(),
      rollbackOf: input.rollbackOf,
    };
    this.audits.set(audit.id, audit);
    this.auditOrder.push(audit.id);
    return audit;
  }
}

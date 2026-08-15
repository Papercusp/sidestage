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
import { ORDER_STORE, type CheckoutOrder, type OrderStore } from '../checkout/order-store';
import {
  ACTION_ITEM_STORE,
  InMemoryActionItemStore,
  type ActionItemChange,
  type ActionItemDraft,
  type ActionItemStore,
  type StoredActionEventItem,
} from './action-item.store';
import {
  ACTION_AUDIT_STORE,
  InMemoryActionAuditStore,
  type ActionAuditStore,
} from './action-audit.store';
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
    && left.quantity === right.quantity
    && left.position === right.position
    && left.stageState === right.stageState
    && left.version === right.version;
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
  private readonly policies = new Map<string, CopilotPolicy>();
  private readonly offers = new Map<string, TargetedOffer>();
  private readonly idempotentExecutions = new Map<string, Promise<ActionExecutionResult>>();
  private readonly itemStore: ActionItemStore;
  private readonly auditStore: ActionAuditStore;

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
    @Optional() @Inject(ORDER_STORE) private readonly orders?: OrderStore,
    @Optional() @Inject(ACTION_ITEM_STORE) itemStore?: ActionItemStore,
    @Optional() @Inject(ACTION_AUDIT_STORE) auditStore?: ActionAuditStore,
  ) {
    this.itemStore = itemStore ?? new InMemoryActionItemStore();
    this.auditStore = auditStore ?? new InMemoryActionAuditStore();
  }

  async registerEvent(eventIdInput: string, input: RegisterActionEventInput): Promise<ActionEventItem[]> {
    const eventId = assertText(eventIdInput, 'eventId');
    if (!input || !Array.isArray(input.items)) throw new BadRequestException('items are required');
    const current = await this.itemStore.list(eventId);
    const byProduct = new Map(current.map((item) => [item.productId, item]));
    const nextPosition = current.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1;
    const normalized = input.items.map((item, index) => this.normalizeItem(
      eventId,
      item,
      byProduct.get(item.productId),
      byProduct.get(item.productId)?.position ?? nextPosition + index,
    ));
    const items = await this.itemStore.register(eventId, normalized);
    this.policies.set(eventId, { ...input.policy, priceFloorCentsByProduct: { ...input.policy.priceFloorCentsByProduct }, blockedActionKinds: [...input.policy.blockedActionKinds] });
    this.invalidateEventItems(eventId);
    return items;
  }

  async listItems(eventIdInput: string): Promise<StoredActionEventItem[]> {
    const eventId = assertText(eventIdInput, 'eventId');
    return this.itemStore.list(eventId);
  }

  async getAudit(auditIdInput: string): Promise<ActionAuditRecord> {
    const auditId = assertText(auditIdInput, 'auditId');
    const audit = await this.auditStore.get(auditId);
    if (!audit) throw new NotFoundException(`Audit ${auditId} was not found`);
    return audit;
  }

  /** Lookup seam for owner-checking an audit id before exposing its resource. */
  async findAudit(auditIdInput: string): Promise<ActionAuditRecord | undefined> {
    const auditId = auditIdInput?.trim();
    if (!auditId) return undefined;
    return this.auditStore.get(auditId);
  }

  async listAudit(eventIdInput: string): Promise<ActionAuditRecord[]> {
    const eventId = assertText(eventIdInput, 'eventId');
    return this.auditStore.list(eventId);
  }

  listOffersForBuyer(buyerIdInput: string): TargetedOffer[] {
    const buyerId = assertText(buyerIdInput, 'buyerId');
    return [...this.offers.values()]
      .filter((offer) => offer.buyerId === buyerId)
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
      .map(cloneOffer);
  }

  findOffer(offerIdInput: string): TargetedOffer | undefined {
    const offerId = offerIdInput?.trim();
    if (!offerId) return undefined;
    const offer = this.offers.get(offerId);
    return offer ? cloneOffer(offer) : undefined;
  }

  async acceptOffer(offerIdInput: string, buyerIdInput: string): Promise<TargetedOffer> {
    const offer = this.requireBuyerOffer(offerIdInput, buyerIdInput);
    if (offer.status !== 'pending' && offer.status !== 'accepted') {
      throw new ConflictException(`Offer cannot be accepted from ${offer.status}`);
    }
    const changed = offer.status === 'pending';
    if (changed) offer.status = 'accepted';
    await this.ensureOfferOrder(offer);
    if (changed) this.invalidateBuyerOrders(offer.buyerId);
    return cloneOffer(offer);
  }

  /** Payment success finalizes the already-accepted source reservation. */
  async commitOffer(offerIdInput: string, buyerIdInput: string): Promise<TargetedOffer> {
    return this.acceptOffer(offerIdInput, buyerIdInput);
  }

  async cancelOffer(offerIdInput: string, buyerIdInput: string): Promise<TargetedOffer> {
    const offer = this.requireBuyerOffer(offerIdInput, buyerIdInput);
    if (offer.status === 'cancelled') return cloneOffer(offer);
    if (offer.status !== 'pending' && offer.status !== 'accepted') {
      throw new ConflictException(`Offer cannot be cancelled from ${offer.status}`);
    }
    const item = (await this.itemStore.list(offer.eventId)).find((candidate) => candidate.productId === offer.productId);
    if (!item) throw new NotFoundException('Offer was not found');
    await this.itemStore.write(offer.eventId, [{
      expectedVersion: item.version,
      item: { ...item, availableQty: item.availableQty + offer.quantity },
    }]);
    offer.status = 'cancelled';
    this.invalidateEventItems(offer.eventId);
    this.invalidateBuyerOrders(offer.buyerId);
    return cloneOffer(offer);
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
  private async resolveEnforcementPolicy(
    eventId: string,
    registered: CopilotPolicy | undefined,
    actionItems: readonly ActionEventItem[],
  ): Promise<CopilotPolicy> {
    if (!this.policyResolver) {
      if (!registered) throw new NotFoundException(`Event ${eventId} was not registered`);
      return registered;
    }
    const items = actionItems.map((item) => ({
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

    const pending = (async () => {
      const prior = await this.auditStore.findByRequest(eventId, requestId);
      return prior
        ? this.resultFromAudit(prior)
        : this.applyOnce({ ...input, eventId, clientRequestId: requestId });
    })();
    this.idempotentExecutions.set(key, pending);
    try {
      return structuredClone(await pending);
    } finally {
      if (this.idempotentExecutions.get(key) === pending) this.idempotentExecutions.delete(key);
    }
  }

  private async applyOnce(input: ApplyActionInput): Promise<ActionExecutionResult> {
    const eventId = assertText(input?.eventId, 'eventId');
    const actorId = assertText(input?.actorId, 'actorId');
    const action = this.normalizeAction(input?.action);
    const items = await this.itemStore.list(eventId);
    const current = items.find((item) => item.productId === action.productId);
    if (!current) throw new NotFoundException(`Event item ${action.productId} was not found`);
    const registered = this.policies.get(eventId);
    const policy = await this.resolveEnforcementPolicy(eventId, registered, items);

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
    let afterItem: ActionItemDraft = { ...current, attributes: { ...current.attributes } };
    const extraChanges: ActionItemChange[] = [];
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
    } else if (action.kind === 'markdown' || action.kind === 'price-adjust') {
      afterItem.priceCents = assertPositiveInteger(action.priceCents ?? 0, 'priceCents');
      if (action.kind === 'price-adjust' && action.quantity !== undefined) {
        const quantity = assertPositiveInteger(action.quantity, 'quantity');
        if (quantity > current.availableQty) throw new ConflictException(`Quantity cannot exceed ${current.availableQty} available units`);
        afterItem.quantity = quantity;
      }
    } else if (action.kind === 'push') {
      // One item on stage per event: pushing clears any previous stage flag.
      for (const item of items) {
        if (item.stageState === 'on-stage' && item.productId !== current.productId) {
          extraChanges.push({
            expectedVersion: item.version,
            item: { ...item, stageState: 'queued', onStage: false },
          });
        }
      }
      afterItem.stageState = 'on-stage';
      afterItem.onStage = true;
    } else if (action.kind === 'swap') {
      const target = items.find((item) => item.productId === action.swapToProductId);
      if (!target) throw new NotFoundException(`Swap target ${action.swapToProductId} is not a verified event item`);
      afterItem.stageState = 'queued';
      afterItem.onStage = false;
      extraChanges.push({
        expectedVersion: target.version,
        item: { ...target, stageState: 'on-stage', onStage: true },
      });
    } else if (action.kind === 'stock-adjust') {
      const quantity = assertNonNegativeInteger(action.quantity ?? 0, 'quantity');
      if (quantity > current.availableQty) throw new ConflictException(`Quantity cannot exceed ${current.availableQty} available units`);
      afterItem.quantity = quantity;
    }

    const persisted = await this.itemStore.write(eventId, [
      { expectedVersion: current.version, item: afterItem },
      ...extraChanges,
    ]);
    afterItem = persisted.find((item) => item.productId === current.productId) ?? afterItem;
    if (offer) this.offers.set(offer.id, offer);
    const after = this.snapshot(eventId, afterItem);
    const audit = await this.recordAudit({
      eventId,
      actorId,
      action,
      before,
      after,
      offer,
      clientRequestId: input.clientRequestId,
    });
    this.invalidateEventItems(eventId);
    this.invalidatePricingHistory(eventId, action.productId);
    if (offer) this.invalidateBuyerOrders(offer.buyerId);
    return this.resultFromAudit(audit);
  }

  async rollback(auditIdInput: string, actorIdInput: string, reasonInput = 'Seller rollback'): Promise<RollbackResult> {
    const auditId = assertText(auditIdInput, 'auditId');
    const actorId = assertText(actorIdInput, 'actorId');
    const reason = assertText(reasonInput, 'reason');
    const original = await this.auditStore.get(auditId);
    if (!original) throw new NotFoundException(`Audit ${auditId} was not found`);
    if (original.rolledBackAt) throw new ConflictException(`Audit ${auditId} was already rolled back`);

    const current = (await this.itemStore.list(original.eventId))
      .find((item) => item.productId === original.productId);
    if (!current || !sameItem(current, original.after.item)) {
      throw new ConflictException(`Audit ${auditId} is stale; a newer item write must be reconciled first`);
    }
    const currentSnapshot = this.snapshot(original.eventId, current);
    if (!sameOffers(currentSnapshot.offers, original.after.offers)) {
      throw new ConflictException(`Audit ${auditId} is stale; a newer offer write must be reconciled first`);
    }

    const before = currentSnapshot;
    const restored = this.asDraft(original.before.item, current);
    const persisted = await this.itemStore.write(original.eventId, [{
      expectedVersion: current.version,
      item: restored,
    }]);
    for (const offer of original.after.offers) {
      if (!original.before.offers.some((previous) => previous.id === offer.id)) this.offers.delete(offer.id);
    }
    const restoredItem = persisted.find((item) => item.productId === restored.productId) ?? restored;
    const after = this.snapshot(original.eventId, restoredItem);
    const rollbackAudit = this.buildAudit({
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
    const recordedRollback = await this.auditStore.recordRollback(original.id, rollbackAudit);
    this.invalidateEventItems(original.eventId);
    this.invalidatePricingHistory(original.eventId, original.productId);
    if (original.buyerId) this.invalidateBuyerOrders(original.buyerId);
    return {
      auditId: recordedRollback.id,
      rolledBackAuditId: original.id,
      status: 'executed',
      state: cloneItem(restoredItem),
    };
  }

  private invalidateBuyerOrders(buyerId: string): void {
    this.syncInvalidations?.invalidate('orders.byBuyer', { buyerId });
  }

  private requireBuyerOffer(offerIdInput: string, buyerIdInput: string): TargetedOffer {
    const offerId = assertText(offerIdInput, 'offerId');
    const buyerId = assertText(buyerIdInput, 'buyerId');
    const offer = this.offers.get(offerId);
    if (!offer || offer.buyerId !== buyerId) throw new NotFoundException('Offer was not found');
    return offer;
  }

  private async ensureOfferOrder(offer: TargetedOffer): Promise<void> {
    if (!this.orders) return;
    const existing = await this.orders.findBySource('offer', offer.id);
    if (existing) {
      if (existing.id !== offer.id || existing.buyerId !== offer.buyerId) {
        throw new ConflictException('Offer is already associated with another canonical order');
      }
      return;
    }
    const item = (await this.itemStore.list(offer.eventId))
      .find((candidate) => candidate.productId === offer.productId);
    if (!item) throw new NotFoundException('Offer was not found');
    const totalCents = offer.priceCents * offer.quantity;
    const order: CheckoutOrder = {
      id: offer.id,
      buyerId: offer.buyerId,
      sourceKind: 'offer',
      sourceId: offer.id,
      eventId: offer.eventId,
      subtotalCents: totalCents,
      shippingCents: 0,
      totalCents,
      currency: 'USD',
      status: 'pending',
      paymentState: 'payment_required',
      createdAt: offer.createdAt ?? new Date().toISOString(),
      items: [{
        productId: offer.productId,
        title: item.title,
        priceCents: offer.priceCents,
        quantity: offer.quantity,
      }],
      sourceSnapshot: { ...offer },
    };
    await this.orders.set(order);
  }

  private invalidateEventItems(eventId: string): void {
    this.syncInvalidations?.invalidate('event.actions.items', { eventId });
    this.syncInvalidations?.invalidate('event.lineup.items', { eventId });
  }

  private invalidatePricingHistory(eventId: string, productId: string): void {
    this.syncInvalidations?.invalidate('event.pricingHistory', { eventId, productId });
  }

  private normalizeItem(
    eventId: string,
    item: ActionEventItem,
    previous: StoredActionEventItem | undefined,
    positionInput: number,
  ): ActionItemDraft {
    if (!item || item.eventId !== eventId) throw new BadRequestException('Each item must belong to the registered event');
    const eventItemId = assertText(item.eventItemId, 'eventItemId');
    const productId = assertText(item.productId, 'productId');
    const title = assertText(item.title, 'title');
    const priceCents = assertPositiveInteger(item.priceCents, 'priceCents');
    const referencePriceCents = assertPositiveInteger(
      previous?.referencePriceCents ?? item.referencePriceCents ?? priceCents,
      'referencePriceCents',
    );
    const availableQty = assertNonNegativeInteger(item.availableQty, 'availableQty');
    const quantity = assertPositiveInteger(item.quantity, 'quantity');
    if (quantity > availableQty && availableQty > 0) throw new BadRequestException('quantity cannot exceed availableQty');
    const position = assertNonNegativeInteger(item.position ?? positionInput, 'position');
    const stageState = item.stageState
      ?? (item.onStage === true ? 'on-stage' : item.onStage === false ? 'queued' : previous?.stageState ?? 'queued');
    if (!['queued', 'on-stage', 'completed'].includes(stageState)) {
      throw new BadRequestException('stageState must be queued, on-stage, or completed');
    }
    return {
      ...item,
      eventId,
      eventItemId: previous?.eventItemId ?? eventItemId,
      productId,
      title,
      referencePriceCents,
      priceCents,
      availableQty,
      quantity,
      position,
      stageState,
      onStage: stageState === 'on-stage',
      attributes: { ...item.attributes },
    };
  }

  private asDraft(item: ActionEventItem, current: StoredActionEventItem): ActionItemDraft {
    return {
      ...item,
      eventId: current.eventId,
      eventItemId: current.eventItemId,
      productId: current.productId,
      referencePriceCents: item.referencePriceCents ?? current.referencePriceCents,
      position: item.position ?? current.position,
      stageState: item.stageState ?? (item.onStage ? 'on-stage' : 'queued'),
      onStage: item.stageState === 'on-stage' || item.onStage === true,
      attributes: { ...item.attributes },
    };
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

  private buildAudit(input: {
    eventId: string;
    actorId: string;
    action: GuardedActionProposal;
    before: ActionStateSnapshot;
    after: ActionStateSnapshot;
    offer?: TargetedOffer;
    clientRequestId?: string;
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
      clientRequestId: input.clientRequestId,
      rollbackOf: input.rollbackOf,
    };
    return audit;
  }

  private recordAudit(input: Parameters<GuardedActionService['buildAudit']>[0]): Promise<ActionAuditRecord> {
    return this.auditStore.record(this.buildAudit(input));
  }

  private resultFromAudit(audit: ActionAuditRecord): ActionExecutionResult {
    const priorOfferIds = new Set(audit.before.offers.map((offer) => offer.id));
    const offer = audit.after.offers.find((candidate) => !priorOfferIds.has(candidate.id));
    return {
      auditId: audit.id,
      status: 'executed',
      state: cloneItem(audit.after.item),
      ...(offer ? { offer: cloneOffer(offer) } : {}),
    };
  }
}

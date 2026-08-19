import { GuardedActionService } from '../actions/action.service';
import type { ActionEventItem } from '../actions/action.types';
import type { CopilotPolicy } from '../copilot/copilot.types';
import {
  buildRehearsalReport,
  centsToDollars,
  expectRefusal,
  expectSuccess,
  runCase,
} from './rehearsal.report';
import type { RehearsalCaseResult, RehearsalReport } from './rehearsal.types';

/**
 * The guarded-action rehearsal — the seller-facing proof of the depth area.
 *
 * The reply judge grades what the copilot SAYS. This grades what it is allowed
 * to DO: every case drives the real GuardedActionService (and therefore the
 * real PolicyActionGuard) and checks that the writes which must be refused are
 * refused, the one that is allowed is audited, and that an applied write can be
 * taken back.
 *
 * Isolation: each case constructs its OWN service instance and registers its
 * own scripted event. Nothing here can read or write a live event, so the
 * rehearsal is safe to run mid-event — which is exactly when a host wants it.
 * It is still the real class and the real guard, not a fake.
 */

const REHEARSAL_PRODUCT = 'aurora-cup';
const LIST_PRICE_CENTS = 2_800;
const FLOOR_CENTS = 2_000;
const MAX_MARKDOWN_PERCENT = 20;

export const ACTION_REHEARSAL_POLICY: CopilotPolicy = {
  automationLevel: 'auto',
  allowAutoActions: true,
  priceFloorCentsByProduct: { [REHEARSAL_PRODUCT]: FLOOR_CENTS },
  maxMarkdownPercent: MAX_MARKDOWN_PERCENT,
  // The host has switched stock edits off for this event; the copilot must respect that.
  blockedActionKinds: ['stock-adjust'],
  tone: 'warm',
};

let eventSequence = 0;

interface ScriptedEvent {
  actions: GuardedActionService;
  eventId: string;
  item: ActionEventItem;
}

/** A fresh real service + a scripted event, so cases cannot contaminate each other. */
async function scriptedEvent(): Promise<ScriptedEvent> {
  const actions = new GuardedActionService();
  const eventId = `rehearsal-actions-${++eventSequence}`;
  const item: ActionEventItem = {
    eventId,
    eventItemId: `${eventId}:${REHEARSAL_PRODUCT}`,
    productId: REHEARSAL_PRODUCT,
    title: 'Aurora ceramic cup',
    currentPriceCents: LIST_PRICE_CENTS,
    currentQuantity: 12,
    listedQuantity: 12,
    attributes: { material: 'stoneware', finish: 'blue frost' },
  };
  await actions.registerEvent(eventId, { policy: ACTION_REHEARSAL_POLICY, items: [item] });
  return { actions, eventId, item };
}

async function priceOf(actions: GuardedActionService, eventId: string): Promise<number> {
  const [item] = await actions.listItems(eventId);
  return item?.currentPriceCents ?? -1;
}

export async function runActionRehearsal(options: { now?: () => number } = {}): Promise<RehearsalReport> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const cases: RehearsalCaseResult[] = [];

  // ---- The write that SHOULD go through -------------------------------------
  cases.push(await expectSuccess(
    {
      caseId: 'markdown-within-cap',
      title: 'A markdown inside the limit is applied',
      expectation: `Marking the cup down to ${centsToDollars(2_400)} is inside the ${MAX_MARKDOWN_PERCENT}% limit and above the ${centsToDollars(FLOOR_CENTS)} floor, so it should go through.`,
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      const result = await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_400, reason: 'Rehearsal markdown' },
      });
      return { result, priceAfter: await priceOf(actions, eventId) };
    },
    ({ result, priceAfter }) => ({
      passed: result.status === 'executed' && priceAfter === 2_400,
      observed: priceAfter === 2_400
        ? `Applied. The cup is now ${centsToDollars(priceAfter)}.`
        : `The write reported success but the price is ${centsToDollars(priceAfter)}.`,
      evidence: { newPrice: centsToDollars(priceAfter), auditId: result.auditId },
    }),
  ));

  // ---- The writes that MUST be refused --------------------------------------
  cases.push(await expectRefusal(
    {
      caseId: 'markdown-beyond-cap',
      title: 'A markdown past the limit is refused',
      expectation: `${centsToDollars(2_000)} is a 28.6% cut, past this event's ${MAX_MARKDOWN_PERCENT}% limit, so it must be refused.`,
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_000, reason: 'Buyer asked for a deal' },
      });
    },
    { code: 'markdown-limit' },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'price-below-floor',
      title: 'A price under the floor is refused',
      expectation: `${centsToDollars(1_500)} is below the ${centsToDollars(FLOOR_CENTS)} floor configured for this product, so it must be refused.`,
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'price-adjust', productId: REHEARSAL_PRODUCT, priceCents: 1_500, reason: 'Buyer pushed hard' },
      });
    },
    { code: 'price-floor' },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'blocked-action-kind',
      title: 'An action kind you switched off is refused',
      expectation: 'Stock edits are switched off in this event policy, so a stock adjustment must be refused even when it is otherwise valid.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'stock-adjust', productId: REHEARSAL_PRODUCT, quantity: 4, reason: 'Recount' },
      });
    },
    { code: 'policy' },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'unverified-product',
      title: 'A write against an unknown product is refused',
      expectation: 'The copilot must not be able to price a product that is not a verified item in this event.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'markdown', productId: 'not-a-real-sku', priceCents: 500, reason: 'Invented product' },
      });
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'price-on-non-price-action',
      title: 'A staging action cannot smuggle in a price change',
      expectation: 'Putting an item on stage moves no money, so a push carrying a price must be refused rather than quietly applied.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'push', productId: REHEARSAL_PRODUCT, priceCents: 2_000, reason: 'Stage it cheaper' },
      });
    },
    { code: 'invalid-action' },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'offer-beyond-stock',
      title: 'An offer for more units than exist is refused',
      expectation: 'Only 12 units are verified for this event, so an offer of 99 must be refused instead of overselling.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: {
          kind: 'targeted-offer',
          productId: REHEARSAL_PRODUCT,
          quantity: 99,
          priceCents: 2_500,
          buyerId: 'buyer-rehearsal',
          reason: 'Bulk request',
        },
      });
    },
    { code: 'availability' },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'offer-without-buyer',
      title: 'An offer with nobody to send it to is refused',
      expectation: 'A targeted offer must name the buyer who receives it, so an unaddressed offer must be refused.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      return actions.apply({
        eventId,
        actorId: 'rehearsal-copilot',
        action: { kind: 'targeted-offer', productId: REHEARSAL_PRODUCT, quantity: 1, priceCents: 2_500, reason: 'Send an offer' },
      });
    },
    { code: 'buyer-target' },
  ));

  // ---- Audit + rollback ------------------------------------------------------
  cases.push(await runCase(
    {
      caseId: 'audit-record-written',
      title: 'Every applied write leaves an audit record',
      expectation: 'An applied markdown must record who did it, why, and the exact before/after state — otherwise it cannot be reviewed or undone.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_400, reason: 'Flash markdown' },
      });
      const audits = await actions.listAudit(eventId);
      const [audit] = audits;
      const correct = audits.length === 1
        && audit.before.item.currentPriceCents === LIST_PRICE_CENTS
        && audit.after.item.currentPriceCents === 2_400
        && audit.actorId === 'rehearsal-seller'
        && audit.reason === 'Flash markdown';
      return {
        passed: correct,
        observed: correct
          ? `One audit record: ${centsToDollars(audit.before.item.currentPriceCents)} → ${centsToDollars(audit.after.item.currentPriceCents)} by ${audit.actorId}.`
          : `Expected one complete audit record, found ${audits.length}.`,
        evidence: {
          records: audits.length,
          ...(audit ? { before: centsToDollars(audit.before.item.currentPriceCents), after: centsToDollars(audit.after.item.currentPriceCents), actor: audit.actorId, reason: audit.reason } : {}),
        },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'rollback-restores-state',
      title: 'A write can be taken back',
      expectation: 'Rolling back an applied markdown must put the price back exactly where it was, and record the rollback itself.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      const applied = await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_400, reason: 'Markdown to undo' },
      });
      const priceAfterApply = await priceOf(actions, eventId);
      await actions.rollback(applied.auditId, 'rehearsal-seller', 'Changed my mind');
      const priceAfterRollback = await priceOf(actions, eventId);
      const rollbackRecorded = (await actions.listAudit(eventId))
        .some((entry) => entry.rollbackOf === applied.auditId);
      const restored = priceAfterRollback === LIST_PRICE_CENTS && rollbackRecorded;
      return {
        passed: restored,
        observed: restored
          ? `Restored: ${centsToDollars(LIST_PRICE_CENTS)} → ${centsToDollars(priceAfterApply)} → back to ${centsToDollars(priceAfterRollback)}, with the rollback recorded.`
          : `The price came back as ${centsToDollars(priceAfterRollback)} (expected ${centsToDollars(LIST_PRICE_CENTS)}); rollback recorded: ${rollbackRecorded}.`,
        evidence: {
          priceAfterApply: centsToDollars(priceAfterApply),
          priceAfterRollback: centsToDollars(priceAfterRollback),
          rollbackRecorded,
        },
      };
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'double-rollback-refused',
      title: 'The same write cannot be taken back twice',
      expectation: 'Rolling back an already-rolled-back write must be refused, so an undo cannot be replayed into a second price change.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      const applied = await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_400, reason: 'Markdown' },
      });
      await actions.rollback(applied.auditId, 'rehearsal-seller', 'First undo');
      return actions.rollback(applied.auditId, 'rehearsal-seller', 'Second undo');
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'stale-rollback-refused',
      title: 'An undo cannot silently erase a newer change',
      expectation: 'After a second price change, undoing the FIRST one must be refused rather than wiping out the newer price behind the seller\'s back.',
    },
    async () => {
      const { actions, eventId } = await scriptedEvent();
      const first = await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_400, reason: 'First markdown' },
      });
      await actions.apply({
        eventId,
        actorId: 'rehearsal-seller',
        action: { kind: 'markdown', productId: REHEARSAL_PRODUCT, priceCents: 2_300, reason: 'Second markdown' },
      });
      return actions.rollback(first.auditId, 'rehearsal-seller', 'Undo the first one');
    },
  ));

  return buildRehearsalReport({
    kind: 'actions',
    title: 'Guarded actions',
    cases,
    startedMs,
    now,
  });
}

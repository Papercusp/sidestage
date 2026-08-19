import { describe, expect, it } from 'vitest';
import { PolicyActionGuard } from '../../../api/src/copilot/guardrail';
import type {
  CopilotActionProposal,
  CopilotPolicy,
  GroundingContext,
} from '../../../api/src/copilot/copilot.types';
import { withDerivedPriceFloors } from '../../../api/src/config/event-config.service';
import { buyerCandidates, evaluateOffer, type BuyerCandidate } from './offer-guard';
import type { MarkdownPolicyView } from './markdown-guard';

/**
 * DIFFERENTIAL, not a restatement — the same shape as markdown-guard.test.ts.
 *
 * It imports the real `PolicyActionGuard` and asserts that for every composed
 * offer, `evaluateOffer`'s `sendable` agrees with whether the server would
 * ALLOW it. A hand-written restatement of guardrail.ts here would agree with
 * the mirror precisely when both were wrong in the same way, which is the whole
 * failure class this is built to catch.
 *
 * Same deliberate asymmetry as the markdown suite: the client is fed the policy
 * as `readEventConfigView` sends it (`priceFloorCentsByProduct` usually EMPTY,
 * because the derivation runs later at the action boundary), while the server
 * is fed the derived policy.
 */

const PRODUCT = 'aurora-cup';
const BUYER = 'buyer-42';
const guard = new PolicyActionGuard();

function serverContext(policy: CopilotPolicy, priceCents: number, availableQty: number): GroundingContext {
  const items = [{
    eventItemId: 'ei-1',
    productId: PRODUCT,
    title: 'Aurora Cup',
    priceCents,
    availableQty,
    attributes: {},
  }];
  return {
    eventItems: items,
    catalogProducts: [],
    policy: withDerivedPriceFloors(policy, items),
    sources: [],
  };
}

function rawPolicy(
  maxMarkdownPercent: number,
  floors: Record<string, number> = {},
  blockedActionKinds: CopilotPolicy['blockedActionKinds'] = [],
): CopilotPolicy {
  return {
    automationLevel: 'confirm',
    allowAutoActions: false,
    priceFloorCentsByProduct: floors,
    maxMarkdownPercent,
    blockedActionKinds,
    tone: 'warm',
  };
}

/** What the browser actually holds: the policy as `event.config` serialises it. */
function clientView(policy: CopilotPolicy): MarkdownPolicyView {
  return {
    maxMarkdownPercent: policy.maxMarkdownPercent,
    priceFloorCentsByProduct: policy.priceFloorCentsByProduct,
  };
}

interface Composed {
  policy: CopilotPolicy;
  currentPriceCents: number;
  availableQty: number;
  buyerId: string;
  quantity: number | null;
  priceCents: number | null;
}

async function serverAllows(composed: Composed): Promise<boolean> {
  const action = {
    kind: 'targeted-offer',
    productId: PRODUCT,
    buyerId: composed.buyerId,
    quantity: composed.quantity ?? undefined,
    priceCents: composed.priceCents ?? undefined,
    reason: 'Seller sent a quantity-aware targeted offer',
  } as CopilotActionProposal;
  const decision = await guard.evaluate(
    action,
    serverContext(composed.policy, composed.currentPriceCents, composed.availableQty),
  );
  return decision.allowed;
}

function clientAllows(composed: Composed, candidates?: readonly BuyerCandidate[]): boolean {
  return evaluateOffer({
    policy: clientView(composed.policy),
    blockedActionKinds: composed.policy.blockedActionKinds,
    productId: PRODUCT,
    currentPriceCents: composed.currentPriceCents,
    availableQty: composed.availableQty,
    buyerId: composed.buyerId,
    quantity: composed.quantity,
    priceCents: composed.priceCents,
    candidates,
  }).sendable;
}

describe('offer-guard mirrors the server targeted-offer gate', () => {
  const cap20 = rawPolicy(20);
  const base = { policy: cap20, currentPriceCents: 4_000, availableQty: 4 };

  const cases: Array<{ name: string; composed: Composed }> = [
    { name: 'a clean offer at the event price', composed: { ...base, buyerId: BUYER, quantity: 1, priceCents: 4_000 } },
    { name: 'an offer exactly at the cap-derived floor', composed: { ...base, buyerId: BUYER, quantity: 1, priceCents: 3_200 } },
    { name: 'an offer one cent under the floor', composed: { ...base, buyerId: BUYER, quantity: 1, priceCents: 3_199 } },
    { name: 'an offer far under the floor', composed: { ...base, buyerId: BUYER, quantity: 2, priceCents: 100 } },
    { name: 'an offer above the verified event price', composed: { ...base, buyerId: BUYER, quantity: 1, priceCents: 4_500 } },
    { name: 'quantity exactly at availability', composed: { ...base, buyerId: BUYER, quantity: 4, priceCents: 3_600 } },
    { name: 'quantity one over availability', composed: { ...base, buyerId: BUYER, quantity: 5, priceCents: 3_600 } },
    { name: 'zero quantity', composed: { ...base, buyerId: BUYER, quantity: 0, priceCents: 3_600 } },
    { name: 'fractional quantity', composed: { ...base, buyerId: BUYER, quantity: 1.5, priceCents: 3_600 } },
    { name: 'an empty buyer id', composed: { ...base, buyerId: '', quantity: 1, priceCents: 3_600 } },
    { name: 'a whitespace-only buyer id', composed: { ...base, buyerId: '   ', quantity: 1, priceCents: 3_600 } },
    { name: 'a zero price', composed: { ...base, buyerId: BUYER, quantity: 1, priceCents: 0 } },
    {
      name: 'an explicit policy floor biting harder than the cap',
      composed: {
        policy: rawPolicy(50, { [PRODUCT]: 3_500 }),
        currentPriceCents: 4_000,
        availableQty: 4,
        buyerId: BUYER,
        quantity: 1,
        priceCents: 3_400,
      },
    },
    {
      name: 'an explicit policy floor exactly met',
      composed: {
        policy: rawPolicy(50, { [PRODUCT]: 3_500 }),
        currentPriceCents: 4_000,
        availableQty: 4,
        buyerId: BUYER,
        quantity: 1,
        priceCents: 3_500,
      },
    },
    {
      name: 'an event that forbids targeted offers',
      composed: {
        policy: rawPolicy(20, {}, ['targeted-offer']),
        currentPriceCents: 4_000,
        availableQty: 4,
        buyerId: BUYER,
        quantity: 1,
        priceCents: 3_600,
      },
    },
    {
      name: 'a one-cent item where the cap floors to the price itself',
      composed: {
        policy: rawPolicy(20),
        currentPriceCents: 1,
        availableQty: 1,
        buyerId: BUYER,
        quantity: 1,
        priceCents: 1,
      },
    },
  ];

  for (const { name, composed } of cases) {
    it(`agrees with the server on ${name}`, async () => {
      expect(clientAllows(composed)).toBe(await serverAllows(composed));
    });
  }

  it('covers both verdicts, so agreement is not vacuous', async () => {
    const verdicts = await Promise.all(cases.map(({ composed }) => serverAllows(composed)));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  /**
   * CALIBRATION CONTROL — a permanently-wrong mirror, kept here on purpose.
   *
   * This is exactly what the offer row enforced BEFORE this change: a non-empty
   * buyer string, a parseable quantity, a parseable price, and nothing else. If
   * the case matrix above ever stops being able to tell this apart from the real
   * mirror, the differential test has gone vacuous and would keep passing while
   * `evaluateOffer` rotted. Proving the suite CAN fail is the point; mutating
   * the shared tree to prove it is not an option here (the sweep commits it).
   */
  function naiveAllows(composed: Composed): boolean {
    return composed.buyerId.trim() !== ''
      && typeof composed.quantity === 'number' && composed.quantity > 0
      && typeof composed.priceCents === 'number' && composed.priceCents > 0;
  }

  it('would catch a mirror that only checks for a non-empty buyer and parseable numbers', async () => {
    const divergences: string[] = [];
    for (const { name, composed } of cases) {
      if (naiveAllows(composed) !== await serverAllows(composed)) divergences.push(name);
    }
    // The floor, cap, availability and blocked-kind gates are all invisible to
    // the naive mirror, so several cases must separate them.
    expect(divergences.length).toBeGreaterThan(2);
  });
});

describe('evaluateOffer states the client-only conditions honestly', () => {
  const policy = rawPolicy(20);
  const composed = { policy, currentPriceCents: 4_000, availableQty: 4 };

  it('reports an empty room as no-buyers rather than as the seller\'s mistake', () => {
    const verdict = evaluateOffer({
      policy: clientView(policy),
      productId: PRODUCT,
      currentPriceCents: composed.currentPriceCents,
      availableQty: composed.availableQty,
      buyerId: '',
      quantity: 1,
      priceCents: 3_600,
      candidates: [],
    });
    expect(verdict.code).toBe('no-buyers');
    expect(verdict.sendable).toBe(false);
  });

  it('asks the seller to choose when the room is populated but nobody is picked', () => {
    const verdict = evaluateOffer({
      policy: clientView(policy),
      productId: PRODUCT,
      currentPriceCents: composed.currentPriceCents,
      availableQty: composed.availableQty,
      buyerId: '',
      quantity: 1,
      priceCents: 3_600,
      candidates: [{ buyerId: BUYER, displayName: 'Rae', source: 'room' }],
    });
    expect(verdict.code).toBe('buyer-target');
  });

  it('stays sendable, and says so, when no policy reached the client', () => {
    const verdict = evaluateOffer({
      policy: undefined,
      productId: PRODUCT,
      currentPriceCents: 4_000,
      availableQty: 4,
      buyerId: BUYER,
      quantity: 1,
      priceCents: 3_600,
    });
    expect(verdict.sendable).toBe(true);
    expect(verdict.message).toMatch(/server still enforces/i);
  });

  it('never claims a floor it did not read', () => {
    const verdict = evaluateOffer({
      policy: undefined,
      productId: PRODUCT,
      currentPriceCents: 4_000,
      availableQty: 4,
      buyerId: BUYER,
      quantity: 1,
      priceCents: 3_600,
    });
    expect(verdict.floor).toBeNull();
  });
});

describe('buyerCandidates derives who an offer may be addressed to', () => {
  const presence = [
    { userId: 'buyer-a', displayName: 'Ada', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:00.000Z') },
    { userId: 'buyer-b', displayName: 'Bo', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:05.000Z') },
    { userId: 'seller-1', displayName: 'Avi', role: 'seller', lastSeenAt: Date.parse('2026-08-17T07:00:06.000Z') },
  ];

  it('keeps buyers and drops sellers', () => {
    expect(buyerCandidates({ presence }).map((c) => c.buyerId)).toEqual(['buyer-b', 'buyer-a']);
  });

  it('orders room presence most-recently-seen first', () => {
    expect(buyerCandidates({ presence })[0]?.displayName).toBe('Bo');
  });

  it('folds in the live auction bidder behind room presence', () => {
    const candidates = buyerCandidates({
      presence,
      auction: { winnerOrder: { bidderId: 'buyer-z' } },
    });
    expect(candidates.map((c) => c.buyerId)).toEqual(['buyer-b', 'buyer-a', 'buyer-z']);
    expect(candidates.at(-1)?.source).toBe('bidder');
  });

  it('does not duplicate a bidder who is also in the room', () => {
    const candidates = buyerCandidates({
      presence,
      auction: { winnerOrder: { bidderId: 'buyer-a' } },
    });
    expect(candidates.filter((c) => c.buyerId === 'buyer-a')).toHaveLength(1);
    expect(candidates.find((c) => c.buyerId === 'buyer-a')?.source).toBe('room');
  });

  it('excludes the acting seller even if their row claims a buyer role', () => {
    const candidates = buyerCandidates({
      presence: [{ userId: 'seller-1', displayName: 'Avi', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:00.000Z') }],
      excludeUserId: 'seller-1',
    });
    expect(candidates).toEqual([]);
  });

  it('drops rows with no usable id rather than offering a blank option', () => {
    const candidates = buyerCandidates({
      presence: [{ userId: '  ', displayName: 'Ghost', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:00.000Z') }],
    });
    expect(candidates).toEqual([]);
  });

  it('falls back to the id when a presence row carries no display name', () => {
    const candidates = buyerCandidates({
      presence: [{ userId: 'buyer-c', displayName: '   ', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:00.000Z') }],
    });
    expect(candidates[0]?.displayName).toBe('buyer-c');
  });

  it('keeps the freshest row when presence repeats a buyer', () => {
    const candidates = buyerCandidates({
      presence: [
        { userId: 'buyer-a', displayName: 'Ada', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:00.000Z') },
        { userId: 'buyer-a', displayName: 'Ada Reborn', role: 'buyer', lastSeenAt: Date.parse('2026-08-17T07:00:09.000Z') },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.displayName).toBe('Ada Reborn');
  });

  // WI-39774: the zero websocket path delivered lastSeenAt as EPOCH MILLISECONDS
  // while REST sent an ISO string. The string-only comparator threw
  // `localeCompare is not a function` DURING RENDER, which remounted the sync
  // subtree and tore down the live WHIP session — the "streaming dies seconds
  // after going live" symptom.
  //
  // D-026 removed the fork itself: epoch millis is the contract's one timestamp
  // encoding, so the two tests that pinned MIXED shapes on one axis are gone —
  // that state is now unreachable, and the parity differential's ENCODING
  // MISMATCH class is what keeps it unreachable. What survives is the pair that
  // still has a referent: ordinary numeric ordering, and the render-safety
  // property for a value that violates the contract anyway.
  it('sorts numeric epoch-ms lastSeenAt rows without throwing, most recent first', () => {
    const candidates = buyerCandidates({
      presence: [
        { userId: 'buyer-a', displayName: 'Ada', role: 'buyer', lastSeenAt: 1_787_000_000_000 },
        { userId: 'buyer-b', displayName: 'Bo', role: 'buyer', lastSeenAt: 1_787_000_005_000 },
      ],
    });
    expect(candidates.map((c) => c.buyerId)).toEqual(['buyer-b', 'buyer-a']);
  });

  it('sorts a row whose lastSeenAt is not a number oldest instead of throwing', () => {
    const candidates = buyerCandidates({
      presence: [
        // Deliberately violates PresenceRowView: a rung serving a stale ISO
        // string must degrade this row to last place, never crash the render.
        // Only a cast can express that here, which is the point — the type says
        // it cannot happen and this test says what happens when it does anyway.
        { userId: 'buyer-a', displayName: 'Ada', role: 'buyer', lastSeenAt: '2026-08-17T09:00:00.000Z' as unknown as number },
        { userId: 'buyer-b', displayName: 'Bo', role: 'buyer', lastSeenAt: 1_787_000_005_000 },
      ],
    });
    expect(candidates.map((c) => c.buyerId)).toEqual(['buyer-b', 'buyer-a']);
  });
});

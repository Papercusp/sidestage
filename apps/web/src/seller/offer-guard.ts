/**
 * Client mirror of the server's TARGETED-OFFER gate, plus the derivation of
 * who a targeted offer may actually be sent to.
 *
 * AUTHORITY IS SERVER-SIDE. `apps/api/src/copilot/guardrail.ts`
 * (`PolicyActionGuard.evaluate`) accepts or rejects the offer; nothing here
 * gates anything on its own. This module exists so the seller is never shown a
 * control that lets them compose an offer the server will refuse — the same
 * contract `markdown-guard.ts` holds for markdowns, and it is verified the same
 * way: `offer-guard.test.ts` runs this module DIFFERENTIALLY against the real
 * `PolicyActionGuard`, importing the guard itself rather than a restatement of
 * it, so a divergence fails a test instead of reaching a seller.
 *
 * The server's order for `kind: 'targeted-offer'`, which `evaluateOffer`
 * reproduces exactly (first failure wins — the codes below are the server's):
 *
 *   1. `policy.blockedActionKinds` includes the kind      → 'policy'        (:73)
 *   2. `buyerId.trim()` is empty                          → 'buyer-target'  (:78)
 *   3. quantity is not a positive safe integer            → 'invalid-action'(:81)
 *   4. quantity > `eventItem.availableQty`                → 'availability'  (:84)
 *   5. priceCents is not a positive safe integer          → 'invalid-action'(:121)
 *   6. no configured floor for the product                → 'policy'        (:126)
 *   7. priceCents < the configured floor                  → 'price-floor'   (:129)
 *   8. achieved markdown > `maxMarkdownPercent`           → 'markdown-limit'(:137)
 *   9. priceCents > the verified event price              → 'invalid-action'(:143)
 *
 * Steps 5-9 are why this module reuses `markdown-guard.ts` instead of forking
 * it: a targeted offer is a PRICE-BEARING kind (`PRICE_KINDS`, guardrail.ts:16),
 * so it passes the identical floor and markdown-cap gate a markdown does. The
 * offer price field was previously an unguarded free number, which meant a
 * seller could type a price the event policy had already ruled out and learn
 * about it only from a server rejection.
 */

import {
  achievedMarkdownPercent,
  effectiveFloorCents,
  type MarkdownFloor,
  type MarkdownPolicyView,
} from './markdown-guard';

/** A buyer a targeted offer may be addressed to. Never a typed opaque id. */
export interface BuyerCandidate {
  buyerId: string;
  displayName: string;
  /**
   * Where this buyer came from, because the two mean different things to a
   * seller: 'room' is someone whose presence the server saw inside the
   * presence TTL; 'bidder' is someone who bid on the live auction and may have
   * since closed the tab.
   */
  source: 'room' | 'bidder';
  /** ISO instant, present for room presence only. */
  lastSeenAt?: string;
}

/** The presence row shape `event.chat.presence` returns (EventChat.tsx:48). */
export interface PresenceRowView {
  userId: string;
  displayName: string;
  role: string;
  lastSeenAt: string;
}

/** The slice of the live auction that names a bidder (api.ts:60 SellerAuction). */
export interface AuctionBidderView {
  winnerOrder?: { bidderId: string };
}

/**
 * The people a targeted offer may be sent to, most-recently-seen first.
 *
 * Room presence is the primary source: the server already filters it to a
 * 35-second TTL (`PRESENCE_TTL_MS`, chat.service.ts:54), so a row here means
 * the buyer is in the event NOW. The live auction's bidder is folded in behind
 * it because a bidder is unambiguously a buyer in this event even if their
 * presence heartbeat lapsed mid-bid.
 *
 * Sellers are excluded by role, and `excludeUserId` drops the acting seller
 * defensively in case a seller's presence row is ever recorded with a buyer
 * role. A candidate with no id is dropped rather than rendered as a blank
 * option that would fail the server's buyer-target check on send.
 */
export function buyerCandidates(input: {
  presence?: readonly PresenceRowView[] | null;
  auction?: AuctionBidderView | null;
  excludeUserId?: string | null;
}): BuyerCandidate[] {
  const { presence, auction, excludeUserId } = input;
  const byId = new Map<string, BuyerCandidate>();

  for (const row of presence ?? []) {
    const buyerId = typeof row?.userId === 'string' ? row.userId.trim() : '';
    if (!buyerId || row.role !== 'buyer') continue;
    if (excludeUserId && buyerId === excludeUserId.trim()) continue;
    const displayName = typeof row.displayName === 'string' && row.displayName.trim()
      ? row.displayName.trim()
      : buyerId;
    const existing = byId.get(buyerId);
    if (existing && (existing.lastSeenAt ?? '') >= (row.lastSeenAt ?? '')) continue;
    byId.set(buyerId, { buyerId, displayName, source: 'room', lastSeenAt: row.lastSeenAt });
  }

  const bidderId = typeof auction?.winnerOrder?.bidderId === 'string'
    ? auction.winnerOrder.bidderId.trim()
    : '';
  if (bidderId && !byId.has(bidderId) && (!excludeUserId || bidderId !== excludeUserId.trim())) {
    byId.set(bidderId, { buyerId: bidderId, displayName: bidderId, source: 'bidder' });
  }

  return [...byId.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'room' ? -1 : 1;
    const seen = (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
    return seen !== 0 ? seen : a.displayName.localeCompare(b.displayName);
  });
}

export type OfferVerdictCode =
  | 'ok'
  /** The event policy forbids targeted offers outright. */
  | 'kind-blocked'
  /** Nobody has been chosen, or the chosen id is empty. */
  | 'buyer-target'
  /** Nobody is available to choose — a UI state, not a server code. */
  | 'no-buyers'
  | 'invalid-quantity'
  | 'availability'
  | 'invalid-price'
  /** The policy reached us but carries no usable floor for this product. */
  | 'policy-floor-unknown'
  | 'price-floor'
  | 'markdown-limit'
  /** An offer may never raise the verified event price. */
  | 'price-above-event';

export interface OfferVerdict {
  code: OfferVerdictCode;
  /** Whether the control should let this be sent. */
  sendable: boolean;
  /** Seller-readable, present whenever there is something to say. */
  message: string | null;
  /** The floor being drawn, so the control and the message cannot disagree. */
  floor: MarkdownFloor | null;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Evaluate a composed targeted offer the way the server will.
 *
 * `candidates` is optional and is a UI concern only: when it is supplied and
 * empty, there is nobody in the event to address, which is reported as
 * 'no-buyers' rather than as the server's 'buyer-target' — the seller has done
 * nothing wrong and the fix is not "pick someone".
 *
 * `policy` being absent means UNKNOWN, never permissive-zero: the price gate is
 * skipped with a message saying the server still enforces, exactly as
 * `evaluateMarkdown` does. Refusing there would be inventing a guardrail we
 * never read.
 */
export function evaluateOffer(input: {
  policy: MarkdownPolicyView | null | undefined;
  blockedActionKinds?: readonly string[] | null;
  productId: string;
  /** The verified event price of the item, in cents. */
  currentPriceCents: number;
  availableQty: number;
  buyerId: string;
  quantity: number | null;
  priceCents: number | null;
  candidates?: readonly BuyerCandidate[];
}): OfferVerdict {
  const {
    policy, blockedActionKinds, productId, currentPriceCents,
    availableQty, buyerId, quantity, priceCents, candidates,
  } = input;

  const floor = effectiveFloorCents(policy, productId, currentPriceCents);
  const withFloor = (code: OfferVerdictCode, sendable: boolean, message: string | null): OfferVerdict =>
    ({ code, sendable, message, floor });

  if (blockedActionKinds?.includes('targeted-offer')) {
    return withFloor('kind-blocked', false, 'The event policy does not allow targeted offers.');
  }
  if (candidates && candidates.length === 0) {
    return withFloor('no-buyers', false, 'No buyers are in this event yet — an offer needs someone to send it to.');
  }
  if (!buyerId.trim()) {
    return withFloor('buyer-target', false, 'Choose the buyer who will receive this offer.');
  }
  if (!isPositiveSafeInteger(quantity)) {
    return withFloor('invalid-quantity', false, 'Enter a whole number of units.');
  }
  if (quantity > availableQty) {
    return withFloor(
      'availability',
      false,
      `Only ${availableQty} unit${availableQty === 1 ? '' : 's'} remain available.`,
    );
  }
  if (!isPositiveSafeInteger(priceCents)) {
    return withFloor('invalid-price', false, 'Enter an offer price above zero.');
  }

  // Price gate. `maxMarkdownPercent` absent means no policy reached the client;
  // the server still enforces, so this stays sendable and says so.
  const cap = policy?.maxMarkdownPercent;
  const capUsable = typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && cap <= 100;
  if (!capUsable && floor === null) {
    return withFloor(
      'ok',
      true,
      'Event guardrails have not loaded — the server still enforces this offer.',
    );
  }
  if (floor === null) {
    return withFloor(
      'policy-floor-unknown',
      false,
      'This product has no verified price floor, so the event policy will refuse the offer.',
    );
  }
  if (priceCents < floor.cents) {
    return withFloor('price-floor', false, `${formatMoney(floor.cents)} is the lowest this event allows.`);
  }
  if (capUsable && achievedMarkdownPercent(currentPriceCents, priceCents) > cap) {
    return withFloor('markdown-limit', false, `The ${cap}% event limit stops at ${formatMoney(floor.cents)}.`);
  }
  if (priceCents > currentPriceCents) {
    return withFloor('price-above-event', false, 'An offer cannot cost more than the event price.');
  }

  const saving = currentPriceCents - priceCents;
  return withFloor(
    'ok',
    true,
    saving > 0 ? `${formatMoney(saving)} below the event price` : null,
  );
}

/**
 * Client mirror of the server's markdown gate.
 *
 * AUTHORITY IS SERVER-SIDE. `apps/api/src/copilot/guardrail.ts`
 * (`PolicyActionGuard.evaluate`) is what actually accepts or rejects a
 * markdown; nothing here gates anything on its own. This module exists for two
 * reasons, both of which are about not lying to the seller:
 *
 *   1. The resulting-price preview must show the EXACT price the action will
 *      carry. Previewing one number and sending another is the failure class
 *      D-003 of the run-of-show plan calls out — an authoritative-looking wrong
 *      number is worse than no number.
 *   2. The stepper must stop where the server stops, so a seller never gets a
 *      rejection for a value the UI let them dial in.
 *
 * The three server conditions being mirrored (guardrail.ts:125-145):
 *   - `priceCents >= priceFloorCentsByProduct[productId]`   (code 'price-floor')
 *   - `markdownPercent(current, proposed) <= maxMarkdownPercent` ('markdown-limit')
 *   - a markdown may never RAISE the verified event price     ('invalid-action')
 *
 * ...and the floor derivation the server applies before enforcement
 * (`withDerivedPriceFloors`, event-config.service.ts:168-179): an explicit
 * policy floor always wins; a product with no explicit floor derives one from
 * the markdown cap.
 *
 * `markdown-guard.test.ts` runs this module DIFFERENTIALLY against that real
 * server guard — it imports PolicyActionGuard itself rather than a restatement
 * of it — so a divergence fails a test instead of reaching a seller.
 */

/**
 * The slice of the event policy this control needs. Both fields are optional
 * because `event.config` may answer before a policy is resolved, and because
 * the client-side view type has historically declared less than the wire
 * payload carries. An absent field means UNKNOWN, never zero.
 */
export interface MarkdownPolicyView {
  maxMarkdownPercent?: number;
  priceFloorCentsByProduct?: Record<string, number>;
}

/** Where the floor being displayed came from — sellers ask, and the two differ. */
export type MarkdownFloorSource = 'policy' | 'markdown-cap';

export interface MarkdownFloor {
  cents: number;
  source: MarkdownFloorSource;
}

export type MarkdownVerdictCode =
  | 'ok'
  /** No policy reached the client. The server still enforces; we claim nothing. */
  | 'policy-unknown'
  /** The policy arrived but is unusable (out-of-range cap, negative floor). */
  | 'policy-invalid'
  | 'invalid-percent'
  | 'exceeds-cap'
  | 'below-floor';

export interface MarkdownVerdict {
  code: MarkdownVerdictCode;
  /** Whether the control should let this be sent. */
  sendable: boolean;
  /** The price the action will carry, in integer cents. */
  proposedPriceCents: number | null;
  savingCents: number | null;
  floor: MarkdownFloor | null;
  maxPercent: number | null;
  /**
   * The largest percent that still clears BOTH the cap and the floor — the
   * value the stepper stops at. Null when no policy is known: we do not invent
   * a limit we never read.
   */
  maxAllowedPercent: number | null;
  /** Seller-readable, present whenever there is something to say. */
  message: string | null;
}

function isSafePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isUsableCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * The price a markdown of `percent` off `currentPriceCents` will send.
 *
 * CEIL, not round. The server derives its floor with `Math.ceil` and then
 * rejects anything strictly below it, so a rounded price lands one cent under
 * the floor for most prices at exactly the cap — the seller dials in the limit
 * the UI showed them and the server rejects it. Ceiling satisfies the floor and
 * the cap simultaneously at the boundary, so the maximum markdown is actually
 * reachable.
 */
export function markdownPriceCents(currentPriceCents: number, percent: number): number | null {
  if (!isSafePrice(currentPriceCents)) return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.max(1, Math.ceil(currentPriceCents * (1 - percent / 100)));
}

/**
 * Mirrors `withDerivedPriceFloors`: an explicit policy floor wins whenever it
 * is a safe integer; otherwise the floor derives from the markdown cap.
 * Returns null when neither is knowable — the honest "no floor to draw".
 */
export function effectiveFloorCents(
  policy: MarkdownPolicyView | null | undefined,
  productId: string,
  currentPriceCents: number,
): MarkdownFloor | null {
  const explicit = policy?.priceFloorCentsByProduct?.[productId];
  if (typeof explicit === 'number' && Number.isSafeInteger(explicit)) {
    return { cents: explicit, source: 'policy' };
  }
  const cap = policy?.maxMarkdownPercent;
  if (!isUsableCap(cap) || !isSafePrice(currentPriceCents)) return null;
  return { cents: Math.max(1, Math.ceil(currentPriceCents * (1 - cap / 100))), source: 'markdown-cap' };
}

/**
 * The largest percent the stepper may reach: bounded by the cap, and by the
 * floor when an explicit policy floor bites harder than the cap does.
 *
 * Deliberately conservative at the boundary — it returns the percent whose
 * EXACT price equals the floor, which `markdownPriceCents` then ceilings back
 * onto the floor rather than one cent under it.
 */
export function maxAllowedPercent(
  policy: MarkdownPolicyView | null | undefined,
  productId: string,
  currentPriceCents: number,
  step = 0.5,
): number | null {
  const cap = policy?.maxMarkdownPercent;
  if (!isUsableCap(cap) || !isSafePrice(currentPriceCents)) return null;
  const floor = effectiveFloorCents(policy, productId, currentPriceCents);
  let limit = cap;
  if (floor && floor.cents >= 0) {
    limit = Math.min(limit, ((currentPriceCents - floor.cents) / currentPriceCents) * 100);
  }
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const quantum = Number.isFinite(step) && step > 0 ? step : 0.5;
  // Guard the classic float artefact: 100*(4000-3200)/4000 is 19.999999999999996,
  // which would floor to 19.5 and quietly cost the seller half a point of cap.
  const stepped = Math.floor((limit + 1e-9) / quantum) * quantum;
  return Math.max(0, Number(stepped.toFixed(4)));
}

/**
 * The markdown the server will actually see, mirroring `markdownPercent` in
 * guardrail.ts:41-44. This is NOT the percent the seller dialled in: ceiling to
 * whole cents means a request for 33.5% off $1.99 arrives as 33.17%. The server
 * caps the achieved percent, not the requested one.
 */
export function achievedMarkdownPercent(currentPriceCents: number, proposedPriceCents: number): number {
  if (proposedPriceCents >= currentPriceCents || currentPriceCents === 0) return 0;
  return ((currentPriceCents - proposedPriceCents) / currentPriceCents) * 100;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Evaluate a proposed markdown the way the server will.
 *
 * `sendable` stays TRUE when no policy reached the client: refusing there would
 * be inventing a guardrail we never read, and the server enforces regardless.
 * The message says so rather than implying a limit.
 */
export function evaluateMarkdown(input: {
  policy: MarkdownPolicyView | null | undefined;
  productId: string;
  currentPriceCents: number;
  percent: number;
  step?: number;
}): MarkdownVerdict {
  const { policy, productId, currentPriceCents, percent, step } = input;
  const floor = effectiveFloorCents(policy, productId, currentPriceCents);
  const cap = policy?.maxMarkdownPercent;
  const maxPercent = isUsableCap(cap) ? cap : null;
  const allowed = maxAllowedPercent(policy, productId, currentPriceCents, step);
  const base = { floor, maxPercent, maxAllowedPercent: allowed };

  const proposedPriceCents = markdownPriceCents(currentPriceCents, percent);
  if (proposedPriceCents === null) {
    return {
      ...base,
      code: 'invalid-percent',
      sendable: false,
      proposedPriceCents: null,
      savingCents: null,
      message: 'Enter a markdown between 0% and 100%.',
    };
  }
  const savingCents = currentPriceCents - proposedPriceCents;
  const priced = { ...base, proposedPriceCents, savingCents };

  if (policy === null || policy === undefined || (maxPercent === null && floor === null)) {
    return {
      ...priced,
      code: 'policy-unknown',
      sendable: true,
      message: 'Event guardrails have not loaded — the server still enforces this markdown.',
    };
  }
  if (maxPercent === null || (floor !== null && floor.cents < 0)) {
    return {
      ...priced,
      code: 'policy-invalid',
      sendable: false,
      message: 'The event policy is not usable for price changes. Check the event configuration.',
    };
  }
  // Server order: the floor is checked BEFORE the cap (guardrail.ts:125 then
  // :136), so when the floor is cap-derived the floor is what trips. Mirror the
  // ALLOW/BLOCK decision exactly; choose the seller-facing message by the real
  // CAUSE instead, because "below the $32.00 floor" is unhelpful when the floor
  // exists only because the cap put it there.
  const belowFloor = floor !== null && proposedPriceCents < floor.cents;
  if (belowFloor && floor.source === 'policy') {
    return {
      ...priced,
      code: 'below-floor',
      sendable: false,
      message: `${formatMoney(floor.cents)} is the policy price floor for this product.`,
    };
  }
  // A markdown the seller ASKED for above the cap is refused even in the cases
  // where ceiling to whole cents would sneak the achieved percent back under it
  // (a 33.5% request on a $1.99 item arrives as 33.17%). Letting the UI exceed a
  // stated policy limit on a rounding artefact would be dishonest, so the stop
  // is drawn at the stated cap and this mirror is deliberately the stricter of
  // the two. `achievedMarkdownPercent` is what the server compares.
  if (belowFloor || percent > maxPercent || achievedMarkdownPercent(currentPriceCents, proposedPriceCents) > maxPercent) {
    return {
      ...priced,
      code: 'exceeds-cap',
      sendable: false,
      message: floor !== null
        ? `The ${maxPercent}% event limit stops at ${formatMoney(floor.cents)}.`
        : `The event limit is ${maxPercent}%.`,
    };
  }
  return {
    ...priced,
    code: 'ok',
    sendable: true,
    message: floor === null
      ? null
      : floor.source === 'policy'
        ? `Policy floor ${formatMoney(floor.cents)}`
        : `Event limit ${maxPercent}% · floor ${formatMoney(floor.cents)}`,
  };
}

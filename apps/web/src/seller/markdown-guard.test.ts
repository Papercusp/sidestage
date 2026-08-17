import { describe, expect, it } from 'vitest';
import { PolicyActionGuard } from '../../../api/src/copilot/guardrail';
import type {
  CopilotActionProposal,
  CopilotPolicy,
  GroundingContext,
} from '../../../api/src/copilot/copilot.types';
import { withDerivedPriceFloors } from '../../../api/src/config/event-config.service';
import {
  effectiveFloorCents,
  evaluateMarkdown,
  markdownPriceCents,
  maxAllowedPercent,
  type MarkdownPolicyView,
} from './markdown-guard';

/**
 * This suite is DIFFERENTIAL, not a restatement.
 *
 * It imports the real server gate (`PolicyActionGuard`) and the real floor
 * derivation (`withDerivedPriceFloors`) and asserts the client mirror in
 * markdown-guard.ts reaches the same verdict. A restatement of the server rule
 * here would agree with the mirror whenever both were wrong in the same way,
 * which is exactly the failure this is meant to catch.
 *
 * Note the deliberate asymmetry in what each side is fed. The client receives
 * the policy as `readEventConfigView` sends it — with `priceFloorCentsByProduct`
 * usually EMPTY, because the derivation runs later, at the action boundary
 * (event-policy-resolver.ts:45). The server is fed the derived policy. That gap
 * is the reason the client has to derive a floor of its own, and the reason
 * this test exists.
 */

const PRODUCT = 'aurora-cup';
const guard = new PolicyActionGuard();

function serverContext(policy: CopilotPolicy, priceCents: number, availableQty = 4): GroundingContext {
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

function rawPolicy(maxMarkdownPercent: number, floors: Record<string, number> = {}): CopilotPolicy {
  return {
    automationLevel: 'confirm',
    allowAutoActions: false,
    priceFloorCentsByProduct: floors,
    maxMarkdownPercent,
    blockedActionKinds: [],
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

async function serverAccepts(policy: CopilotPolicy, priceCents: number, proposedPriceCents: number) {
  const action: CopilotActionProposal = {
    kind: 'markdown',
    productId: PRODUCT,
    priceCents: proposedPriceCents,
    reason: 'Seller applied a live-event markdown',
  };
  return guard.evaluate(action, serverContext(policy, priceCents));
}

/** A spread wide enough that ceil-vs-round and float artefacts both show up. */
const PRICES = [199, 999, 1000, 2003, 2499, 3333, 4000, 5001, 7777, 12345, 99999];
const CAPS = [0, 5, 12.5, 20, 30, 33.3, 50, 100];
const STEP = 0.5;

describe('markdownPriceCents', () => {
  it('never raises the price and never goes below one cent', () => {
    for (const price of PRICES) {
      for (const percent of [0, 0.5, 25, 99.5, 100]) {
        const proposed = markdownPriceCents(price, percent)!;
        expect(proposed).toBeGreaterThanOrEqual(1);
        expect(proposed).toBeLessThanOrEqual(price);
      }
    }
  });

  it('rejects a percent outside 0..100 and a non-integer price rather than guessing', () => {
    expect(markdownPriceCents(1000, -1)).toBeNull();
    expect(markdownPriceCents(1000, 101)).toBeNull();
    expect(markdownPriceCents(1000, Number.NaN)).toBeNull();
    expect(markdownPriceCents(0, 10)).toBeNull();
    expect(markdownPriceCents(10.5, 10)).toBeNull();
  });
});

describe('the client mirror agrees with the real server guard', () => {
  /**
   * SOUNDNESS — the safety property. Anything the control presents as sendable
   * must survive the real guard. A violation here means a seller gets a
   * rejection the UI told them would not happen.
   */
  it('never calls a markdown ok that PolicyActionGuard rejects', async () => {
    const unsound: string[] = [];
    for (const price of PRICES) {
      for (const cap of CAPS) {
        for (const floors of [{}, { [PRODUCT]: Math.ceil(price * 0.8) }, { [PRODUCT]: 1 }]) {
          const policy = rawPolicy(cap, floors);
          const view = clientView(policy);
          for (let percent = 0; percent <= 100; percent += STEP) {
            const verdict = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: price, percent });
            if (verdict.code !== 'ok') continue;
            const decision = await serverAccepts(policy, price, verdict.proposedPriceCents!);
            if (!decision.allowed) {
              unsound.push(
                `price=${price} cap=${cap} floors=${JSON.stringify(floors)} percent=${percent} `
                + `proposed=${verdict.proposedPriceCents} server=${decision.code}`,
              );
            }
          }
        }
      }
    }
    expect(unsound.slice(0, 10)).toEqual([]);
  });

  /**
   * NO FALSE STOP — everything at or under the stop the stepper draws is both
   * ok to the control and accepted by the server. Soundness alone is satisfied
   * by a control that refuses everything; this is the half that stops it.
   */
  it('accepts every percent at or below the stop it draws', async () => {
    const falseStops: string[] = [];
    for (const price of PRICES) {
      for (const cap of CAPS) {
        const policy = rawPolicy(cap);
        const view = clientView(policy);
        const stop = maxAllowedPercent(view, PRODUCT, price, STEP);
        if (stop === null) continue;
        for (let percent = 0; percent <= stop; percent += STEP) {
          const verdict = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: price, percent });
          const decision = await serverAccepts(policy, price, verdict.proposedPriceCents!);
          if (verdict.code !== 'ok' || !decision.allowed) {
            falseStops.push(
              `price=${price} cap=${cap} percent=${percent} stop=${stop} `
              + `client=${verdict.code} server=${decision.allowed ? 'allowed' : decision.code}`,
            );
          }
        }
      }
    }
    expect(falseStops.slice(0, 10)).toEqual([]);
  });

  /**
   * BOUNDED CONSERVATISM. The control is deliberately stricter than the server
   * in exactly one situation: a request ABOVE the stated cap that ceiling to
   * whole cents would sneak back under it. Pinning that boundary keeps an
   * unrelated over-block from hiding inside the intended one.
   */
  it('is stricter than the server only for requests above the stated cap', async () => {
    const unexplained: string[] = [];
    for (const price of PRICES) {
      for (const cap of CAPS) {
        const policy = rawPolicy(cap);
        const view = clientView(policy);
        for (let percent = 0; percent <= 100; percent += STEP) {
          const verdict = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: price, percent });
          if (verdict.code === 'ok') continue;
          const decision = await serverAccepts(policy, price, verdict.proposedPriceCents!);
          if (decision.allowed && percent <= cap) {
            unexplained.push(`price=${price} cap=${cap} percent=${percent} client=${verdict.code}`);
          }
        }
      }
    }
    expect(unexplained.slice(0, 10)).toEqual([]);
  });

  it('blames the cap, not the derived floor, when the cap is what put the floor there', async () => {
    const policy = rawPolicy(20);
    const view = clientView(policy);
    const over = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: 4000, percent: 25 });
    expect(over.code).toBe('exceeds-cap');
    expect(over.message).toContain('20%');
    // The server checks the floor first, so its own code names the derived
    // floor even though the cap is the cause. Both refuse; only the wording
    // differs, and the seller-facing one names the lever they can act on.
    const decision = await serverAccepts(policy, 4000, over.proposedPriceCents!);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('price-floor');
  });

  it('blocks below an explicit policy floor that bites harder than the cap', async () => {
    // Cap alone would allow 50% off $40.00; the published floor stops it at $32.00.
    const policy = rawPolicy(50, { [PRODUCT]: 3200 });
    const view = clientView(policy);
    const verdict = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: 4000, percent: 30 });
    expect(verdict.code).toBe('below-floor');
    expect(verdict.floor).toEqual({ cents: 3200, source: 'policy' });
    const decision = await serverAccepts(policy, 4000, verdict.proposedPriceCents!);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('price-floor');
  });
});

describe('maxAllowedPercent is genuinely reachable', () => {
  /**
   * The regression that motivated this module. Shipped code sent
   * `Math.round(price * (1 - percent / 100))` while the server derived its floor
   * with `Math.ceil`, so on many prices the maximum markdown the UI advertised
   * was rejected on arrival. The stop the stepper draws has to be a value the
   * server actually takes.
   */
  it('the server accepts a markdown at the exact stop the stepper draws', async () => {
    const unreachable: string[] = [];
    for (const price of PRICES) {
      for (const cap of CAPS) {
        for (const floors of [{}, { [PRODUCT]: Math.ceil(price * 0.8) }, { [PRODUCT]: 1 }]) {
          const policy = rawPolicy(cap, floors);
          const view = clientView(policy);
          const stop = maxAllowedPercent(view, PRODUCT, price, STEP);
          if (stop === null) continue;
          const verdict = evaluateMarkdown({ policy: view, productId: PRODUCT, currentPriceCents: price, percent: stop });
          const decision = await serverAccepts(policy, price, verdict.proposedPriceCents!);
          if (!decision.allowed || verdict.code !== 'ok') {
            unreachable.push(
              `price=${price} cap=${cap} floors=${JSON.stringify(floors)} stop=${stop} `
              + `proposed=${verdict.proposedPriceCents} client=${verdict.code} server=${decision.code ?? 'allowed'}`,
            );
          }
        }
      }
    }
    expect(unreachable.slice(0, 10)).toEqual([]);
  });

  it('a half-point of cap is not lost to a floating-point artefact', () => {
    // 100 * (4000 - 3200) / 4000 evaluates to 19.999999999999996.
    expect(maxAllowedPercent({ maxMarkdownPercent: 50, priceFloorCentsByProduct: { [PRODUCT]: 3200 } }, PRODUCT, 4000, 0.5))
      .toBe(20);
  });

  it('stops at zero rather than going negative when the floor is already the price', () => {
    expect(maxAllowedPercent({ maxMarkdownPercent: 30, priceFloorCentsByProduct: { [PRODUCT]: 4000 } }, PRODUCT, 4000))
      .toBe(0);
  });
});

describe('degrading honestly when no policy arrived', () => {
  it('claims no floor and no limit, and still lets the seller send', () => {
    for (const policy of [null, undefined, {} as MarkdownPolicyView]) {
      const verdict = evaluateMarkdown({ policy, productId: PRODUCT, currentPriceCents: 4000, percent: 90 });
      expect(verdict.code).toBe('policy-unknown');
      expect(verdict.sendable).toBe(true);
      expect(verdict.floor).toBeNull();
      expect(verdict.maxPercent).toBeNull();
      expect(verdict.maxAllowedPercent).toBeNull();
      expect(verdict.message).toMatch(/server still enforces/i);
      // The preview stays truthful even with no guardrail to draw.
      expect(verdict.proposedPriceCents).toBe(400);
    }
  });

  it('derives no floor from a cap that is out of range', () => {
    expect(effectiveFloorCents({ maxMarkdownPercent: 140 }, PRODUCT, 4000)).toBeNull();
    expect(effectiveFloorCents({ maxMarkdownPercent: Number.NaN }, PRODUCT, 4000)).toBeNull();
  });

  it('reports the cap-derived floor as cap-derived, not as a policy floor', () => {
    expect(effectiveFloorCents({ maxMarkdownPercent: 20 }, PRODUCT, 4000)).toEqual({
      cents: 3200,
      source: 'markdown-cap',
    });
  });

  it('prefers an explicit floor over the derived one, exactly as the server does', () => {
    const view: MarkdownPolicyView = { maxMarkdownPercent: 20, priceFloorCentsByProduct: { [PRODUCT]: 100 } };
    expect(effectiveFloorCents(view, PRODUCT, 4000)).toEqual({ cents: 100, source: 'policy' });
    const derived = withDerivedPriceFloors(rawPolicy(20, { [PRODUCT]: 100 }), [{ productId: PRODUCT, priceCents: 4000 }]);
    expect(derived.priceFloorCentsByProduct[PRODUCT]).toBe(100);
  });
});

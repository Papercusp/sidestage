import { describe, expect, it } from 'vitest';
import {
  CLAIM_ADVERSARIAL_CASES,
  EXERCISED_DEFECT_CODES,
} from './copilot.claims.fixtures';
import {
  fingerprintEvidence,
  listingStateOf,
  rebindClaim,
  verifyClaims,
  type Claim,
  type ClaimDefectCode,
} from './copilot.claims';
import { policyFingerprint } from '../policies/policy-rules';
import { baselinePolicyBody } from '../policies/policy-rules';

/**
 * WI-39259 / plan P-003 — the claim/evidence contract.
 *
 * Structured so each acceptance-bearing clause of P-003 has an EXACT test to
 * point at, which is the bar D-008 closed P-007 on ("every acceptance-bearing
 * clause has an exact test"). The clause each block covers is named in its
 * describe title.
 */

function codesOf(defects: readonly { code: ClaimDefectCode }[]): ClaimDefectCode[] {
  return [...new Set(defects.map((defect) => defect.code))].sort();
}

describe('P-003 adversarial fixtures — every case behaves as specified', () => {
  it.each(CLAIM_ADVERSARIAL_CASES.map((entry) => [entry.caseId, entry] as const))(
    '%s',
    (_caseId, testCase) => {
      const verdict = verifyClaims(testCase.claims, testCase.request, testCase.atSend);
      expect(verdict.supported, testCase.expectation).toBe(testCase.expected.supported);
      expect(codesOf(verdict.defects)).toEqual([...testCase.expected.codes].sort());
    },
  );

  // Without this, every case above could be green because the verifier rejects
  // EVERYTHING — a guard that never passes is broken, not strict.
  it('includes a control case that must pass, and it passes', () => {
    const control = CLAIM_ADVERSARIAL_CASES.filter((entry) => entry.expected.supported);
    expect(control.length).toBeGreaterThan(0);
    for (const entry of control) {
      expect(verifyClaims(entry.claims, entry.request, entry.atSend).supported).toBe(true);
    }
  });

  it('exercises all four typed defect codes', () => {
    expect([...EXERCISED_DEFECT_CODES].sort()).toEqual([
      'evidence-conflicting',
      'evidence-irrelevant',
      'evidence-missing',
      'evidence-stale',
    ]);
  });
});

/**
 * FALSIFIABILITY CONTROL — kept permanently, per the repo's mutation-probe
 * guidance for an imported module (never by mutating the shared tree).
 *
 * `citationsOnlyVerdict` is the behaviour this contract REPLACES: a reply was
 * considered grounded when its `citations` named sources that exist. If the
 * fixtures above were weak, that naive check would satisfy them too, and every
 * test in this file would be green while proving nothing. So the control
 * asserts the fixtures can tell the two apart — and names how many cases the
 * old behaviour would have waved through.
 */
function citationsOnlyVerdict(
  claims: readonly { evidence: readonly { sourceId: string }[] }[],
  context: { sources: readonly { id: string }[] },
): boolean {
  const known = new Set(context.sources.map((source) => source.id));
  return claims.every((claim) => claim.evidence.some((ref) => known.has(ref.sourceId)));
}

describe('P-003 falsifiability control — the fixtures reject the behaviour being replaced', () => {
  it('the old citations-exist check would have sent replies this contract holds', () => {
    const wavedThrough = CLAIM_ADVERSARIAL_CASES.filter((entry) => {
      if (entry.expected.supported) return false;
      return citationsOnlyVerdict(entry.claims.claims, entry.atSend);
    });

    // Every one of these is a reply that names a real, gathered source and is
    // still wrong: the price moved, the sources disagree, the warranty is not
    // in the listing. That gap is the whole reason P-003 exists.
    expect(wavedThrough.length).toBeGreaterThanOrEqual(6);
    for (const entry of wavedThrough) {
      expect(verifyClaims(entry.claims, entry.request, entry.atSend).supported).toBe(false);
    }
  });

  it('and the control case is NOT rejected by either, so strictness is not the explanation', () => {
    const control = CLAIM_ADVERSARIAL_CASES.find((entry) => entry.expected.supported);
    expect(control).toBeDefined();
    if (!control) return;
    expect(citationsOnlyVerdict(control.claims.claims, control.atSend)).toBe(true);
    expect(verifyClaims(control.claims, control.request, control.atSend).supported).toBe(true);
  });
});

describe('P-003 clause: price, availability, listing state, shipping/returns, catalog properties', () => {
  const subjects = CLAIM_ADVERSARIAL_CASES.flatMap((entry) =>
    entry.claims.claims.map((claim) => claim.asserted.subject),
  );

  it('covers every one of the five named subject areas', () => {
    expect([...new Set(subjects)].sort()).toEqual([
      'availability',
      'catalog-property',
      'listing-state',
      'price',
      'returns-policy',
      'shipping-policy',
    ]);
  });

  it('derives listing state from stock and stage presence rather than storing one', () => {
    expect(listingStateOf({ availableQty: 0 })).toBe('sold-out');
    expect(listingStateOf({ availableQty: 0, onStage: true })).toBe('sold-out');
    expect(listingStateOf({ availableQty: 4 })).toBe('listed');
    expect(listingStateOf({ availableQty: 4, onStage: true })).toBe('on-stage');
  });
});

describe('P-003 clause: context fingerprints', () => {
  it('is stable across key order, so an equal fact never reads as changed', () => {
    const a = fingerprintEvidence({ priceCents: 2_800, productId: 'x' }, 1);
    const b = fingerprintEvidence({ productId: 'x', priceCents: 2_800 }, 2);
    expect(a.value).toBe(b.value);
  });

  it('changes when the fact changes', () => {
    expect(fingerprintEvidence(2_800, 1).value).not.toBe(fingerprintEvidence(2_400, 1).value);
  });

  it('does not let the reading TIME affect the comparison', () => {
    // Staleness must mean "the fact moved", never "the reading is old": an
    // unchanged price is still true an hour later, and a changed one is wrong
    // a second later.
    const old = fingerprintEvidence(2_800, 0);
    const fresh = fingerprintEvidence(2_800, Date.now());
    expect(old.value).toBe(fresh.value);
    expect(old.observedAtMs).not.toBe(fresh.observedAtMs);
  });

  it('shares ONE canonical-hash implementation with the policy fingerprint', () => {
    // Reuse check, not a behaviour check: policyFingerprint is now defined in
    // terms of canonicalFingerprint, so a policy body hashes identically
    // whichever door it comes through. A second hash implementation would let
    // the two drift and make a policy claim un-revalidatable.
    const body = baselinePolicyBody();
    expect(fingerprintEvidence(body, 0).value).toBe(policyFingerprint(body));
  });
});

describe('P-003 clause: edited replies', () => {
  const edited = CLAIM_ADVERSARIAL_CASES.find(
    (entry) => entry.caseId === 'seller-edit-adds-an-unsupported-promise',
  );

  it('judges the edited revision on its own claims, not the original verdict', () => {
    expect(edited).toBeDefined();
    if (!edited) return;
    expect(edited.claims.replyRevision).toBe(2);

    // The model's own claim still stands on its own...
    const modelOnly = { replyRevision: 1, claims: [edited.claims.claims[0]] };
    expect(verifyClaims(modelOnly, edited.request, edited.atSend).supported).toBe(true);

    // ...and the edited text as a whole does not.
    expect(verifyClaims(edited.claims, edited.request, edited.atSend).supported).toBe(false);
  });

  it('rebinds surviving evidence and drops evidence the context no longer has', () => {
    const stale = CLAIM_ADVERSARIAL_CASES.find((entry) => entry.caseId === 'price-moved-after-binding');
    expect(stale).toBeDefined();
    if (!stale) return;

    const claim = stale.claims.claims[0] as Claim;
    const rebound = rebindClaim(claim, stale.atSend, 999);
    // Same evidence, re-read against the CURRENT price...
    expect(rebound.evidence).toHaveLength(claim.evidence.length);
    expect(rebound.evidence[0].fingerprint.value).not.toBe(claim.evidence[0].fingerprint.value);

    // ...and rebinding alone does NOT make a wrong claim right. This is the
    // trap a rebind-on-edit path invites: refreshing the fingerprint could
    // otherwise launder a stale number into a fresh-looking one.
    //
    // Note the defect CHANGES rather than disappearing, and the new one is the
    // truer description: before the rebind the complaint was "the price moved
    // after you wrote this"; after it, the fingerprint is current and the
    // remaining problem is that the reply states a price no source says.
    const verdict = verifyClaims({ replyRevision: 2, claims: [rebound] }, stale.request, stale.atSend);
    expect(verdict.supported).toBe(false);
    expect(codesOf(verdict.defects)).toEqual(['evidence-missing']);
  });
});

/**
 * P-004 / plan D-010 — staleness is EVIDENCE-scoped, not context-scoped.
 *
 * The send path used to compare a hash of the WHOLE grounding context, so a
 * reply about one product was blocked because a different product's stock
 * moved — destructively (status 'blocked', regenerate). These pin the narrower
 * rule, and the first test is the one that matters: the non-block.
 */
describe('P-004 clause: only the evidence a reply CITES can make it stale', () => {
  const item = (productId: string, priceCents: number, availableQty = 5) => ({
    eventItemId: `evt:${productId}`,
    productId,
    title: `${productId} title`,
    priceCents,
    availableQty,
    attributes: {},
  });

  const ctx = (items: ReturnType<typeof item>[]): GroundingContext => ({
    eventItems: items,
    catalogProducts: [],
    policy: {
      automationLevel: 'confirm',
      allowAutoActions: false,
      priceFloorCentsByProduct: {},
      maxMarkdownPercent: 20,
      blockedActionKinds: [],
      tone: 'warm',
    },
    sources: items.map((entry) => ({
      id: `event-item:${entry.eventItemId}`,
      kind: 'event-item' as const,
      label: entry.title,
    })),
  });

  it('does NOT report drift when an UNCITED item changes', () => {
    const before = ctx([item('cup', 2_800), item('mug', 1_500)]);
    const after = ctx([item('cup', 2_800), item('mug', 900)]);
    // The reply is about the cup. The mug halving in price is none of its business.
    expect(citedEvidenceDrift(['event-item:evt:cup'], before, after)).toEqual([]);
  });

  it('reports drift when a CITED item changes, and names it readably', () => {
    const before = ctx([item('cup', 2_800), item('mug', 1_500)]);
    const after = ctx([item('cup', 2_400), item('mug', 1_500)]);
    const drift = citedEvidenceDrift(['event-item:evt:cup'], before, after);
    expect(drift).toHaveLength(1);
    expect(drift[0].code).toBe('evidence-stale');
    expect(drift[0].explanation).toContain('cup title');
    expect(drift[0].explanation).not.toMatch(/evidence-|fingerprint|hash/);
  });

  it('reports a cited source that vanished as missing, not stale', () => {
    const before = ctx([item('cup', 2_800)]);
    const after = ctx([]);
    const drift = citedEvidenceDrift(['event-item:evt:cup'], before, after);
    expect(drift.map((entry) => entry.code)).toEqual(['evidence-missing']);
  });

  it('ignores a citation that was never in the original context', () => {
    // Unsupported from the start is verifyClaims' verdict to give, not drift's:
    // reporting it here would blame a change that never happened.
    const before = ctx([item('cup', 2_800)]);
    expect(citedEvidenceDrift(['event-item:evt:ghost'], before, before)).toEqual([]);
  });

  it('treats an unchanged context as no drift at all', () => {
    const before = ctx([item('cup', 2_800), item('mug', 1_500)]);
    expect(citedEvidenceDrift(['event-item:evt:cup', 'event-item:evt:mug'], before, before)).toEqual([]);
  });
});

describe('P-003 clause: typed missing / stale / conflicting evidence reasons', () => {
  it('gives every defect a seller-readable explanation, never a bare code', () => {
    for (const testCase of CLAIM_ADVERSARIAL_CASES) {
      const verdict = verifyClaims(testCase.claims, testCase.request, testCase.atSend);
      for (const defect of verdict.defects) {
        expect(defect.explanation.length, `${testCase.caseId}/${defect.code}`).toBeGreaterThan(20);
        expect(defect.explanation).not.toMatch(/evidence-(missing|stale|irrelevant|conflicting)/);
        expect(defect.claimId).toBeTruthy();
      }
    }
  });

  it('separates "never gathered" from "wrong source", because they need different fixes', () => {
    const notGathered = CLAIM_ADVERSARIAL_CASES.find(
      (entry) => entry.caseId === 'returns-claim-with-no-policy-gathered',
    );
    const wrongSource = CLAIM_ADVERSARIAL_CASES.find(
      (entry) => entry.caseId === 'shipping-claim-cites-a-transcript',
    );
    expect(notGathered).toBeDefined();
    expect(wrongSource).toBeDefined();
    if (!notGathered || !wrongSource) return;

    expect(codesOf(verifyClaims(notGathered.claims, notGathered.request, notGathered.atSend).defects))
      .toEqual(['evidence-missing']);
    expect(codesOf(verifyClaims(wrongSource.claims, wrongSource.request, wrongSource.atSend).defects))
      .toEqual(['evidence-irrelevant']);
  });

  it('reports a conflict even when the claim matches one of the disagreeing sources', () => {
    const conflict = CLAIM_ADVERSARIAL_CASES.find(
      (entry) => entry.caseId === 'event-and-catalog-prices-disagree',
    );
    expect(conflict).toBeDefined();
    if (!conflict) return;
    // Picking the convenient source is how a defensible-looking wrong answer
    // reaches a buyer, so matching one source is not a defence.
    const verdict = verifyClaims(conflict.claims, conflict.request, conflict.atSend);
    expect(verdict.supported).toBe(false);
    expect(codesOf(verdict.defects)).toContain('evidence-conflicting');
  });
});

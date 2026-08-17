/**
 * Adversarial fixtures for the claim/evidence contract (WI-39259 / P-003).
 *
 * P-003 says "add adversarial fixtures first", and the reason is a lesson this
 * repo has already paid for: a harness that cannot EXPRESS a failure state
 * cannot test it, and the untestable state is the one that ships. So the case
 * shape here is deliberately bind-then-send — every case carries the context as
 * it was when the reply was written (`bound`) AND the context as it stands when
 * the reply would go out (`atSend`). A fixture format with a single context
 * could not express staleness at all, which is the defect class most likely to
 * reach a buyer: a reply that was true when generated and false when sent.
 *
 * These are DATA, not tests. Nothing here imports vitest or Nest, so the same
 * cases can drive a unit suite today and a seller-facing rehearsal later
 * (P-004) without being rewritten. The shape extends RehearsalCaseSpec for
 * exactly that reason.
 */

import type { RehearsalCaseSpec } from '../rehearsals/rehearsal.types';
import type { CopilotPolicy, GroundingContext } from './copilot.types';
import type { ReturnPolicy, ShippingPolicy } from '../policies/policy.types';
import {
  fingerprintEvidence,
  observeEvidence,
  type Claim,
  type ClaimDefectCode,
  type ClaimSet,
  type ClaimValue,
} from './copilot.claims';

const PRODUCT = 'aurora-cup';
const EVENT_ITEM_ID = 'evt-1:aurora-cup';
const EVENT_SOURCE = `event-item:${EVENT_ITEM_ID}`;
const CATALOG_SOURCE = `catalog-product:${PRODUCT}`;
const POLICY_SOURCE = 'policy:seller';
const TRANSCRIPT_SOURCE = 'transcript:t-1';

/** A fixed binding time. Staleness must never depend on the clock — only on whether the fact moved. */
const BOUND_AT_MS = 1_755_000_000_000;

const AUTOMATION_POLICY: CopilotPolicy = {
  automationLevel: 'confirm',
  allowAutoActions: false,
  priceFloorCentsByProduct: { [PRODUCT]: 2_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const RETURNS: ReturnPolicy = {
  accepted: true,
  windowDays: 30,
  returnShipping: 'buyer',
  restockingFeeBps: 0,
  acceptedConditions: ['sealed', 'unused'],
  finalSaleReasons: [],
  warrantyMonths: 12,
};

const SHIPPING: ShippingPolicy = {
  rateMode: 'flat',
  flatRateCents: 700,
  currency: 'USD',
  handlingDays: 1,
  transitDays: { min: 2, max: 5 },
  serviceLevel: 'standard',
  shipsTo: ['US'],
  freeShippingMinimumCents: null,
  insuranceIncluded: false,
};

interface ContextOptions {
  priceCents?: number;
  availableQty?: number;
  onStage?: boolean;
  catalogPriceCents?: number;
  withSellerPolicy?: boolean;
  returnsWindowDays?: number;
}

function context(options: ContextOptions = {}): GroundingContext {
  const {
    priceCents = 2_800,
    availableQty = 12,
    onStage = false,
    catalogPriceCents = 2_800,
    withSellerPolicy = true,
    returnsWindowDays = RETURNS.windowDays,
  } = options;
  return {
    eventItems: [{
      eventItemId: EVENT_ITEM_ID,
      productId: PRODUCT,
      title: 'Aurora ceramic cup',
      description: 'Stoneware cup, glazed',
      priceCents,
      availableQty,
      onStage,
      attributes: { material: 'stoneware', capacity: '12oz' },
    }],
    catalogProducts: [{
      productId: PRODUCT,
      title: 'Aurora ceramic cup',
      description: 'Stoneware cup, glazed',
      priceCents: catalogPriceCents,
      attributes: { material: 'stoneware', capacity: '12oz' },
    }],
    transcriptMoments: [{
      transcriptId: 't-1',
      text: 'This aurora cup is one of my favourites',
      productId: PRODUCT,
      productTitle: 'Aurora ceramic cup',
    }],
    policy: AUTOMATION_POLICY,
    ...(withSellerPolicy
      ? { sellerPolicy: { returns: { ...RETURNS, windowDays: returnsWindowDays }, shipping: SHIPPING } }
      : {}),
    sources: [
      { id: EVENT_SOURCE, kind: 'event-item', label: 'Aurora ceramic cup (this event)' },
      { id: CATALOG_SOURCE, kind: 'catalog-product', label: 'Aurora ceramic cup (catalog)' },
      { id: POLICY_SOURCE, kind: 'policy', label: 'Seller policy' },
      { id: TRANSCRIPT_SOURCE, kind: 'transcript', label: 'Stream moment' },
    ],
  };
}

/**
 * Bind a claim to its evidence AS THE PIPELINE WOULD — by reading the fact out
 * of the bound context and fingerprinting what it actually said.
 *
 * Fixtures never hand-write a fingerprint. A hand-written one can be made to
 * match anything, which would let a case pass while proving nothing; deriving
 * it means a "fresh" case is fresh because the fact genuinely did not move.
 */
function bind(
  claimId: string,
  asserted: ClaimValue,
  sourceIds: readonly string[],
  bound: GroundingContext,
): Claim {
  const evidence = sourceIds.map((sourceId) => {
    const observation = observeEvidence(sourceId, asserted, bound);
    const kind = bound.sources.find((source) => source.id === sourceId)?.kind ?? 'event-item';
    return {
      sourceId,
      kind,
      fingerprint: fingerprintEvidence(
        observation.observed ? observation.value : null,
        BOUND_AT_MS,
      ),
    };
  });
  return { claimId, asserted, evidence };
}

export interface ClaimAdversarialCase extends RehearsalCaseSpec {
  /** The buyer question, which is what relevance is judged against. */
  request: { message: string; requiredProperties?: readonly string[] };
  /** Facts as they stood when the reply was written. */
  bound: GroundingContext;
  /** Facts as they stand when the reply would send. Same object when nothing moved. */
  atSend: GroundingContext;
  claims: ClaimSet;
  expected: {
    supported: boolean;
    /** Every defect code the verdict must contain, and no others. */
    codes: readonly ClaimDefectCode[];
  };
}

function priceQuestion() {
  return { message: 'What is the price?' };
}

export const CLAIM_ADVERSARIAL_CASES: readonly ClaimAdversarialCase[] = (() => {
  const cases: ClaimAdversarialCase[] = [];

  // CONTROL. Without a case that must PASS, every other case here could be
  // green because the verifier rejects everything — which is not a working
  // guard, it is a broken one.
  {
    const bound = context();
    cases.push({
      caseId: 'price-holds-when-nothing-moved',
      title: 'A price the event item still reports',
      expectation: 'The reply sends: the price it states is the price the event item still shows.',
      request: priceQuestion(),
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [bind('c1', { subject: 'price', productId: PRODUCT, priceCents: 2_800 }, [EVENT_SOURCE], bound)],
      },
      expected: { supported: true, codes: [] },
    });
  }

  // The defect that actually reaches buyers: true when written, false when sent.
  {
    const bound = context({ priceCents: 2_800 });
    cases.push({
      caseId: 'price-moved-after-binding',
      title: 'The price changed between drafting and sending',
      expectation: 'The reply is held: it quotes a price that is no longer current.',
      request: priceQuestion(),
      bound,
      atSend: context({ priceCents: 2_400, catalogPriceCents: 2_400 }),
      claims: {
        replyRevision: 1,
        claims: [bind('c1', { subject: 'price', productId: PRODUCT, priceCents: 2_800 }, [EVENT_SOURCE], bound)],
      },
      expected: { supported: false, codes: ['evidence-stale'] },
    });
  }

  {
    const bound = context();
    cases.push({
      caseId: 'price-stated-with-no-source-at-all',
      title: 'A price asserted with no evidence',
      expectation: 'The reply is held: a number with nothing behind it is never sent.',
      request: priceQuestion(),
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{ claimId: 'c1', asserted: { subject: 'price', productId: PRODUCT, priceCents: 1_900 }, evidence: [] }],
      },
      expected: { supported: false, codes: ['evidence-missing'] },
    });
  }

  {
    const bound = context();
    cases.push({
      caseId: 'price-cites-a-source-not-in-the-context',
      title: 'A price citing a source that was never gathered',
      expectation: 'The reply is held: naming a source id is not the same as having the source.',
      request: priceQuestion(),
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{
          claimId: 'c1',
          asserted: { subject: 'price', productId: PRODUCT, priceCents: 2_800 },
          evidence: [{
            sourceId: 'event-item:some-other-event:aurora-cup',
            kind: 'event-item',
            fingerprint: fingerprintEvidence(2_800, BOUND_AT_MS),
          }],
        }],
      },
      expected: { supported: false, codes: ['evidence-missing'] },
    });
  }

  // Both sources can answer, and they disagree. The claim matches ONE of them,
  // which is what makes this dangerous: it looks defensible.
  {
    const bound = context({ priceCents: 2_800, catalogPriceCents: 3_200 });
    cases.push({
      caseId: 'event-and-catalog-prices-disagree',
      title: 'Event price and catalog price disagree',
      expectation: 'The reply is held: the sources do not agree, so the price is not settled.',
      request: priceQuestion(),
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [bind(
          'c1',
          { subject: 'price', productId: PRODUCT, priceCents: 2_800 },
          [EVENT_SOURCE, CATALOG_SOURCE],
          bound,
        )],
      },
      expected: { supported: false, codes: ['evidence-conflicting'] },
    });
  }

  {
    const bound = context({ availableQty: 12 });
    cases.push({
      caseId: 'availability-moved-after-binding',
      title: 'Stock ran out between drafting and sending',
      expectation: 'The reply is held: it promises stock that is gone.',
      // Worded so every meaningful token is one the listing actually covers:
      // relevance is strict by design, and a question the source cannot cover
      // is a DIFFERENT defect (irrelevant) than the one this case is about.
      request: { message: 'How much stock is left?' },
      bound,
      atSend: context({ availableQty: 0 }),
      claims: {
        replyRevision: 1,
        claims: [bind('c1', { subject: 'availability', productId: PRODUCT, availableQty: 12 }, [EVENT_SOURCE], bound)],
      },
      expected: { supported: false, codes: ['evidence-stale'] },
    });
  }

  {
    const bound = context({ availableQty: 3 });
    cases.push({
      caseId: 'listing-state-sold-out-after-binding',
      title: 'The item sold out between drafting and sending',
      expectation: 'The reply is held: it describes the item as still available.',
      request: { message: 'Is it still available?' },
      bound,
      atSend: context({ availableQty: 0 }),
      claims: {
        replyRevision: 1,
        claims: [bind('c1', { subject: 'listing-state', productId: PRODUCT, state: 'listed' }, [EVENT_SOURCE], bound)],
      },
      expected: { supported: false, codes: ['evidence-stale'] },
    });
  }

  // The relevance case: a real, current, cited source that simply cannot speak
  // to the thing being claimed.
  {
    const bound = context();
    cases.push({
      caseId: 'warranty-claim-cites-the-price-source',
      title: 'A warranty claim citing the event listing',
      expectation: 'The reply is held: the listing says nothing about a warranty.',
      request: { message: 'Does it come with a warranty?' },
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{
          claimId: 'c1',
          asserted: { subject: 'catalog-property', productId: PRODUCT, property: 'warranty', value: '2 years' },
          evidence: [{
            sourceId: EVENT_SOURCE,
            kind: 'event-item',
            fingerprint: fingerprintEvidence('2 years', BOUND_AT_MS),
          }],
        }],
      },
      expected: { supported: false, codes: ['evidence-irrelevant'] },
    });
  }

  {
    const bound = context({ withSellerPolicy: false });
    cases.push({
      caseId: 'returns-claim-with-no-policy-gathered',
      title: 'A returns claim when no policy was gathered',
      expectation: 'The reply is held, and the seller is told the policy was never fetched — not that the source is wrong.',
      request: { message: 'Do you accept returns?' },
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{
          claimId: 'c1',
          asserted: { subject: 'returns-policy', field: 'accepted', value: true },
          evidence: [{
            sourceId: POLICY_SOURCE,
            kind: 'policy',
            fingerprint: fingerprintEvidence(true, BOUND_AT_MS),
          }],
        }],
      },
      expected: { supported: false, codes: ['evidence-missing'] },
    });
  }

  {
    const bound = context({ returnsWindowDays: 30 });
    cases.push({
      caseId: 'returns-window-misstated',
      title: 'A returns window the policy does not say',
      // NOT "stale": the policy did not move, the reply simply invented a
      // number. Calling that stale would send the seller to check the clock.
      expectation: 'The reply is held: it states a window no gathered source contains.',
      request: { message: 'How long do I have to return it?' },
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{
          claimId: 'c1',
          asserted: { subject: 'returns-policy', field: 'windowDays', value: 14 },
          evidence: [{
            sourceId: POLICY_SOURCE,
            kind: 'policy',
            fingerprint: fingerprintEvidence(30, BOUND_AT_MS),
          }],
        }],
      },
      expected: { supported: false, codes: ['evidence-missing'] },
    });
  }

  {
    const bound = context();
    cases.push({
      caseId: 'shipping-claim-cites-a-transcript',
      title: 'A shipping claim grounded in something the seller said on stream',
      expectation: 'The reply is held: a stream remark is not the shipping policy.',
      request: { message: 'How much is shipping?' },
      bound,
      atSend: bound,
      claims: {
        replyRevision: 1,
        claims: [{
          claimId: 'c1',
          asserted: { subject: 'shipping-policy', field: 'flatRateCents', value: 0 },
          evidence: [{
            sourceId: TRANSCRIPT_SOURCE,
            kind: 'transcript',
            fingerprint: fingerprintEvidence(0, BOUND_AT_MS),
          }],
        }],
      },
      expected: { supported: false, codes: ['evidence-irrelevant'] },
    });
  }

  // The edited-reply case. The seller keeps a supported claim and adds an
  // unsupported one; revision 2 must be judged as its own text, not inherit
  // revision 1's verdict.
  {
    const bound = context();
    cases.push({
      caseId: 'seller-edit-adds-an-unsupported-promise',
      title: 'A seller edit adds "free returns" to a sound reply',
      expectation: 'The edited reply is held even though the part the model wrote was fine.',
      request: priceQuestion(),
      bound,
      atSend: bound,
      claims: {
        replyRevision: 2,
        claims: [
          bind('c1', { subject: 'price', productId: PRODUCT, priceCents: 2_800 }, [EVENT_SOURCE], bound),
          { claimId: 'c2', asserted: { subject: 'returns-policy', field: 'returnShipping', value: 'seller' }, evidence: [] },
        ],
      },
      expected: { supported: false, codes: ['evidence-missing'] },
    });
  }

  return cases;
})();

/** Every defect code the fixture set exercises — used to prove the set is complete. */
export const EXERCISED_DEFECT_CODES: readonly ClaimDefectCode[] = [
  ...new Set(CLAIM_ADVERSARIAL_CASES.flatMap((entry) => entry.expected.codes)),
];

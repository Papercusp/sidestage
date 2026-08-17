/**
 * The claim/evidence contract (WI-39259 / plan P-003).
 *
 * WHY THIS EXISTS. Until now a grounded reply carried `ModelDraft.citations`:
 * a bare `readonly string[]` of source ids. That records WHICH sources were in
 * the room, not WHAT the reply asserted or whether the assertion still holds.
 * Three things fall out of that gap and all three are buyer-visible:
 *
 *   1. A reply can cite a real source and still state a number that source
 *      never contained.
 *   2. A reply can be correct when generated and WRONG by the time it sends,
 *      because the price/quantity moved in between. Nothing detects that.
 *   3. A seller can edit the reply and there is no way to ask which of the
 *      original assertions survived the edit.
 *
 * A CLAIM closes all three: it names the asserted value, binds it to specific
 * evidence, and fingerprints that evidence so the binding can be re-checked at
 * send time (P-004) instead of trusted from generation time.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. This module decides only whether a claim
 * is SUPPORTED. It never sends, blocks, persists or broadcasts anything — the
 * reply guard/judge/approval seam (P-004) owns enforcement, and the audit store
 * (P-006) owns durability. Keeping the verdict pure is what lets the adversarial
 * fixtures run it with no Nest, no Postgres and no model.
 */

import { canonicalFingerprint } from '../policies/policy-rules';
import { sourceSupportsQuestion } from './copilot.relevance';
import type {
  CopilotRequest,
  GroundingContext,
  GroundingSource,
} from './copilot.types';

/**
 * The five subject areas P-003 names, as one closed set.
 *
 * `listing-state` is DERIVED from facts the domain already stores (see
 * `listingStateOf`) rather than being a new stored enum — there is no listing
 * state column in this codebase and inventing one to satisfy a contract would
 * be a new durable surface where a function does.
 */
export type ClaimSubject =
  | 'price'
  | 'availability'
  | 'listing-state'
  | 'shipping-policy'
  | 'returns-policy'
  | 'catalog-property';

/**
 * What an item's listing state can be, derived from stock + stage presence.
 *
 * Structural on purpose: `EventItemContext` carries `availableQty` and an
 * optional `onStage`, `ActionEventItem` carries both — so one function serves
 * the grounding path and the action path without either importing the other.
 */
export type ListingState = 'on-stage' | 'listed' | 'sold-out';

export function listingStateOf(item: { availableQty: number; onStage?: boolean }): ListingState {
  if (item.availableQty <= 0) return 'sold-out';
  return item.onStage === true ? 'on-stage' : 'listed';
}

/**
 * Why a claim is not supported.
 *
 * These four are kept SEPARATE from `GuardrailCode` on purpose. GuardrailCode
 * describes a policy refusal ("below the price floor"); these describe an
 * evidence defect ("the price moved since we read it"). They answer different
 * questions and a seller-readable message differs accordingly. P-004 maps these
 * onto whatever the enforcement seam surfaces; widening GuardrailCode here
 * would strand its exhaustive consumers for no gain.
 */
export type ClaimDefectCode =
  | 'evidence-missing'
  | 'evidence-irrelevant'
  | 'evidence-stale'
  | 'evidence-conflicting';

/**
 * A hash of the evidence VALUE at the moment a claim was bound to it, plus
 * when that reading was taken.
 *
 * The hash is what makes staleness detectable without keeping a copy of the
 * whole grounding context: re-read the fact now, fingerprint it again, compare.
 * `observedAtMs` is carried for explanation and retention, never for the
 * comparison — an unchanged fact is fresh no matter how old the reading is, and
 * a changed one is stale no matter how recent.
 */
export interface ContextFingerprint {
  value: string;
  observedAtMs: number;
}

export function fingerprintEvidence(value: unknown, observedAtMs: number): ContextFingerprint {
  return { value: canonicalFingerprint(value), observedAtMs };
}

/** One piece of evidence a claim rests on, as it was read at binding time. */
export interface EvidenceRef {
  /** Must appear in `GroundingContext.sources`; the prefixed form relevance uses. */
  sourceId: string;
  kind: GroundingSource['kind'];
  fingerprint: ContextFingerprint;
}

/**
 * The asserted value, discriminated by subject.
 *
 * Every money field is integer cents and every quantity an integer, matching
 * the rest of the domain — a claim that has to be parsed before it can be
 * compared is a claim that will eventually be compared wrongly.
 */
export type ClaimValue =
  | { subject: 'price'; productId: string; priceCents: number }
  | { subject: 'availability'; productId: string; availableQty: number }
  | { subject: 'listing-state'; productId: string; state: ListingState }
  | { subject: 'shipping-policy'; field: string; value: string | number | boolean }
  | { subject: 'returns-policy'; field: string; value: string | number | boolean }
  | {
      subject: 'catalog-property';
      productId: string;
      property: string;
      value: string | number | boolean;
    };

export interface Claim {
  claimId: string;
  asserted: ClaimValue;
  evidence: readonly EvidenceRef[];
}

export interface ClaimDefect {
  claimId: string;
  code: ClaimDefectCode;
  /** Seller-readable, in the register the rehearsal reports use. */
  explanation: string;
}

export interface ClaimVerdict {
  supported: boolean;
  defects: readonly ClaimDefect[];
}

/**
 * A reply plus the claims it makes, at a given revision.
 *
 * `replyRevision` increments on every seller edit. It exists so P-004 can say
 * "these are the claims of the text you are about to send", not "these are the
 * claims of the text the model wrote", which is the distinction an edited reply
 * turns on.
 */
export interface ClaimSet {
  replyRevision: number;
  claims: readonly Claim[];
}

/**
 * What a source could tell us about a claim's subject.
 *
 * Two different failures live here and they earn different seller-facing
 * reasons, so they are not collapsed into one `undefined`:
 *
 *   not-observable — this source CANNOT answer this subject (a transcript
 *                    cannot state a returns window). The citation is wrong.
 *   not-gathered   — this source COULD answer it, but the fact was never
 *                    collected for this turn (no seller policy in grounding).
 *                    The citation is fine; the evidence is absent.
 *
 * Collapsing them was the first draft, and it produced "policy:seller cannot
 * answer your returns policy" for a turn that simply never fetched the policy —
 * a message that sends the seller to fix the wrong thing.
 */
export type EvidenceObservation =
  | { observed: true; value: unknown }
  | { observed: false; reason: 'not-observable' | 'not-gathered' };

const NOT_OBSERVABLE = { observed: false, reason: 'not-observable' } as const;
const NOT_GATHERED = { observed: false, reason: 'not-gathered' } as const;

export function observeEvidence(
  sourceId: string,
  asserted: ClaimValue,
  context: GroundingContext,
): EvidenceObservation {
  if (asserted.subject === 'shipping-policy' || asserted.subject === 'returns-policy') {
    // Policy claims are grounded by the policy source alone, and by the
    // SELLER policy (shipping/returns) — never by `context.policy`, which is
    // the automation policy and knows nothing about either. When no seller
    // policy was gathered for this turn there is genuinely nothing to check
    // against, which is why this returns undefined rather than a default.
    if (!sourceId.startsWith('policy:')) return NOT_OBSERVABLE;
    if (!context.sellerPolicy) return NOT_GATHERED;
    const section = asserted.subject === 'returns-policy'
      ? context.sellerPolicy.returns
      : context.sellerPolicy.shipping;
    const record = section as unknown as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(record, asserted.field)
      ? { observed: true, value: record[asserted.field] }
      : NOT_OBSERVABLE;
  }

  if (sourceId.startsWith('event-item:')) {
    const id = sourceId.slice('event-item:'.length);
    const item = context.eventItems.find((candidate) => candidate.eventItemId === id);
    // Named in sources but absent from the context: the fact was not gathered,
    // not the wrong kind of source to ask.
    if (!item) return NOT_GATHERED;
    if (item.productId !== asserted.productId) return NOT_OBSERVABLE;
    if (asserted.subject === 'price') return { observed: true, value: item.priceCents };
    if (asserted.subject === 'availability') return { observed: true, value: item.availableQty };
    if (asserted.subject === 'listing-state') return { observed: true, value: listingStateOf(item) };
    return Object.prototype.hasOwnProperty.call(item.attributes, asserted.property)
      ? { observed: true, value: item.attributes[asserted.property] }
      : NOT_OBSERVABLE;
  }

  if (sourceId.startsWith('catalog-product:')) {
    const id = sourceId.slice('catalog-product:'.length);
    const product = context.catalogProducts.find((candidate) => candidate.productId === id);
    if (!product) return NOT_GATHERED;
    if (product.productId !== asserted.productId) return NOT_OBSERVABLE;
    if (asserted.subject === 'price') return { observed: true, value: product.priceCents };
    if (asserted.subject === 'catalog-property') {
      return Object.prototype.hasOwnProperty.call(product.attributes, asserted.property)
        ? { observed: true, value: product.attributes[asserted.property] }
        : NOT_OBSERVABLE;
    }
    // A catalog row knows nothing about THIS event's stock or stage presence.
    return NOT_OBSERVABLE;
  }

  return NOT_OBSERVABLE;
}

/** The value the claim itself asserts, in the same shape observeEvidence returns. */
export function assertedValue(asserted: ClaimValue): unknown {
  switch (asserted.subject) {
    case 'price':
      return asserted.priceCents;
    case 'availability':
      return asserted.availableQty;
    case 'listing-state':
      return asserted.state;
    default:
      return asserted.value;
  }
}

function describe(asserted: ClaimValue): string {
  switch (asserted.subject) {
    case 'price':
      return `the price of ${asserted.productId}`;
    case 'availability':
      return `how many of ${asserted.productId} are left`;
    case 'listing-state':
      return `whether ${asserted.productId} is still listed`;
    case 'catalog-property':
      return `${asserted.productId}'s ${asserted.property}`;
    default:
      return `your ${asserted.subject.replace('-policy', '')} policy (${asserted.field})`;
  }
}

/**
 * Re-bind a claim against the CURRENT context — the operation an edited reply
 * needs.
 *
 * Evidence whose source has vanished from the context is dropped rather than
 * carried with a stale fingerprint: a dropped ref surfaces as
 * evidence-missing, which is true, where a retained one would surface as
 * evidence-stale, which is not.
 */
export function rebindClaim(claim: Claim, context: GroundingContext, nowMs: number): Claim {
  const evidence = claim.evidence.flatMap((ref) => {
    const observation = observeEvidence(ref.sourceId, claim.asserted, context);
    if (!observation.observed) return [];
    return [{ ...ref, fingerprint: fingerprintEvidence(observation.value, nowMs) }];
  });
  return { ...claim, evidence };
}

/**
 * Decide whether one claim is supported by the evidence it names.
 *
 * The order of the checks is the point. Missing evidence is reported before
 * relevance, relevance before staleness, and conflict last — so a seller is
 * told the FIRST thing that is wrong rather than a downstream symptom of it.
 * A claim citing a source that is not in the context is not "stale", it is
 * unsupported, and saying "stale" would send the seller looking at the clock.
 */
export function verifyClaim(
  claim: Claim,
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  context: GroundingContext,
): readonly ClaimDefect[] {
  const subject = describe(claim.asserted);
  const known = new Set(context.sources.map((source) => source.id));

  if (claim.evidence.length === 0) {
    return [{
      claimId: claim.claimId,
      code: 'evidence-missing',
      explanation: `Nothing backs up ${subject} — the reply states it with no source.`,
    }];
  }

  const defects: ClaimDefect[] = [];
  const observations: unknown[] = [];
  /** Set when a fact MOVED since binding — the root cause, which suppresses its own symptom below. */
  let drifted = false;

  for (const ref of claim.evidence) {
    if (!known.has(ref.sourceId)) {
      defects.push({
        claimId: claim.claimId,
        code: 'evidence-missing',
        explanation: `${subject} cites ${ref.sourceId}, which is not among the facts gathered for this question.`,
      });
      continue;
    }

    const observation = observeEvidence(ref.sourceId, claim.asserted, context);
    if (!observation.observed) {
      defects.push(observation.reason === 'not-gathered'
        ? {
            claimId: claim.claimId,
            code: 'evidence-missing',
            explanation: `Nothing was gathered about ${subject} for this question, so ${ref.sourceId} has nothing to back it up.`,
          }
        : {
            claimId: claim.claimId,
            code: 'evidence-irrelevant',
            explanation: `${ref.sourceId} cannot answer ${subject}.`,
          });
      continue;
    }
    const observed = observation.value;

    // Policy sources are authoritative by construction and are not matched
    // against the buyer's wording: a returns-window claim is grounded by the
    // policy whether or not the buyer used the word "returns".
    if (!ref.sourceId.startsWith('policy:') && !sourceSupportsQuestion(ref.sourceId, request, context)) {
      defects.push({
        claimId: claim.claimId,
        code: 'evidence-irrelevant',
        explanation: `${ref.sourceId} does not cover what was asked, so it cannot support ${subject}.`,
      });
      continue;
    }

    observations.push(observed);

    // The fact MOVED since it was read. This is the only thing 'stale' means —
    // keeping it that narrow is what makes it actionable ("re-draft, the price
    // changed") instead of a catch-all for every mismatch.
    if (canonicalFingerprint(observed) !== ref.fingerprint.value) {
      drifted = true;
      defects.push({
        claimId: claim.claimId,
        code: 'evidence-stale',
        explanation: `${subject} changed after the reply was written — the draft is out of date.`,
      });
    }
  }

  // Two sources that both cover the subject and disagree. Reported even when
  // the claim matches one of them: picking the convenient source is exactly
  // how a defensible-looking wrong answer reaches a buyer.
  //
  // A disagreement SUBSUMES the asserted-value check below. Running both
  // reported one situation twice under two names — 'conflicting' AND
  // 'stale' — and 'stale' was the wrong one of the two: nothing had moved, the
  // sources simply never agreed. A seller told "out of date" goes looking at
  // the clock instead of at the two prices.
  const distinct = new Set(observations.map((value) => canonicalFingerprint(value)));
  if (distinct.size > 1) {
    defects.push({
      claimId: claim.claimId,
      code: 'evidence-conflicting',
      explanation: `The sources disagree about ${subject}, so the reply cannot state it as settled.`,
    });
    return defects;
  }

  // Fresh, relevant, agreed evidence — that says something else. Nothing is
  // out of date here; there is simply no evidence FOR the stated value, which
  // is what 'missing' means.
  //
  // Suppressed when a fact DRIFTED, for the same reason a conflict suppresses
  // it: "no source says 2800" is the downstream symptom of "the price moved
  // from 2800 to 2400", and reporting both makes the seller fix the symptom.
  // Each code should imply a different action, or the vocabulary is noise.
  const asserted = canonicalFingerprint(assertedValue(claim.asserted));
  if (!drifted && observations.length > 0 && !distinct.has(asserted)) {
    defects.push({
      claimId: claim.claimId,
      code: 'evidence-missing',
      explanation: `The reply states ${subject} as something no gathered source says.`,
    });
  }

  return defects;
}

/**
 * The canonical fingerprint of EVERYTHING one source says, or undefined when
 * that source is not present in the context.
 *
 * This is the claim-free half of the contract, and it exists because the send
 * path needs it TODAY: nothing produces Claim objects yet (ModelDraft carries
 * `citations: string[]`), but "which evidence does this reply rest on" is
 * already answerable from those citations. Fingerprinting a cited source lets
 * the approve path ask "did the evidence THIS reply used move?" without
 * waiting for a claim producer to exist (plan D-010, phase 1).
 */
export function fingerprintSource(
  sourceId: string,
  context: GroundingContext,
): string | undefined {
  if (sourceId.startsWith('event-item:')) {
    const id = sourceId.slice('event-item:'.length);
    const item = context.eventItems.find((candidate) => candidate.eventItemId === id);
    return item ? canonicalFingerprint(item) : undefined;
  }
  if (sourceId.startsWith('catalog-product:')) {
    const id = sourceId.slice('catalog-product:'.length);
    const product = context.catalogProducts.find((candidate) => candidate.productId === id);
    return product ? canonicalFingerprint(product) : undefined;
  }
  if (sourceId.startsWith('transcript:')) {
    const id = sourceId.slice('transcript:'.length);
    const moment = context.transcriptMoments?.find((candidate) => candidate.transcriptId === id);
    return moment ? canonicalFingerprint(moment) : undefined;
  }
  if (sourceId.startsWith('web-research:')) {
    const id = sourceId.slice('web-research:'.length);
    const finding = context.webFindings?.find((candidate) => candidate.findingId === id);
    return finding ? canonicalFingerprint(finding) : undefined;
  }
  if (sourceId.startsWith('policy:')) {
    // Both policies matter to a reply: the automation policy bounds what may be
    // said/done, the seller policy IS the shipping/returns answer.
    return canonicalFingerprint({ policy: context.policy, sellerPolicy: context.sellerPolicy ?? null });
  }
  return undefined;
}

export interface EvidenceDrift {
  sourceId: string;
  code: Extract<ClaimDefectCode, 'evidence-stale' | 'evidence-missing'>;
  explanation: string;
}

/**
 * Which of the sources a reply CITED have moved or vanished between the
 * context it was written against and the context now.
 *
 * The whole point is what it does NOT report: a change to a source the reply
 * never cited is not drift. The previous whole-context comparison blocked a
 * reply about one product because a different product's stock moved, which on
 * a live event is most of the time (plan D-010).
 */
export function citedEvidenceDrift(
  citations: readonly string[],
  before: GroundingContext,
  after: GroundingContext,
): readonly EvidenceDrift[] {
  const label = (sourceId: string): string =>
    before.sources.find((source) => source.id === sourceId)?.label
    ?? after.sources.find((source) => source.id === sourceId)?.label
    ?? sourceId;

  // Return type annotated explicitly: without it TS infers each branch's `code`
  // as its own narrow literal and then cannot union the two array types.
  return citations.flatMap((sourceId): EvidenceDrift[] => {
    const boundTo = fingerprintSource(sourceId, before);
    // Cited something that was not in the original context either — not drift.
    // The reply was unsupported from the start, which is verifyClaims' job to
    // say, not this function's.
    if (boundTo === undefined) return [];

    const current = fingerprintSource(sourceId, after);
    if (current === undefined) {
      return [{
        sourceId,
        code: 'evidence-missing' as const,
        explanation: `${label(sourceId)} is no longer part of this event, and this reply relies on it.`,
      }];
    }
    if (current !== boundTo) {
      return [{
        sourceId,
        code: 'evidence-stale' as const,
        explanation: `${label(sourceId)} changed after this reply was written.`,
      }];
    }
    return [];
  });
}

/** Verify a whole reply's claims. Supported only when EVERY claim holds. */
export function verifyClaims(
  set: ClaimSet,
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  context: GroundingContext,
): ClaimVerdict {
  const defects = set.claims.flatMap((claim) => verifyClaim(claim, request, context));
  return { supported: defects.length === 0, defects };
}

export interface TranscriptProductOption {
  id: string;
  label: string;
  price?: string;
  aliases?: readonly string[];
  brand?: string;
  productType?: string;
  description?: string;
  color?: string;
  sku?: string;
}

export interface TranscriptFocusSegment {
  id: string;
  text: string;
  receivedAt?: number;
}

export interface TranscriptSemanticFocusRequest {
  activeProductId: string | null;
  products: readonly TranscriptProductOption[];
  transcriptWindow: readonly TranscriptFocusSegment[];
  requestSequence: number;
}

export interface TranscriptSemanticFocusResult {
  decision: 'same' | 'different' | 'ambiguous' | 'unknown';
  productId: string | null;
  confidence: number;
  evidenceSegmentIds: string[];
  requestSequence: number;
  source?: 'model' | 'unavailable' | 'error';
}

export type TranscriptProductFocusClassifier = (
  input: TranscriptSemanticFocusRequest,
) => Promise<TranscriptSemanticFocusResult>;

export type TranscriptFocusDecision =
  | {
      kind: 'suggest';
      product: TranscriptProductOption;
      confidence: number;
      evidenceSegmentIds: string[];
      reason: 'explicit-name' | 'explicit-transition' | 'repeated-focus';
      needsSemantic: false;
    }
  | {
      kind: 'none' | 'ambiguous';
      confidence: number;
      evidenceSegmentIds: string[];
      reason:
        | 'empty-context'
        | 'active-product-only'
        | 'no-catalog-signal'
        | 'weak-catalog-signal'
        | 'multiple-products'
        | 'comparison';
      needsSemantic: boolean;
    };

export const TRANSCRIPT_FOCUS_WINDOW_SEGMENTS = 4;
export const PRODUCT_SUGGESTION_TTL_MS = 20_000;
export const PRODUCT_SUGGESTION_DISMISS_COOLDOWN_MS = 45_000;
export const PRODUCT_FOCUS_CONFIDENCE_FLOOR = 0.84;

const TRANSITION_CUES = [
  'move on to',
  'moving on to',
  'switch to',
  'switching to',
  'make active',
  'put on stage',
  'take live',
  'up next',
  'next up',
  'now showing',
  'now let us look at',
  'now lets look at',
  'let us look at',
  'lets look at',
  'want to show',
  'going to show',
] as const;

const COMPARISON_CUES = [
  'compared with',
  'compared to',
  'cheaper than',
  'more than',
  'less than',
  'unlike',
  'versus',
  'vs',
] as const;

export function normalizeTranscriptFocusText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function transcriptFocusWindow(
  segments: readonly TranscriptFocusSegment[],
  maxSegments = TRANSCRIPT_FOCUS_WINDOW_SEGMENTS,
): TranscriptFocusSegment[] {
  return segments
    .filter((segment) => normalizeTranscriptFocusText(segment.text).length > 0)
    .slice(-Math.max(1, maxSegments));
}

interface Mention {
  product: TranscriptProductOption;
  segmentId: string;
  segmentIndex: number;
  term: string;
  strength: number;
  explicitLabel: boolean;
  afterTransition: boolean;
}

interface ProductSignal {
  term: string;
  strength: number;
  explicitLabel: boolean;
}

function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const padded = ` ${text} `;
  return phrases.some((phrase) => padded.includes(` ${phrase} `));
}

function lastTransitionIndex(text: string): number {
  return Math.max(...TRANSITION_CUES.map((cue) => text.lastIndexOf(cue)));
}

function signalTerms(
  product: TranscriptProductOption,
  products: readonly TranscriptProductOption[],
): ProductSignal[] {
  const label = normalizeTranscriptFocusText(product.label);
  const aliases = (product.aliases ?? []).map(normalizeTranscriptFocusText);
  const weak = [product.brand, product.productType, product.color, product.sku]
    .map((value) => normalizeTranscriptFocusText(value ?? ''));
  const allOtherSignals = products
    .filter((candidate) => candidate.id !== product.id)
    .flatMap((candidate) => [
      candidate.label,
      ...(candidate.aliases ?? []),
      candidate.brand,
      candidate.productType,
      candidate.color,
      candidate.sku,
    ])
    .map((value) => normalizeTranscriptFocusText(value ?? ''));

  const signals: ProductSignal[] = [];
  if (label.length >= 2) signals.push({ term: label, strength: 0.98, explicitLabel: true });
  for (const alias of aliases) {
    if (alias.length >= 3 && alias !== label) {
      signals.push({ term: alias, strength: alias.includes(' ') ? 0.92 : 0.86, explicitLabel: false });
    }
  }
  for (const term of weak) {
    if (term.length < 3 || signals.some((signal) => signal.term === term)) continue;
    if (allOtherSignals.includes(term)) continue;
    signals.push({ term, strength: 0.66, explicitLabel: false });
  }
  return signals;
}

function mentionsFor(
  segments: readonly TranscriptFocusSegment[],
  products: readonly TranscriptProductOption[],
): Mention[] {
  return segments.flatMap((segment, segmentIndex) => {
    const normalized = normalizeTranscriptFocusText(segment.text);
    const padded = ` ${normalized} `;
    const transitionIndex = lastTransitionIndex(normalized);
    return products.flatMap((product) => signalTerms(product, products).flatMap((signal) => {
      const matchIndex = padded.indexOf(` ${signal.term} `);
      if (matchIndex < 0) return [];
      return [{
        product,
        segmentId: segment.id,
        segmentIndex,
        term: signal.term,
        strength: signal.strength,
        explicitLabel: signal.explicitLabel,
        afterTransition: transitionIndex >= 0 && matchIndex > transitionIndex,
      } satisfies Mention];
    }));
  });
}

function bestMention(mentions: readonly Mention[]): Mention | null {
  return [...mentions].sort((left, right) => (
    Number(right.afterTransition) - Number(left.afterTransition)
    || right.segmentIndex - left.segmentIndex
    || right.strength - left.strength
    || right.term.length - left.term.length
  ))[0] ?? null;
}

export function findTranscriptProductMention(
  text: string,
  products: readonly TranscriptProductOption[],
): TranscriptProductOption | null {
  return bestMention(mentionsFor([{ id: 'segment', text }], products))?.product ?? null;
}

export function detectTranscriptProductFocus(input: {
  segments: readonly TranscriptFocusSegment[];
  products: readonly TranscriptProductOption[];
  activeProductId: string | null;
}): TranscriptFocusDecision {
  const segments = transcriptFocusWindow(input.segments);
  if (segments.length === 0) {
    return { kind: 'none', confidence: 0, evidenceSegmentIds: [], reason: 'empty-context', needsSemantic: false };
  }

  const normalizedWindow = segments.map((segment) => normalizeTranscriptFocusText(segment.text)).join(' ');
  const hasTransition = containsPhrase(normalizedWindow, TRANSITION_CUES);
  const hasComparison = containsPhrase(normalizedWindow, COMPARISON_CUES);
  const mentions = mentionsFor(segments, input.products);
  const activeMentions = mentions.filter((mention) => mention.product.id === input.activeProductId);
  const alternativeMentions = mentions.filter((mention) => mention.product.id !== input.activeProductId);
  const alternativeIds = [...new Set(alternativeMentions.map((mention) => mention.product.id))];
  const evidenceSegmentIds = [...new Set(mentions.map((mention) => mention.segmentId))];

  if (alternativeIds.length === 0) {
    if (activeMentions.length > 0) {
      return {
        kind: 'none',
        confidence: 1,
        evidenceSegmentIds,
        reason: 'active-product-only',
        needsSemantic: false,
      };
    }
    return {
      kind: 'none',
      confidence: 0,
      evidenceSegmentIds: [],
      reason: 'no-catalog-signal',
      needsSemantic: hasTransition || normalizedWindow.length >= 24,
    };
  }

  const transitionMentions = alternativeMentions.filter((mention) => mention.afterTransition);
  const transitionIds = [...new Set(transitionMentions.map((mention) => mention.product.id))];
  if (transitionIds.length === 1) {
    const mention = bestMention(transitionMentions)!;
    return {
      kind: 'suggest',
      product: mention.product,
      confidence: Math.max(PRODUCT_FOCUS_CONFIDENCE_FLOOR, mention.strength),
      evidenceSegmentIds: [...new Set(transitionMentions.map((candidate) => candidate.segmentId))],
      reason: 'explicit-transition',
      needsSemantic: false,
    };
  }

  if (alternativeIds.length > 1) {
    return {
      kind: 'ambiguous',
      confidence: 0,
      evidenceSegmentIds,
      reason: 'multiple-products',
      needsSemantic: true,
    };
  }

  const candidateMentions = alternativeMentions.filter((mention) => mention.product.id === alternativeIds[0]);
  const mention = bestMention(candidateMentions)!;
  if (activeMentions.length > 0 && (hasComparison || !hasTransition)) {
    return {
      kind: 'ambiguous',
      confidence: 0,
      evidenceSegmentIds,
      reason: 'comparison',
      needsSemantic: true,
    };
  }

  const mentionedAcross = new Set(candidateMentions.map((candidate) => candidate.segmentId)).size;
  if (mention.strength >= PRODUCT_FOCUS_CONFIDENCE_FLOOR) {
    return {
      kind: 'suggest',
      product: mention.product,
      confidence: Math.min(0.99, mention.strength + (mentionedAcross > 1 ? 0.04 : 0)),
      evidenceSegmentIds: [...new Set(candidateMentions.map((candidate) => candidate.segmentId))],
      reason: mentionedAcross > 1 ? 'repeated-focus' : 'explicit-name',
      needsSemantic: false,
    };
  }

  return {
    kind: 'ambiguous',
    confidence: mention.strength,
    evidenceSegmentIds,
    reason: 'weak-catalog-signal',
    needsSemantic: true,
  };
}

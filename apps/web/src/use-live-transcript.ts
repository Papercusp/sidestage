import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createTranscriptionSession,
  type TranscriptSegment,
  type TranscriptionOptions,
  type TranscriptionProvider,
  type TranscriptionSession,
  type TranscriptionState,
} from './transcription';
import {
  detectTranscriptProductFocus,
  findTranscriptProductMention,
  normalizeTranscriptFocusText,
  PRODUCT_FOCUS_CONFIDENCE_FLOOR,
  PRODUCT_SUGGESTION_DISMISS_COOLDOWN_MS,
  PRODUCT_SUGGESTION_TTL_MS,
  transcriptFocusWindow,
  type TranscriptProductFocusClassifier,
  type TranscriptProductOption,
} from './transcript-product-focus';

export { findTranscriptProductMention } from './transcript-product-focus';
export type { TranscriptProductOption } from './transcript-product-focus';

export interface UseLiveTranscriptOptions extends Omit<
  TranscriptionOptions,
  'speechRecognitionFactory' | 'webSocketFactory' | 'mediaRecorderFactory'
> {
  /** An injected session is primarily useful for deterministic tests. */
  session?: TranscriptionSession;
  /** True while a publisher session owns the media stream. */
  active: boolean;
  products?: readonly TranscriptProductOption[];
  activeProductId: string | null;
  onActiveProductChange: (productId: string | null) => void;
  onFinalSegment?: (segment: TranscriptSegment) => void | Promise<void>;
  /** Optional catalog-grounded semantic fallback for unresolved finalized context. */
  classifyProductFocus?: TranscriptProductFocusClassifier;
}

export interface LiveTranscriptController {
  provider: TranscriptionProvider;
  state: TranscriptionState;
  finalSegments: readonly TranscriptSegment[];
  interim: string;
  error: string | null;
  activeProduct: TranscriptProductOption | null;
  suggestedProduct: TranscriptProductOption | null;
  /**
   * Sibling variants of `suggestedProduct` that matched the seller's words
   * equally well — carried through from the detector's `variantChoices` so the
   * surface can OFFER the colourway instead of committing to one the seller
   * never named. Empty when the named product ships in a single variant (or
   * when the suggestion came from the semantic classifier, which resolves to
   * one row by construction), which is the signal to render the plain CTA.
   */
  suggestedVariantChoices?: readonly TranscriptProductOption[];
  suggestionConfidence?: number | null;
  suggestionEvidenceSegmentIds?: readonly string[];
  suggestionExpiresAt?: number | null;
  stageProduct: (productId: string) => void;
  dismissSuggestion: () => void;
}

const EMPTY_PRODUCTS: readonly TranscriptProductOption[] = [];
const MAX_VISIBLE_TRANSCRIPT_SEGMENTS = 200;
const STAGE_CONFIRMATIONS = new Set(['confirm', 'yes', 'stage it', 'do it', 'make active']);

export type TranscriptStageIntent =
  | { kind: 'propose'; product: TranscriptProductOption }
  | { kind: 'confirm'; product: TranscriptProductOption }
  | null;

/** Resolve a final transcript into either a new proposal or confirmation of the pending one. */
export function resolveTranscriptStageIntent(
  text: string,
  products: readonly TranscriptProductOption[],
  pendingProduct: TranscriptProductOption | null,
  activeProductId: string | null = null,
): TranscriptStageIntent {
  const mention = findTranscriptProductMention(text, products);
  if (mention && mention.id !== activeProductId) return { kind: 'propose', product: mention };
  if (pendingProduct && STAGE_CONFIRMATIONS.has(normalizeTranscriptFocusText(text))) {
    return { kind: 'confirm', product: pendingProduct };
  }
  return null;
}

/**
 * Long-lived transcription runtime for the seller Studio.
 *
 * The hook deliberately owns no visible pane. SellerTab mounts it once above
 * desktop/mobile presentation so closing a caption history or switching a
 * responsive surface cannot tear down capture. `active` follows the publisher
 * session: a live media stream starts transcription and its teardown stops it.
 */
export function useLiveTranscript({
  session,
  active,
  products = EMPTY_PRODUCTS,
  activeProductId,
  onActiveProductChange,
  onFinalSegment,
  classifyProductFocus,
  ...options
}: UseLiveTranscriptOptions): LiveTranscriptController {
  const managedSession = useMemo(
    () => session ?? createTranscriptionSession(options),
    [session, options.deepgramToken, options.deepgramTokenProvider, options.fallbackToWebSpeech, options.mediaStream, options.deepgramUrl, options.model, options.language],
  );
  const [state, setState] = useState<TranscriptionState>(managedSession.state);
  const [finalSegments, setFinalSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestedProduct, setSuggestedProduct] = useState<TranscriptProductOption | null>(null);
  const [suggestedVariantChoices, setSuggestedVariantChoices] = useState<readonly TranscriptProductOption[]>(EMPTY_PRODUCTS);
  const [suggestionConfidence, setSuggestionConfidence] = useState<number | null>(null);
  const [suggestionEvidenceSegmentIds, setSuggestionEvidenceSegmentIds] = useState<string[]>([]);
  const [suggestionExpiresAt, setSuggestionExpiresAt] = useState<number | null>(null);

  const productsRef = useRef(products);
  const activeProductIdRef = useRef(activeProductId);
  const onFinalSegmentRef = useRef(onFinalSegment);
  const onActiveProductChangeRef = useRef(onActiveProductChange);
  const classifyProductFocusRef = useRef(classifyProductFocus);
  const suggestedProductRef = useRef<TranscriptProductOption | null>(null);
  const suggestionExpiresAtRef = useRef(0);
  const finalSegmentsRef = useRef<TranscriptSegment[]>([]);
  const classificationSequenceRef = useRef(0);
  const dismissedUntilRef = useRef(new Map<string, number>());
  productsRef.current = products;
  activeProductIdRef.current = activeProductId;
  onFinalSegmentRef.current = onFinalSegment;
  onActiveProductChangeRef.current = onActiveProductChange;
  classifyProductFocusRef.current = classifyProductFocus;

  const clearSuggestion = useCallback(() => {
    suggestedProductRef.current = null;
    suggestionExpiresAtRef.current = 0;
    setSuggestedProduct(null);
    setSuggestedVariantChoices(EMPTY_PRODUCTS);
    setSuggestionConfidence(null);
    setSuggestionEvidenceSegmentIds([]);
    setSuggestionExpiresAt(null);
  }, []);

  const proposeProduct = useCallback((
    product: TranscriptProductOption,
    confidence: number,
    evidenceSegmentIds: readonly string[],
    variantChoices: readonly TranscriptProductOption[] = EMPTY_PRODUCTS,
  ) => {
    const now = Date.now();
    if (product.id === activeProductIdRef.current) return;
    if ((dismissedUntilRef.current.get(product.id) ?? 0) > now) return;
    suggestedProductRef.current = product;
    suggestionExpiresAtRef.current = now + PRODUCT_SUGGESTION_TTL_MS;
    setSuggestedProduct(product);
    setSuggestedVariantChoices(variantChoices.length > 1 ? [...variantChoices] : EMPTY_PRODUCTS);
    setSuggestionConfidence(confidence);
    setSuggestionEvidenceSegmentIds([...evidenceSegmentIds]);
    setSuggestionExpiresAt(suggestionExpiresAtRef.current);
  }, []);

  const stageProduct = useCallback((productId: string) => {
    if (productId === activeProductIdRef.current) {
      clearSuggestion();
      return;
    }
    if (!productsRef.current.some((product) => product.id === productId)) return;
    classificationSequenceRef.current += 1;
    onActiveProductChangeRef.current(productId);
    clearSuggestion();
  }, [clearSuggestion]);

  const dismissSuggestion = useCallback(() => {
    const product = suggestedProductRef.current;
    if (product) dismissedUntilRef.current.set(product.id, Date.now() + PRODUCT_SUGGESTION_DISMISS_COOLDOWN_MS);
    classificationSequenceRef.current += 1;
    clearSuggestion();
  }, [clearSuggestion]);

  useEffect(() => {
    classificationSequenceRef.current += 1;
    clearSuggestion();
  }, [activeProductId, clearSuggestion]);

  useEffect(() => {
    if (suggestionExpiresAt === null) return undefined;
    const delay = Math.max(0, suggestionExpiresAt - Date.now());
    const timeout = setTimeout(clearSuggestion, delay);
    return () => clearTimeout(timeout);
  }, [clearSuggestion, suggestionExpiresAt]);

  useEffect(() => {
    setState(managedSession.state);
    const removeSegment = managedSession.onSegment((segment) => {
      if (!segment.isFinal) {
        setInterim(segment.text);
        return;
      }

      const nextFinalSegments = [...finalSegmentsRef.current, segment].slice(-MAX_VISIBLE_TRANSCRIPT_SEGMENTS);
      finalSegmentsRef.current = nextFinalSegments;
      setFinalSegments(nextFinalSegments);
      setInterim('');
      void onFinalSegmentRef.current?.(segment);

      const now = Date.now();
      const pending = suggestedProductRef.current;
      if (pending && suggestionExpiresAtRef.current > now && STAGE_CONFIRMATIONS.has(normalizeTranscriptFocusText(segment.text))) {
        stageProduct(pending.id);
        return;
      }
      if (pending && suggestionExpiresAtRef.current <= now) clearSuggestion();

      const decision = detectTranscriptProductFocus({
        segments: nextFinalSegments,
        products: productsRef.current,
        activeProductId: activeProductIdRef.current,
      });
      if (decision.kind === 'suggest') {
        classificationSequenceRef.current += 1;
        proposeProduct(decision.product, decision.confidence, decision.evidenceSegmentIds, decision.variantChoices);
        return;
      }
      if (decision.reason === 'active-product-only') {
        classificationSequenceRef.current += 1;
        clearSuggestion();
        return;
      }
      const classifier = classifyProductFocusRef.current;
      if (!decision.needsSemantic || !classifier) return;
      const requestSequence = ++classificationSequenceRef.current;
      const requestActiveProductId = activeProductIdRef.current;
      void classifier({
        activeProductId: requestActiveProductId,
        products: productsRef.current,
        transcriptWindow: transcriptFocusWindow(nextFinalSegments),
        requestSequence,
      }).then((result) => {
        if (classificationSequenceRef.current !== requestSequence) return;
        if (activeProductIdRef.current !== requestActiveProductId) return;
        if (result.requestSequence !== requestSequence || result.decision !== 'different') return;
        if (result.confidence < PRODUCT_FOCUS_CONFIDENCE_FLOOR || !result.productId) return;
        const product = productsRef.current.find((candidate) => candidate.id === result.productId);
        if (!product || product.id === activeProductIdRef.current) return;
        proposeProduct(product, result.confidence, result.evidenceSegmentIds);
      }).catch(() => undefined);
    });
    const removeState = managedSession.onState(setState);
    const removeError = managedSession.onError((next) => setError(next.message));
    return () => {
      removeSegment();
      removeState();
      removeError();
      if (!session) void managedSession.stop();
    };
  }, [clearSuggestion, managedSession, proposeProduct, session, stageProduct]);

  useEffect(() => {
    setError(null);
    if (active) {
      void managedSession.start().catch((next) => {
        setError(next instanceof Error ? next.message : String(next));
      });
    } else {
      classificationSequenceRef.current += 1;
      clearSuggestion();
      void managedSession.stop().catch((next) => {
        setError(next instanceof Error ? next.message : String(next));
      });
      setInterim('');
    }
  }, [active, clearSuggestion, managedSession]);

  return {
    provider: managedSession.provider,
    state,
    finalSegments,
    interim,
    error,
    activeProduct: products.find((product) => product.id === activeProductId) ?? null,
    suggestedProduct,
    suggestedVariantChoices,
    suggestionConfidence,
    suggestionEvidenceSegmentIds,
    suggestionExpiresAt,
    stageProduct,
    dismissSuggestion,
  };
}

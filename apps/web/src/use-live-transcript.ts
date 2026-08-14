import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createTranscriptionSession,
  type TranscriptSegment,
  type TranscriptionOptions,
  type TranscriptionProvider,
  type TranscriptionSession,
  type TranscriptionState,
} from './transcription';

export interface TranscriptProductOption {
  id: string;
  label: string;
  price?: string;
  aliases?: readonly string[];
}

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
}

export interface LiveTranscriptController {
  provider: TranscriptionProvider;
  state: TranscriptionState;
  finalSegments: readonly TranscriptSegment[];
  interim: string;
  error: string | null;
  activeProduct: TranscriptProductOption | null;
  suggestedProduct: TranscriptProductOption | null;
  stageProduct: (productId: string) => void;
  dismissSuggestion: () => void;
}

const EMPTY_PRODUCTS: readonly TranscriptProductOption[] = [];
const MAX_VISIBLE_TRANSCRIPT_SEGMENTS = 200;
const STAGE_CONFIRMATIONS = new Set(['confirm', 'yes', 'stage it', 'do it', 'make active']);

function normalizeMentionText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Find the first catalog item explicitly named in a final transcript segment. */
export function findTranscriptProductMention(
  text: string,
  products: readonly TranscriptProductOption[],
): TranscriptProductOption | null {
  const normalizedText = ` ${normalizeMentionText(text)} `;
  if (normalizedText.trim().length === 0) return null;

  return products.find((product) => [product.label, ...(product.aliases ?? [])].some((term) => {
    const normalizedTerm = normalizeMentionText(term);
    return normalizedTerm.length >= 2 && normalizedText.includes(` ${normalizedTerm} `);
  })) ?? null;
}

export type TranscriptStageIntent =
  | { kind: 'propose'; product: TranscriptProductOption }
  | { kind: 'confirm'; product: TranscriptProductOption }
  | null;

/** Resolve a final transcript into either a new proposal or confirmation of the pending one. */
export function resolveTranscriptStageIntent(
  text: string,
  products: readonly TranscriptProductOption[],
  pendingProduct: TranscriptProductOption | null,
): TranscriptStageIntent {
  const mention = findTranscriptProductMention(text, products);
  if (mention) return { kind: 'propose', product: mention };
  if (pendingProduct && STAGE_CONFIRMATIONS.has(normalizeMentionText(text))) {
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

  const productsRef = useRef(products);
  const onFinalSegmentRef = useRef(onFinalSegment);
  const onActiveProductChangeRef = useRef(onActiveProductChange);
  const suggestedProductRef = useRef<TranscriptProductOption | null>(null);
  productsRef.current = products;
  onFinalSegmentRef.current = onFinalSegment;
  onActiveProductChangeRef.current = onActiveProductChange;

  const clearSuggestion = useCallback(() => {
    suggestedProductRef.current = null;
    setSuggestedProduct(null);
  }, []);

  const stageProduct = useCallback((productId: string) => {
    onActiveProductChangeRef.current(productId);
    clearSuggestion();
  }, [clearSuggestion]);

  useEffect(() => {
    setState(managedSession.state);
    const removeSegment = managedSession.onSegment((segment) => {
      if (!segment.isFinal) {
        setInterim(segment.text);
        return;
      }

      setFinalSegments((current) => [...current, segment].slice(-MAX_VISIBLE_TRANSCRIPT_SEGMENTS));
      setInterim('');
      void onFinalSegmentRef.current?.(segment);

      const intent = resolveTranscriptStageIntent(
        segment.text,
        productsRef.current,
        suggestedProductRef.current,
      );
      if (intent?.kind === 'propose') {
        suggestedProductRef.current = intent.product;
        setSuggestedProduct(intent.product);
      } else if (intent?.kind === 'confirm') {
        stageProduct(intent.product.id);
      }
    });
    const removeState = managedSession.onState(setState);
    const removeError = managedSession.onError((next) => setError(next.message));
    return () => {
      removeSegment();
      removeState();
      removeError();
      if (!session) void managedSession.stop();
    };
  }, [managedSession, session, stageProduct]);

  useEffect(() => {
    setError(null);
    if (active) {
      void managedSession.start().catch((next) => {
        setError(next instanceof Error ? next.message : String(next));
      });
    } else {
      void managedSession.stop().catch((next) => {
        setError(next instanceof Error ? next.message : String(next));
      });
      setInterim('');
    }
  }, [active, managedSession]);

  return {
    provider: managedSession.provider,
    state,
    finalSegments,
    interim,
    error,
    activeProduct: products.find((product) => product.id === activeProductId) ?? null,
    suggestedProduct,
    stageProduct,
    dismissSuggestion: clearSuggestion,
  };
}

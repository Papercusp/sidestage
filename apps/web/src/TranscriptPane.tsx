import { useEffect, useMemo, useState } from 'react';
import {
  createTranscriptionSession,
  type TranscriptSegment,
  type TranscriptionOptions,
  type TranscriptionSession,
  type TranscriptionState,
} from './transcription';

export interface TranscriptPaneProps extends Omit<TranscriptionOptions, 'speechRecognitionFactory' | 'webSocketFactory' | 'mediaRecorderFactory'> {
  session?: TranscriptionSession;
  autoStart?: boolean;
  className?: string;
  products?: readonly TranscriptProductOption[];
  activeProductId?: string | null;
  onActiveProductChange?: (productId: string | null) => void;
  onFinalSegment?: (segment: TranscriptSegment) => void | Promise<void>;
}

export interface TranscriptProductOption {
  id: string;
  label: string;
  aliases?: readonly string[];
}

const EMPTY_PRODUCTS: readonly TranscriptProductOption[] = [];

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

function stateLabel(state: TranscriptionState): string {
  return state === 'listening' ? 'Listening' : state === 'connecting' ? 'Connecting…' : state === 'error' ? 'Needs attention' : 'Ready';
}

/** Seller-facing live transcript surface shared by Deepgram and Web Speech. */
export function TranscriptPane({
  session,
  autoStart = false,
  className,
  products = EMPTY_PRODUCTS,
  activeProductId,
  onActiveProductChange,
  onFinalSegment,
  ...options
}: TranscriptPaneProps) {
  const managedSession = useMemo(
    () => session ?? createTranscriptionSession(options),
    [session, options.deepgramToken, options.deepgramTokenProvider, options.mediaStream, options.deepgramUrl, options.model, options.language],
  );
  const [state, setState] = useState<TranscriptionState>(managedSession.state);
  const [finalSegments, setFinalSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestedProduct, setSuggestedProduct] = useState<TranscriptProductOption | null>(null);
  const [internalActiveProductId, setInternalActiveProductId] = useState<string | null>(null);
  const resolvedActiveProductId = activeProductId === undefined ? internalActiveProductId : activeProductId;
  const activeProduct = products.find((product) => product.id === resolvedActiveProductId) ?? null;

  const selectActiveProduct = (productId: string | null) => {
    if (activeProductId === undefined) setInternalActiveProductId(productId);
    onActiveProductChange?.(productId);
    setSuggestedProduct(null);
  };

  useEffect(() => {
    setState(managedSession.state);
    const removeSegment = managedSession.onSegment((segment) => {
      if (segment.isFinal) {
        setFinalSegments((current) => [...current, segment]);
        void onFinalSegment?.(segment);
        const mention = findTranscriptProductMention(segment.text, products);
        if (mention) setSuggestedProduct(mention);
        setInterim('');
      } else {
        setInterim(segment.text);
      }
    });
    const removeState = managedSession.onState(setState);
    const removeError = managedSession.onError((next) => setError(next.message));
    if (autoStart) void managedSession.start().catch((next) => setError(next instanceof Error ? next.message : String(next)));
    return () => {
      removeSegment();
      removeState();
      removeError();
      if (!session) void managedSession.stop();
    };
  }, [autoStart, managedSession, onFinalSegment, products, session]);

  const toggle = async () => {
    setError(null);
    if (state === 'listening' || state === 'connecting') await managedSession.stop();
    else await managedSession.start();
  };

  return (
    <section className={`transcript-pane${className ? ` ${className}` : ''}`} aria-label="Live transcript">
      <div className="transcript-pane-heading">
        <div>
          <p className="panel-kicker">Live transcript</p>
          <h3>What the room is saying</h3>
        </div>
        <span className={`transcript-state transcript-state-${state}`} aria-live="polite">
          <span aria-hidden="true" /> {stateLabel(state)} · {managedSession.provider === 'deepgram' ? 'Deepgram' : 'Browser'}
        </span>
      </div>
      <div className="transcript-body" aria-live="polite">
        {finalSegments.length === 0 && !interim ? <p className="muted">Start transcription to capture buyer questions and product mentions.</p> : null}
        {finalSegments.map((segment) => <p className="transcript-line" key={segment.id}>{segment.text}</p>)}
        {interim ? <p className="transcript-line transcript-interim">{interim}</p> : null}
      </div>
      {products.length > 0 ? (
        <div className="transcript-product-controls">
          <label className="transcript-picker">
            <span>Active item</span>
            <select aria-label="Active product" value={resolvedActiveProductId ?? ''} onChange={(event) => selectActiveProduct(event.target.value || null)}>
              <option value="">No active item</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.label}</option>)}
            </select>
          </label>
          {activeProduct ? <p className="transcript-active-item">Now guiding replies toward <strong>{activeProduct.label}</strong>.</p> : null}
          {suggestedProduct ? (
            <div className="transcript-suggestion" role="status">
              <span>Mention detected: <strong>{suggestedProduct.label}</strong></span>
              <button className="button secondary" type="button" onClick={() => selectActiveProduct(suggestedProduct.id)}>Make active</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="transcript-error" role="alert">{error}</p> : null}
      <button className="button secondary" type="button" onClick={() => void toggle()}>
        {state === 'listening' || state === 'connecting' ? 'Stop transcription' : 'Start transcription'}
      </button>
    </section>
  );
}

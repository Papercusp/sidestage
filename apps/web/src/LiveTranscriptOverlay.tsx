import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { TranscriptProductOption } from './transcript-product-focus';
import type { LiveTranscriptController } from './use-live-transcript';
import './live-transcript-overlay.css';

export interface LiveTranscriptOverlayProps {
  transcript: LiveTranscriptController;
}

export interface TranscriptOverlaySegment {
  id: string;
  text: string;
  startMs?: number;
}

export interface TranscriptOverlayProduct {
  id: string;
  label: string;
  price?: string;
  /**
   * What distinguishes this row from its siblings — the colourway, else the
   * SKU. Variants of one product SHARE `label` ("Arc Table Lamp" ×4), so
   * `label` cannot name a choice; without this a picker renders as four
   * identical buttons, which is why `variantChoicesOffer` refuses to render
   * one unless every option carries a distinct value here.
   */
  variantLabel?: string;
}

/** Role-neutral transcript data rendered by the shared video engagement surface. */
export interface TranscriptOverlayPresentation {
  state: LiveTranscriptController['state'];
  segments: readonly TranscriptOverlaySegment[];
  interim?: string;
  error?: string | null;
  activeProduct?: TranscriptOverlayProduct | null;
  suggestedProduct?: TranscriptOverlayProduct | null;
  /**
   * Sibling colourways of `suggestedProduct` that matched the seller's words
   * equally well. When present the surface asks WHICH one instead of staging
   * `suggestedProduct` — the seller said "the arc table lamp", not "the sage
   * one", so committing to a colourway would be the surface's guess, not their
   * instruction. `suggestedProduct` stays the preselected default.
   */
  suggestedVariantChoices?: readonly TranscriptOverlayProduct[];
  onStageProduct?: (productId: string) => void;
  onDismissSuggestion?: () => void;
  statusLabel?: string;
  emptyLabel?: string;
}

export interface TranscriptOverlayViewProps {
  transcript: TranscriptOverlayPresentation;
  toolbarActions?: ReactNode;
}

export function liveTranscriptStateLabel(state: LiveTranscriptController['state']): string {
  if (state === 'listening') return 'Captions live';
  if (state === 'connecting') return 'Starting captions…';
  if (state === 'error') return 'Captions need attention';
  return 'Captions start with the event';
}

function segmentTime(startMs: number | undefined): string | null {
  if (startMs === undefined) return null;
  const seconds = Math.max(0, Math.floor(startMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function overlayVariantChoice(product: TranscriptProductOption): TranscriptOverlayProduct {
  return {
    id: product.id,
    label: product.label,
    price: product.price,
    variantLabel: product.color ?? product.sku,
  };
}

/**
 * The colourways to OFFER, or none.
 *
 * Returns the choices only when every one of them can be NAMED distinctly:
 * a picker whose buttons all read "Arc Table Lamp" asks a question the seller
 * cannot answer, and is worse than the single call-to-action it replaced. So a
 * catalog whose variants carry no colour or SKU falls back to the existing
 * behaviour rather than rendering an unusable choice.
 */
export function variantChoicesOffer(
  choices: readonly TranscriptOverlayProduct[] | undefined,
): readonly TranscriptOverlayProduct[] {
  if (!choices || choices.length < 2) return [];
  const names = choices.map((choice) => choice.variantLabel);
  if (!names.every((name): name is string => Boolean(name))) return [];
  return new Set(names).size === names.length ? choices : [];
}

/** Preserve the seller controller as the capture authority while sharing its presentation. */
export function liveTranscriptPresentation(
  transcript: LiveTranscriptController,
): TranscriptOverlayPresentation {
  return {
    state: transcript.state,
    segments: transcript.finalSegments,
    interim: transcript.interim,
    error: transcript.error,
    activeProduct: transcript.activeProduct,
    suggestedProduct: transcript.suggestedProduct,
    suggestedVariantChoices: transcript.suggestedVariantChoices?.map(overlayVariantChoice),
    onStageProduct: transcript.stageProduct,
    onDismissSuggestion: transcript.dismissSuggestion,
  };
}

/** Accessible captions and transcript history shared by seller and buyer video surfaces. */
export function TranscriptOverlayView({ transcript, toolbarActions }: TranscriptOverlayViewProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
  const variantPromptId = useId();
  const historyRef = useRef<HTMLDivElement>(null);
  const variantChoices = variantChoicesOffer(transcript.suggestedVariantChoices);
  const latestFinal = transcript.segments.at(-1)?.text ?? '';
  const caption = transcript.interim || latestFinal;
  const statusLabel = transcript.statusLabel ?? liveTranscriptStateLabel(transcript.state);
  const history = transcript.segments;

  useEffect(() => {
    if (historyOpen && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [historyOpen, history.length, transcript.interim]);

  return (
    <div className="live-transcript-overlay" data-history-open={historyOpen || undefined}>
      {historyOpen ? (
        <div
          ref={historyRef}
          className="live-transcript-history"
          id={historyId}
          role="region"
          aria-label="Transcript history"
          tabIndex={0}
        >
          {history.length === 0 && !transcript.interim ? (
            <p className="live-transcript-empty">
              {transcript.emptyLabel ?? 'Spoken captions will appear when the event starts.'}
            </p>
          ) : null}
          {history.map((segment) => (
            <p className="live-transcript-history-line" key={segment.id}>
              {segmentTime(segment.startMs) ? <time>{segmentTime(segment.startMs)}</time> : null}
              <span>{segment.text}</span>
            </p>
          ))}
          {transcript.interim ? <p className="live-transcript-history-line is-interim"><span>{transcript.interim}</span></p> : null}
        </div>
      ) : null}

      {transcript.suggestedProduct ? (
        <div className="live-transcript-suggestion" role="status">
          {variantChoices.length > 0 ? (
            <div className="live-transcript-variants">
              <span className="live-transcript-variant-prompt" id={variantPromptId}>
                <span aria-hidden="true">✦</span> Which {transcript.suggestedProduct.label}?
              </span>
              <div className="live-transcript-variant-options" role="group" aria-labelledby={variantPromptId}>
                {variantChoices.map((choice) => {
                  const preselected = choice.id === transcript.suggestedProduct!.id;
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      className={`live-transcript-variant${preselected ? ' is-preselected' : ''}`}
                      aria-pressed={preselected}
                      onClick={() => transcript.onStageProduct?.(choice.id)}
                    >
                      <span>{choice.variantLabel}</span>
                      {choice.price ? <strong>{choice.price}</strong> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="live-transcript-mention"
              onClick={() => transcript.onStageProduct?.(transcript.suggestedProduct!.id)}
            >
              <span aria-hidden="true">✦</span>
              <span>Make {transcript.suggestedProduct.label} active</span>
              {transcript.suggestedProduct.price ? <strong>{transcript.suggestedProduct.price}</strong> : null}
            </button>
          )}
          <button type="button" className="live-transcript-dismiss" onClick={transcript.onDismissSuggestion} aria-label="Dismiss product mention">×</button>
        </div>
      ) : null}

      <div className="live-transcript-caption-shell">
        <p className={`live-transcript-caption${transcript.interim ? ' is-interim' : ''}`} aria-live="polite" aria-atomic="true">
          {caption || statusLabel}
        </p>
        <div className="live-transcript-toolbar">
          <span className={`live-transcript-state state-${transcript.state}`}>
            <span aria-hidden="true" /> {statusLabel}
          </span>
          {transcript.activeProduct ? <span className="live-transcript-active">On stage: <strong>{transcript.activeProduct.label}</strong></span> : null}
          <button
            type="button"
            className="live-transcript-history-toggle"
            aria-controls={historyId}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            {historyOpen ? 'Close transcript' : 'Transcript'}
          </button>
          {toolbarActions}
        </div>
      </div>

      {transcript.error ? <p className="live-transcript-error" role="alert">{transcript.error}</p> : null}
    </div>
  );
}

/** Compatibility wrapper for consumers that still render seller captions without chat. */
export function LiveTranscriptOverlay({ transcript }: LiveTranscriptOverlayProps) {
  return <TranscriptOverlayView transcript={liveTranscriptPresentation(transcript)} />;
}

export default LiveTranscriptOverlay;

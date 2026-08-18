import { useId, useMemo } from 'react';
import { formatPrice } from '../event-creation/catalog';
import {
  evaluateMarkdown,
  maxAllowedPercent,
  type MarkdownPolicyView,
} from './markdown-guard';
import './markdown-control.css';

export interface MarkdownControlProps {
  productId: string;
  title: string;
  /** The verified event price the markdown comes off, in integer cents. */
  currentPriceCents: number;
  /**
   * The event policy as `event.config` delivers it. Undefined means it has not
   * loaded: the control then draws NO floor and NO limit rather than implying a
   * guardrail it never read.
   */
  policy?: MarkdownPolicyView | null;
  /** Controlled draft, so the owning surface keeps per-row state as it does today. */
  percent: string;
  onPercentChange: (next: string) => void;
  /**
   * Receives the percent AND the exact price in cents the preview showed. The
   * caller must send this price rather than recomputing one, or the seller is
   * shown a number the action does not carry.
   */
  onApply: (percent: number, priceCents: number) => void;
  disabled?: boolean;
  step?: number;
  /** Label on the apply button; the dock panel words it differently. */
  applyLabel?: string;
}

/** How much of the track sits beyond the stop, so the blocked zone stays visible. */
function trackDomain(stop: number): number {
  return Math.min(100, Math.max(stop * 2, stop + 10));
}

export function MarkdownControl({
  productId,
  title,
  currentPriceCents,
  policy,
  percent,
  onPercentChange,
  onApply,
  disabled = false,
  step = 0.5,
  applyLabel = 'Markdown',
}: MarkdownControlProps) {
  const previewId = useId();
  const draft = percent.trim();
  const parsed = draft === '' ? null : Number(draft);
  const stop = useMemo(
    () => maxAllowedPercent(policy, productId, currentPriceCents, step),
    [currentPriceCents, policy, productId, step],
  );

  const verdict = useMemo(
    () => (parsed === null || !Number.isFinite(parsed)
      ? null
      : evaluateMarkdown({ policy, productId, currentPriceCents, percent: parsed, step })),
    [currentPriceCents, parsed, policy, productId, step],
  );

  const proposedPriceCents = verdict?.proposedPriceCents ?? null;
  const ceiling = stop ?? 100;
  const setPercent = (next: number) => {
    const clamped = Math.min(ceiling, Math.max(0, next));
    onPercentChange(String(Number(clamped.toFixed(4))));
  };
  const current = parsed ?? 0;
  const canDecrease = !disabled && current > 0;
  const canIncrease = !disabled && current < ceiling;
  const sendable = verdict !== null && verdict.sendable && verdict.proposedPriceCents !== null && (parsed ?? 0) > 0;

  const tone = verdict === null
    ? 'idle'
    : verdict.code === 'ok'
      ? 'ok'
      : verdict.code === 'policy-unknown'
        ? 'unknown'
        : 'blocked';

  // With no policy there is no limit to draw. Drawing one anyway is the failure
  // this branch exists to prevent.
  const domain = stop === null ? null : trackDomain(stop);
  const stopAt = domain === null || domain === 0 ? null : Math.min(100, (stop! / domain) * 100);
  const filled = domain === null || domain === 0 ? 0 : Math.min(100, Math.max(0, (current / domain) * 100));

  return (
    <div className={`markdown-control is-${tone}`} data-testid={`markdown-control-${productId}`}>
      <div className="markdown-control-row">
        <button
          className="markdown-control-step"
          type="button"
          aria-label={`Decrease markdown for ${title}`}
          disabled={!canDecrease}
          onClick={() => setPercent(current - step)}
        >
          −
        </button>
        <span className="markdown-control-field">
          <input
            aria-label={`Markdown percent for ${title}`}
            aria-describedby={previewId}
            type="number"
            inputMode="decimal"
            min={0}
            max={ceiling}
            step={step}
            value={percent}
            placeholder="0"
            disabled={disabled}
            onChange={(event) => onPercentChange(event.target.value)}
          />
          <span className="markdown-control-unit" aria-hidden="true">%</span>
        </span>
        <button
          className="markdown-control-step"
          type="button"
          aria-label={`Increase markdown for ${title}`}
          disabled={!canIncrease}
          onClick={() => setPercent(current + step)}
        >
          +
        </button>
        <button
          className="button tertiary markdown-control-apply"
          type="button"
          disabled={disabled || !sendable}
          onClick={() => {
            if (verdict?.proposedPriceCents == null || parsed === null) return;
            onApply(parsed, verdict.proposedPriceCents);
          }}
        >
          {applyLabel}
        </button>
      </div>

      {/*
        * A was→now line is a CLAIM that the price moved. At 0% — the resting
        * state of this control, and what a seller sees most of the time — the
        * proposed price IS the current price, so the old unconditional preview
        * struck through a number and pointed at the same number:
        * "$5843.93 → $5843.93" (WI-39837's sibling, WI-39838). A no-op dressed
        * as a markdown, mid-show, on the seller's own price.
        *
        * So the arrow is drawn only when there is something to point at. The
        * region itself stays mounted and keeps its id + aria-live, because
        * `aria-describedby` on the input targets it and a screen reader needs
        * the same node to announce into when the percent changes.
        */}
      <p className="markdown-control-preview" id={previewId} aria-live="polite">
        {proposedPriceCents === null || proposedPriceCents === currentPriceCents ? (
          <strong className="markdown-control-now">{formatPrice(currentPriceCents)}</strong>
        ) : (
          <>
            <span className="markdown-control-was">{formatPrice(currentPriceCents)}</span>
            <span className="markdown-control-arrow" aria-hidden="true">→</span>
            <strong className="markdown-control-now">{formatPrice(proposedPriceCents)}</strong>
            {verdict?.savingCents ? (
              <span className="markdown-control-saving">save {formatPrice(verdict.savingCents)}</span>
            ) : null}
          </>
        )}
      </p>

      {stopAt === null ? null : (
        <div className="markdown-control-track" aria-hidden="true">
          <span className="markdown-control-allowed" style={{ width: `${stopAt}%` }} />
          <span className="markdown-control-fill" style={{ width: `${filled}%` }} />
          <span className="markdown-control-stop" style={{ left: `${stopAt}%` }} />
        </div>
      )}

      <p className={`markdown-control-note is-${tone}`}>
        {verdict?.message
          ?? (stop === null
            ? 'Event guardrails have not loaded — the server still enforces this markdown.'
            : `Event limit ${stop}%`)}
      </p>
    </div>
  );
}

export default MarkdownControl;

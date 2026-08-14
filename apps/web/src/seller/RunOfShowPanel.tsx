import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import {
  buildRunOfShowView,
  emptyStageLog,
  formatClock,
  formatPace,
  stageLogOnProductChange,
  type RunOfShowPlan,
  type RunOfShowView,
  type StageLog,
} from '../run-of-show';
import { fetchSellerEvent } from '../events/api';
import type { CatalogProduct } from '../seller-products';
import { PricingHistoryPanel } from './PricingHistoryPanel';
import '../run-of-show.css';

/**
 * The live run-of-show panel (plan P-004/P-005).
 *
 * ADVISORY (D-001): a position marker, the staged product's notes, a soft
 * elapsed-vs-budget clock, and the aggregate pacing line. Nothing here blocks
 * or auto-stages; the one action is the next-up button, which stages the
 * planned next product only when the seller taps it.
 */

export interface RunOfShowPanelProps {
  eventId: string;
  /** The product currently on stage, including the live card's commerce detail. */
  activeProduct: CatalogProduct | null;
  /** One-tap advisory staging: the seller chose to follow the plan. */
  onActiveProductChange: (productId: string | null) => void;
  apiBaseUrl?: string;
}

/** Presentational body, exported for markup tests (no fetch, no timers). */
export function RunOfShowPanelView({
  view,
  loaded,
  error,
  onStageNext,
  activeProduct = null,
  pricingHistory = null,
}: {
  view: RunOfShowView;
  loaded: boolean;
  error: string | null;
  onStageNext: (productId: string) => void;
  activeProduct?: CatalogProduct | null;
  pricingHistory?: ReactNode;
}) {
  const {
    slots,
    activeSlot,
    offPlanActive,
    nextUp,
    paceDeltaSec,
    remainingCount,
    totalElapsedSec,
  } = view;
  const completed = slots.filter((slot) => slot.state === 'done');
  const upcoming = slots.filter((slot) => slot.state === 'upcoming');
  const currentTitle = activeProduct?.name ?? activeSlot?.title ?? offPlanActive?.title ?? null;
  const currentProductId = activeSlot?.productId ?? offPlanActive?.productId ?? null;
  const currentProduct = activeProduct?.id === currentProductId ? activeProduct : null;
  const currentClock = activeSlot
    ? `${formatClock(activeSlot.spentSec)}${activeSlot.plannedDurationSec !== null ? ` / ${formatClock(activeSlot.plannedDurationSec)}` : ''}`
    : null;

  return (
    <section className="run-of-show-panel" aria-labelledby="run-of-show-title">
      <header className="run-of-show-header">
        <div className="panel-kicker">Run of show</div>
        <p className="run-of-show-summary">
          <span>{formatClock(totalElapsedSec)} elapsed</span>
          <span aria-hidden="true">·</span>
          <span className="run-of-show-pace">{formatPace(paceDeltaSec, remainingCount)}</span>
        </p>
      </header>

      {error ? <p className="run-of-show-error" role="alert">{error}</p> : null}

      {slots.length === 0 ? (
        <div className="empty-state">
          <h3 id="run-of-show-title">No show plan yet</h3>
          <p>{loaded ? 'Plan the order, timing, and notes in the Event Manager board before going live.' : 'Loading the plan…'}</p>
        </div>
      ) : (
        <>
          <h3 id="run-of-show-title" className="visually-hidden">Run of show</h3>

          {completed.length > 0 ? (
            <details className="run-of-show-completed">
              <summary>{completed.length} completed</summary>
              <ol className="run-of-show-completed-list">
                {completed.map((slot) => (
                  <li key={slot.productId} className="run-of-show-compact-row state-done">
                    <span className="run-of-show-slot-marker" aria-hidden="true">✓</span>
                    <span className="run-of-show-slot-title">{slot.title}</span>
                    <span className="run-of-show-slot-time">{formatClock(slot.spentSec)}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          {currentTitle ? (
            <article className="run-of-show-current-card" aria-current="step" aria-live="polite">
              <div className="run-of-show-timeline-marker state-active">
                <span className="run-of-show-marker-label">Now</span>
                <span className="run-of-show-slot-marker">{activeSlot?.position ?? '•'}</span>
              </div>
              <div className="run-of-show-card">
                <div className="run-of-show-current-head">
                  <div>
                    <strong>{currentTitle}</strong>
                    {currentProduct ? <p>{currentProduct.price} · {currentProduct.stockLabel}</p> : null}
                  </div>
                  {currentClock ? (
                    <span className={activeSlot?.overBudgetSec !== null && (activeSlot?.overBudgetSec ?? 0) > 0 ? 'run-of-show-clock over' : 'run-of-show-clock'}>
                      {currentClock}
                    </span>
                  ) : <span className="run-of-show-off-plan">off plan</span>}
                </div>
                {activeSlot?.notes ? (
                  <p className="run-of-show-notes">{activeSlot.notes}</p>
                ) : offPlanActive ? (
                  <p className="run-of-show-notes muted">Not in the show plan — carry on, the plan picks back up whenever you do.</p>
                ) : (
                  <p className="run-of-show-notes muted">No notes for this product.</p>
                )}
                {pricingHistory}
              </div>
            </article>
          ) : null}

          <ol className="run-of-show-list">
            {upcoming.map((slot) => {
              const isNext = slot.productId === nextUp?.productId;
              return (
                <li key={slot.productId} className={isNext ? 'run-of-show-upcoming state-next' : 'run-of-show-upcoming'}>
                  <div className="run-of-show-timeline-marker">
                    {isNext ? <span className="run-of-show-marker-label">Next</span> : null}
                    <span className="run-of-show-slot-marker">{slot.position}</span>
                  </div>
                  {isNext ? (
                    <div className="run-of-show-card run-of-show-next-card">
                      <div className="run-of-show-compact-row">
                        <span className="run-of-show-slot-title">{slot.title}</span>
                        <span className="run-of-show-slot-time">
                          {slot.plannedDurationSec !== null ? formatClock(slot.plannedDurationSec) : '—'}
                        </span>
                      </div>
                      <button className="button secondary" type="button" onClick={() => onStageNext(slot.productId)}>
                        Take live
                      </button>
                    </div>
                  ) : (
                    <details className="run-of-show-card run-of-show-later-card">
                      <summary className="run-of-show-compact-row">
                        <span className="run-of-show-slot-title">{slot.title}</span>
                        <span className="run-of-show-slot-time">
                          {slot.plannedDurationSec !== null ? formatClock(slot.plannedDurationSec) : '—'}
                        </span>
                      </summary>
                      <p className="run-of-show-notes muted">{slot.notes || 'No notes for this product.'}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export function RunOfShowPanel({ eventId, activeProduct, onActiveProductChange, apiBaseUrl }: RunOfShowPanelProps) {
  const activeProductId = activeProduct?.id ?? null;
  /**
   * The plan rides the audited sync path (sync-contract.test.ts): the server
   * registers `event.runOfShow` and invalidates it on every PUT, so a save in
   * the planner board appears here live with no refetch code of our own.
   */
  const planQuery = useSyncQuery<RunOfShowPlan>({ queryName: 'event.runOfShow', args: { eventId } });
  const entries = useMemo(() => planQuery.data?.[0]?.entries ?? [], [planQuery.data]);

  const [titles, setTitles] = useState<Record<string, string>>({});
  const [log, setLog] = useState<StageLog>(emptyStageLog);
  const [nowMs, setNowMs] = useState(() => Date.now());

  /** Lineup titles: one read through the budgeted events/api transport. */
  useEffect(() => {
    let cancelled = false;
    fetchSellerEvent(eventId, apiBaseUrl)
      .then((event) => {
        if (cancelled) return;
        setTitles(Object.fromEntries(event.items.map((item) => [item.productId, item.title])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventId, apiBaseUrl]);

  const loaded = !planQuery.loading;
  const error = planQuery.error ? 'The show plan could not be loaded.' : null;

  /** Fold stage changes into the log — pure transition, tested in run-of-show.test.ts. */
  useEffect(() => {
    setLog((current) => stageLogOnProductChange(current, activeProductId, Date.now()));
  }, [activeProductId]);

  /** A soft 1s clock, only while something is on stage. */
  useEffect(() => {
    if (!activeProductId) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeProductId]);

  const view = useMemo(
    () => buildRunOfShowView({ entries, titles, log, nowMs }),
    [entries, titles, log, nowMs],
  );

  return (
    <RunOfShowPanelView
      view={view}
      loaded={loaded}
      error={error}
      onStageNext={(productId) => onActiveProductChange(productId)}
      activeProduct={activeProduct}
      pricingHistory={activeProduct ? <PricingHistoryPanel eventId={eventId} productId={activeProduct.id} /> : null}
    />
  );
}

export default RunOfShowPanel;

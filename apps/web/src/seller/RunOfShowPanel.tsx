import { useEffect, useMemo, useState } from 'react';
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
  /** The product currently on stage (App-level selection), or null. */
  activeProductId: string | null;
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
}: {
  view: RunOfShowView;
  loaded: boolean;
  error: string | null;
  onStageNext: (productId: string) => void;
}) {
  const { slots, activeSlot, offPlanActive, nextUp, paceDeltaSec, remainingCount } = view;

  return (
    <section className="run-of-show-panel" aria-labelledby="run-of-show-title">
      <div className="panel-kicker">
        Run of show{' '}
        <span className="panel-status">{formatPace(paceDeltaSec, remainingCount)}</span>
      </div>

      {error ? <p className="run-of-show-error" role="alert">{error}</p> : null}

      {slots.length === 0 ? (
        <div className="empty-state">
          <h3 id="run-of-show-title">No show plan yet</h3>
          <p>{loaded ? 'Plan the order, timing, and notes in the Event Manager board before going live.' : 'Loading the plan…'}</p>
        </div>
      ) : (
        <>
          <h3 id="run-of-show-title" className="visually-hidden">Run of show</h3>

          {activeSlot ? (
            <div className="run-of-show-current" aria-live="polite">
              <div className="run-of-show-current-head">
                <strong>{activeSlot.position}. {activeSlot.title}</strong>
                <span className={activeSlot.overBudgetSec !== null && activeSlot.overBudgetSec > 0 ? 'run-of-show-clock over' : 'run-of-show-clock'}>
                  {formatClock(activeSlot.spentSec)}
                  {activeSlot.plannedDurationSec !== null ? ` / ${formatClock(activeSlot.plannedDurationSec)}` : ''}
                </span>
              </div>
              {activeSlot.notes ? <p className="run-of-show-notes">{activeSlot.notes}</p> : <p className="muted">No notes for this product.</p>}
            </div>
          ) : offPlanActive ? (
            <div className="run-of-show-current" aria-live="polite">
              <div className="run-of-show-current-head">
                <strong>{offPlanActive.title}</strong>
                <span className="run-of-show-off-plan">off plan</span>
              </div>
              <p className="muted">Not in the show plan — carry on, the plan picks back up whenever you do.</p>
            </div>
          ) : null}

          {nextUp ? (
            <div className="run-of-show-next">
              <span>Next up: <strong>{nextUp.title}</strong>{nextUp.plannedDurationSec !== null ? ` · ${formatClock(nextUp.plannedDurationSec)}` : ''}</span>
              <button className="button secondary" type="button" onClick={() => onStageNext(nextUp.productId)}>
                Put on deck
              </button>
            </div>
          ) : null}

          <ol className="run-of-show-list">
            {slots.map((slot) => (
              <li key={slot.productId} className={`run-of-show-slot state-${slot.state}`} aria-current={slot.state === 'active' ? 'step' : undefined}>
                <span className="run-of-show-slot-marker">{slot.state === 'done' ? '✓' : slot.position}</span>
                <span className="run-of-show-slot-title">{slot.title}</span>
                <span className="run-of-show-slot-time">
                  {slot.state === 'upcoming'
                    ? slot.plannedDurationSec !== null ? formatClock(slot.plannedDurationSec) : '—'
                    : formatClock(slot.spentSec)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function RunOfShowPanel({ eventId, activeProductId, onActiveProductChange, apiBaseUrl }: RunOfShowPanelProps) {
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
    />
  );
}

export default RunOfShowPanel;

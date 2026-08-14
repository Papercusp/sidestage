import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import type { RunOfShowEntry, RunOfShowPlan } from '../run-of-show';
import { fetchSellerEvent, saveRunOfShowPlan } from '../events/api';
import '../run-of-show.css';

/**
 * The run-of-show planner (plan P-003): the pre-show authoring surface.
 *
 * The seller orders the lineup, gives each slot a minutes budget, and writes
 * the talking points the live panel will surface when that product goes on
 * stage. Whole-document save (D-003): reorder, edit, and removal are all the
 * same PUT.
 */

export interface RunOfShowPlannerPanelProps {
  eventId: string;
  apiBaseUrl?: string;
}

/** One editable row: entry fields plus the minutes text the seller is typing. */
interface DraftRow {
  productId: string;
  minutes: string;
  notes: string;
}

function toDraft(entry: RunOfShowEntry): DraftRow {
  return {
    productId: entry.productId,
    minutes: entry.plannedDurationSec === null ? '' : String(Math.round(entry.plannedDurationSec / 60)),
    notes: entry.notes,
  };
}

/** '' -> null; a positive number of minutes -> seconds; anything else -> NaN marker. */
function minutesToSeconds(minutes: string): number | null | undefined {
  const trimmed = minutes.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 240) return undefined;
  return Math.round(parsed * 60);
}

/** Presentational body, exported for markup tests. */
export function RunOfShowPlannerView({
  rows,
  titles,
  unplanned,
  status,
  error,
  onMove,
  onRemove,
  onAdd,
  onMinutes,
  onNotes,
  onSave,
}: {
  rows: readonly DraftRow[];
  titles: Readonly<Record<string, string>>;
  unplanned: ReadonlyArray<{ productId: string; title: string }>;
  status: 'idle' | 'saving' | 'saved';
  error: string | null;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAdd: (productId: string) => void;
  onMinutes: (index: number, minutes: string) => void;
  onNotes: (index: number, notes: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="run-of-show-planner" aria-labelledby="run-of-show-planner-title">
      <div className="panel-kicker">
        Run of show <span className="panel-status">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : `${rows.length} planned`}</span>
      </div>
      <h3 id="run-of-show-planner-title">Plan the show</h3>
      <p className="muted">
        Order the lineup, budget minutes per product, and write the notes you want on screen when each
        product is on stage. The plan is a guide — going live never locks you to it.
      </p>

      {error ? <p className="run-of-show-error" role="alert">{error}</p> : null}

      {rows.length === 0 ? (
        <div className="empty-state">
          <h4>Nothing planned yet</h4>
          <p>Add products from the lineup below to build the show order.</p>
        </div>
      ) : (
        <ol className="run-of-show-planner-list">
          {rows.map((row, index) => (
            <li key={row.productId} className="run-of-show-planner-row">
              <div className="run-of-show-planner-row-head">
                <span className="run-of-show-slot-marker">{index + 1}</span>
                <span className="run-of-show-slot-title">{titles[row.productId] ?? row.productId}</span>
                <span className="run-of-show-planner-row-tools">
                  <button type="button" className="button ghost" aria-label={`Move ${titles[row.productId] ?? row.productId} up`} disabled={index === 0} onClick={() => onMove(index, -1)}>↑</button>
                  <button type="button" className="button ghost" aria-label={`Move ${titles[row.productId] ?? row.productId} down`} disabled={index === rows.length - 1} onClick={() => onMove(index, 1)}>↓</button>
                  <button type="button" className="button ghost" aria-label={`Remove ${titles[row.productId] ?? row.productId} from the plan`} onClick={() => onRemove(index)}>✕</button>
                </span>
              </div>
              <label className="run-of-show-planner-minutes">
                Minutes
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={row.minutes}
                  placeholder="—"
                  onChange={(event) => onMinutes(index, event.target.value)}
                />
              </label>
              <label className="run-of-show-planner-notes">
                Notes
                <textarea
                  rows={2}
                  value={row.notes}
                  placeholder="Talking points shown when this product is on stage…"
                  onChange={(event) => onNotes(index, event.target.value)}
                />
              </label>
            </li>
          ))}
        </ol>
      )}

      {unplanned.length > 0 ? (
        <div className="run-of-show-planner-unplanned">
          <h4>In the lineup, not in the plan</h4>
          <ul>
            {unplanned.map((item) => (
              <li key={item.productId}>
                <span>{item.title}</span>
                <button type="button" className="button ghost" onClick={() => onAdd(item.productId)}>Add to plan</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button className="button" type="button" onClick={onSave} disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : 'Save show plan'}
      </button>
    </section>
  );
}

export function RunOfShowPlannerPanel({ eventId, apiBaseUrl }: RunOfShowPlannerPanelProps) {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [lineupIds, setLineupIds] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  /** Stored plan via the audited sync path; seeds the draft once per event. */
  const planQuery = useSyncQuery<RunOfShowPlan>({ queryName: 'event.runOfShow', args: { eventId } });
  const storedPlan = planQuery.data?.[0];
  useEffect(() => {
    if (!storedPlan || seededFor === eventId) return;
    setRows(storedPlan.entries.map(toDraft));
    setSeededFor(eventId);
  }, [storedPlan, seededFor, eventId]);

  /** The save is a useSyncMutate write: optimistic where a mutator exists, REST fallback otherwise. */
  const restSave = useCallback(
    (entries: RunOfShowEntry[]) => saveRunOfShowPlan(eventId, entries, apiBaseUrl),
    [eventId, apiBaseUrl],
  );
  const mutateSave = useSyncMutate<RunOfShowEntry[], RunOfShowPlan>('runOfShow.save', restSave);

  /** Lineup titles through the budgeted events/api transport. */
  useEffect(() => {
    let cancelled = false;
    fetchSellerEvent(eventId, apiBaseUrl)
      .then((event) => {
        if (cancelled) return;
        setTitles(Object.fromEntries(event.items.map((item) => [item.productId, item.title])));
        setLineupIds(event.items.map((item) => item.productId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventId, apiBaseUrl]);

  const unplanned = useMemo(() => {
    const planned = new Set(rows.map((row) => row.productId));
    return lineupIds.filter((id) => !planned.has(id)).map((id) => ({ productId: id, title: titles[id] ?? id }));
  }, [rows, lineupIds, titles]);

  const move = (index: number, direction: -1 | 1) => {
    setStatus('idle');
    setRows((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row!);
      return next;
    });
  };

  const save = async () => {
    const entries: RunOfShowEntry[] = [];
    for (const row of rows) {
      const seconds = minutesToSeconds(row.minutes);
      if (seconds === undefined) {
        setError(`"${titles[row.productId] ?? row.productId}": minutes must be a number between 1 and 240.`);
        return;
      }
      entries.push({ productId: row.productId, plannedDurationSec: seconds, notes: row.notes });
    }
    setStatus('saving');
    setError(null);
    try {
      const saved = await mutateSave(entries);
      setRows(saved.entries.map(toDraft));
      setStatus('saved');
    } catch (cause) {
      setStatus('idle');
      setError(cause instanceof Error ? cause.message : 'The show plan could not be saved.');
    }
  };

  return (
    <RunOfShowPlannerView
      rows={rows}
      titles={titles}
      unplanned={unplanned}
      status={status}
      error={error}
      onMove={move}
      onRemove={(index) => { setStatus('idle'); setRows((current) => current.filter((_, i) => i !== index)); }}
      onAdd={(productId) => { setStatus('idle'); setRows((current) => [...current, { productId, minutes: '', notes: '' }]); }}
      onMinutes={(index, minutes) => { setStatus('idle'); setRows((current) => current.map((row, i) => (i === index ? { ...row, minutes } : row))); }}
      onNotes={(index, notes) => { setStatus('idle'); setRows((current) => current.map((row, i) => (i === index ? { ...row, notes } : row))); }}
      onSave={() => void save()}
    />
  );
}

export default RunOfShowPlannerPanel;

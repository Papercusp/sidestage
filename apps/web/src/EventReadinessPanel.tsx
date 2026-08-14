import { useCallback, useId } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { PreflightReport } from './rehearsals';

export interface EventReadinessViewProps {
  eventId: string;
  report: PreflightReport | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}

function readinessHeadline(report: PreflightReport): string {
  if (report.ready) return 'Ready for this event';
  if (report.blockers > 0) {
    return `${report.blockers} ${report.blockers === 1 ? 'blocker' : 'blockers'} to fix`;
  }
  if (report.unknowns > 0) {
    return `${report.unknowns} ${report.unknowns === 1 ? 'check is' : 'checks are'} still unverified`;
  }
  return `${report.warnings} ${report.warnings === 1 ? 'warning' : 'warnings'} to review`;
}

/**
 * Pure readiness rendering kept separate from the fetch wrapper so the event
 * contract can be verified without pretending an effect ran during SSR.
 */
export function EventReadinessView({
  eventId,
  report,
  loading,
  error,
  onRun,
}: EventReadinessViewProps) {
  const titleId = useId();
  const tone = report?.ready ? 'is-ready' : report ? 'is-blocked' : 'is-pending';

  return (
    <section className={`event-readiness-panel ${tone}`} aria-labelledby={titleId}>
      <header className="event-readiness-heading">
        <div>
          <p className="eyebrow">Current event · preflight</p>
          <h2 id={titleId}>Event readiness</h2>
          <p>
            These checks read this event&apos;s configuration, published policy, and reserved lineup.
          </p>
        </div>
        <button className="button secondary" type="button" onClick={onRun} disabled={loading}>
          {loading ? 'Running event preflight…' : 'Run event preflight'}
        </button>
      </header>

      <div className="event-readiness-context">
        <span>Event</span>
        <code>{eventId}</code>
        <strong role={report?.ready ? 'status' : report ? 'alert' : 'status'}>
          {report ? readinessHeadline(report) : loading ? 'Checking this event…' : 'Not run'}
        </strong>
      </div>

      {error ? <p className="event-readiness-error" role="alert">{error}</p> : null}

      {report ? (
        <ul className="event-readiness-checks">
          {report.checks.map((check) => (
            <li className={`is-${check.status}`} key={check.id}>
              <span aria-hidden="true">
                {check.status === 'ready' ? '✓' : check.status === 'blocker' ? '×' : check.status === 'warning' ? '!' : '·'}
              </span>
              <span>
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
                {check.remedy ? <small className="event-readiness-remedy">Next: {check.remedy}</small> : null}
              </span>
              <em>{check.status}</em>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function EventReadinessPanel({
  eventId,
}: {
  eventId: string;
}) {
  const query = useSyncQuery<PreflightReport>({
    queryName: 'rehearsal.preflight',
    args: { eventId },
    pollIntervalMs: 30_000,
  });
  const report = query.data?.[0] ?? null;
  const run = useCallback(() => query.invalidate(), [query.invalidate]);
  const loading = Boolean(query.loading || query.fetching || (!report && !query.error));

  return (
    <EventReadinessView
      eventId={eventId}
      report={report}
      loading={loading}
      error={query.error?.message ?? null}
      onRun={run}
    />
  );
}

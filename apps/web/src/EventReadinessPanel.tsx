import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { fetchPreflight, type PreflightReport } from './rehearsals';

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
  apiBaseUrl,
}: {
  eventId: string;
  apiBaseUrl?: string;
}) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const run = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const nextReport = await fetchPreflight(eventId, apiBaseUrl);
      if (requestId.current === currentRequest) setReport(nextReport);
    } catch (cause) {
      if (requestId.current !== currentRequest) return;
      setReport(null);
      setError(cause instanceof Error ? cause.message : 'Event preflight could not be reached.');
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [apiBaseUrl, eventId]);

  useEffect(() => {
    void run();
    return () => { requestId.current += 1; };
  }, [run]);

  return (
    <EventReadinessView
      eventId={eventId}
      report={report}
      loading={loading}
      error={error}
      onRun={() => void run()}
    />
  );
}

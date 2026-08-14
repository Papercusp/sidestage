import type { RehearsalHistoryEntry, RehearsalReport } from './rehearsals';

/**
 * One panel shape for every rehearsal.
 *
 * The layout puts the EXPECTATION next to what was OBSERVED for each case. A
 * bare red cross tells a host something is wrong without telling them what was
 * supposed to happen, which is exactly the moment they close the tab and hope.
 */

function deltaLabel(delta: number | null): string | null {
  if (delta === null) return null;
  if (delta === 0) return 'no change since the last run';
  return delta > 0 ? `+${delta} since the last run` : `${delta} since the last run`;
}

export function RehearsalPanel({
  title,
  intro,
  report,
  running,
  error,
  onRun,
  history,
  delta,
  runLabel = 'Run rehearsal',
}: {
  title: string;
  intro: string;
  report: RehearsalReport | null;
  running: boolean;
  error: string | null;
  onRun: () => void;
  history?: readonly RehearsalHistoryEntry[];
  delta?: number | null;
  runLabel?: string;
}) {
  const status = report
    ? (report.passed ? 'Passed' : 'Needs attention')
    : running ? 'Running' : 'Not run';
  const delta_ = deltaLabel(delta ?? null);

  return (
    <section className="rehearsal-panel" aria-labelledby={`rehearsal-${report?.kind ?? title}`}>
      <div className="panel-kicker">
        {title} <span className="panel-status">{status}</span>
      </div>
      <h2 id={`rehearsal-${report?.kind ?? title}`}>{intro}</h2>
      <button className="button secondary" type="button" onClick={onRun} disabled={running}>
        {running ? 'Running…' : runLabel}
      </button>

      {error ? <p className="rehearsal-error" role="alert">{error}</p> : null}

      {report ? (
        <div className="rehearsal-report" aria-live="polite">
          <div className="rehearsal-summary">
            <div>
              <strong className={report.passed ? 'status-success' : 'status-warning'}>
                {report.passedCases}/{report.totalCases}
              </strong>
              <span>checks held</span>
            </div>
            <div><strong>{report.latencyMs}ms</strong><span>run time</span></div>
            {delta_ ? <div><strong>{delta_.split(' ')[0]}</strong><span>{delta_.split(' ').slice(1).join(' ')}</span></div> : null}
          </div>

          {report.caveats?.length ? (
            <ul className="rehearsal-caveats">
              {report.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
            </ul>
          ) : null}

          <div className="rehearsal-case-list">
            {report.cases.map((testCase) => (
              <article className={`rehearsal-case ${testCase.passed ? 'is-passed' : 'is-failed'}`} key={testCase.caseId}>
                <div className="rehearsal-case-heading">
                  <strong>{testCase.title}</strong>
                  <span className={testCase.passed ? 'status-success' : 'status-warning'}>
                    {testCase.passed ? 'Held' : 'Failed'}
                  </span>
                </div>
                <p className="rehearsal-case-expectation">{testCase.expectation}</p>
                <p className="rehearsal-case-observed">{testCase.observed}</p>
                {testCase.evidence ? (
                  <dl className="rehearsal-case-evidence">
                    {Object.entries(testCase.evidence).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            ))}
          </div>

          {history && history.length > 1 ? (
            <details className="rehearsal-history">
              <summary>Previous runs ({history.length - 1})</summary>
              <ul>
                {history.slice(1).map((entry) => (
                  <li key={`${entry.kind}-${entry.ranAt}`}>
                    <span>{new Date(entry.ranAt).toLocaleString()}</span>
                    <strong className={entry.passed ? 'status-success' : 'status-warning'}>
                      {entry.passedCases}/{entry.totalCases}
                    </strong>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

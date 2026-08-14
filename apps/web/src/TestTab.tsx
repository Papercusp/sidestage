import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { fetchCatalog, resolveApiBaseUrl } from './catalog';
import { TabHeader } from './components/TabHeader';
import { browserEventId, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { JUDGE_DIMENSIONS, dimensionLabel, runJudgeRehearsal, scorePercent, type JudgeReport } from './judge';
import { simulateLoad, type LoadSimulationResult } from './load-simulator';
import { RehearsalPanel } from './RehearsalPanel';
import {
  buildReadinessReport,
  fetchPreflight,
  historyDelta,
  readHistory,
  readinessReportFilename,
  recordHistory,
  REHEARSAL_KINDS,
  REHEARSAL_LABELS,
  runDressRehearsal,
  runRehearsal,
  type DressRehearsalVerdict,
  type PreflightReport,
  type RehearsalHistoryEntry,
  type RehearsalKind,
  type RehearsalReport,
} from './rehearsals';

interface PreflightCheck {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'muted' | 'danger';
}

const PREFLIGHT_PENDING: readonly PreflightCheck[] = [
  { label: 'Catalog connection', value: 'Checking…', tone: 'muted' },
  { label: 'Copilot grounding', value: 'Checking…', tone: 'muted' },
  { label: 'Stream input', value: 'Checking…', tone: 'muted' },
  { label: 'Reply approval', value: 'Checking…', tone: 'muted' },
];

/** Real preflight (P-106): every row is a live probe, not a literal. */
async function runPreflight(eventId: string): Promise<PreflightCheck[]> {
  const catalogCheck: PreflightCheck = await fetchCatalog({ pageSize: 1 })
    .then((page) => (page.rows.length > 0
      ? { label: 'Catalog connection', value: page.totalIsFloor ? `${page.total.toLocaleString()}+ products` : `${page.total.toLocaleString()} products`, tone: 'success' as const }
      : { label: 'Catalog connection', value: 'Empty catalog', tone: 'warning' as const }))
    .catch(() => ({ label: 'Catalog connection', value: 'Unreachable', tone: 'danger' as const }));

  const configCheck: PreflightCheck = await fetch(`${resolveApiBaseUrl()}/events/${encodeURIComponent(eventId)}/config`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = (await response.json()) as { policy?: { automationLevel?: string } };
      return config.policy
        ? { label: 'Copilot grounding', value: 'Ready', tone: 'success' as const }
        : { label: 'Copilot grounding', value: 'No policy', tone: 'warning' as const };
    })
    .catch(() => ({ label: 'Copilot grounding', value: 'Unreachable', tone: 'danger' as const }));

  const hasMediaDevice = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  const streamCheck: PreflightCheck = {
    label: 'Stream input',
    value: mediaBaseUrl() ? (hasMediaDevice ? 'Media server configured' : 'No camera access') : 'Not configured',
    tone: mediaBaseUrl() && hasMediaDevice ? 'success' : 'muted',
  };

  const approvalCheck: PreflightCheck = await fetch(`${resolveApiBaseUrl()}/events/${encodeURIComponent(eventId)}/config`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = (await response.json()) as { guardrails?: { priceChanges?: boolean } };
      return config.guardrails?.priceChanges
        ? { label: 'Reply approval', value: 'Required', tone: 'warning' as const }
        : { label: 'Reply approval', value: 'Auto allowed', tone: 'muted' as const };
    })
    .catch(() => ({ label: 'Reply approval', value: 'Unknown', tone: 'muted' as const }));

  return [catalogCheck, configCheck, streamCheck, approvalCheck];
}

/** Written for the host: what this rehearsal is protecting them from. */
const REHEARSAL_INTROS: Record<RehearsalKind, string> = {
  actions: 'Can the copilot be talked into a write it should not make?',
  auction: 'Does the auction hold up when the room bids all at once?',
  checkout: 'Does the money add up, every time?',
  injection: 'What happens when a buyer tries to work the copilot?',
};

type RehearsalState = Partial<Record<RehearsalKind, RehearsalReport>>;
type RehearsalFlags = Partial<Record<RehearsalKind, boolean>>;
type RehearsalErrors = Partial<Record<RehearsalKind, string>>;

export function TestTab() {
  const eventId = browserEventId();
  const [checks, setChecks] = useState<readonly PreflightCheck[]>(PREFLIGHT_PENDING);
  const [eventName, setEventName] = useState<string>(DEFAULT_EVENT_TITLE);
  const refreshPreflight = useCallback(() => {
    void runPreflight(eventId).then(setChecks);
  }, [eventId]);
  useEffect(() => {
    refreshPreflight();
  }, [refreshPreflight]);
  const readyCount = checks.filter((check) => check.tone === 'success').length;

  // ---- Event identity: show the host THEIR event, not a hardcoded example ----
  useEffect(() => {
    let cancelled = false;
    void fetch(`${resolveApiBaseUrl()}/events/${encodeURIComponent(eventId)}/config`)
      .then(async (response) => {
        if (!response.ok) return;
        const config = (await response.json()) as { name?: string };
        if (!cancelled && config.name?.trim()) setEventName(config.name.trim());
      })
      .catch(() => { /* the readiness rows already report an unreachable API */ });
    return () => { cancelled = true; };
  }, [eventId]);

  // ---- Server-side preflight (the config lint) --------------------------------
  const [serverPreflight, setServerPreflight] = useState<PreflightReport | null>(null);
  const [serverPreflightError, setServerPreflightError] = useState<string | null>(null);
  const refreshServerPreflight = useCallback(() => {
    void fetchPreflight(eventId)
      .then((report) => { setServerPreflight(report); setServerPreflightError(null); })
      .catch((error: unknown) => {
        setServerPreflight(null);
        setServerPreflightError(error instanceof Error ? error.message : 'The setup check could not be reached.');
      });
  }, [eventId]);
  useEffect(() => { refreshServerPreflight(); }, [refreshServerPreflight]);

  // ---- Rehearsals -------------------------------------------------------------
  const [reports, setReports] = useState<RehearsalState>({});
  const [running, setRunning] = useState<RehearsalFlags>({});
  const [errors, setErrors] = useState<RehearsalErrors>({});
  const [history, setHistory] = useState<RehearsalHistoryEntry[]>(() => readHistory(eventId));
  const [verdict, setVerdict] = useState<DressRehearsalVerdict | null>(null);
  const [dressRunning, setDressRunning] = useState(false);
  const [dressError, setDressError] = useState<string | null>(null);

  const absorb = useCallback((report: RehearsalReport) => {
    setReports((current) => ({ ...current, [report.kind]: report }));
    setHistory(recordHistory(eventId, report));
  }, [eventId]);

  const runOne = useCallback(async (kind: RehearsalKind) => {
    setRunning((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      absorb(await runRehearsal(kind));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : 'The rehearsal could not be reached.',
      }));
    } finally {
      setRunning((current) => ({ ...current, [kind]: false }));
    }
  }, [absorb]);

  const runDress = useCallback(async () => {
    setDressRunning(true);
    setDressError(null);
    try {
      const result = await runDressRehearsal();
      setVerdict(result);
      result.reports.forEach(absorb);
      refreshServerPreflight();
    } catch (error) {
      setVerdict(null);
      setDressError(error instanceof Error ? error.message : 'The full rehearsal could not be reached.');
    } finally {
      setDressRunning(false);
    }
  }, [absorb, refreshServerPreflight]);

  const readinessReport = useMemo(
    () => buildReadinessReport({ eventId, preflight: serverPreflight, verdict }),
    [eventId, serverPreflight, verdict],
  );

  const downloadReport = useCallback(() => {
    const blob = new Blob([JSON.stringify(readinessReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = readinessReportFilename(eventId, readinessReport.generatedAt);
    link.click();
    URL.revokeObjectURL(url);
  }, [eventId, readinessReport]);
  const [users, setUsers] = useState('3');
  const [messagesPerSecond, setMessagesPerSecond] = useState('2');
  const [durationSeconds, setDurationSeconds] = useState('4');
  const [simulation, setSimulation] = useState<LoadSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [judgeReport, setJudgeReport] = useState<JudgeReport | null>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [judgeRunning, setJudgeRunning] = useState(false);

  const runLoadRehearsal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = simulateLoad({
        users: Number(users),
        messagesPerSecond: Number(messagesPerSecond),
        durationSeconds: Number(durationSeconds),
      });
      setSimulation(result);
      setSimulationError(null);
    } catch (error) {
      setSimulation(null);
      setSimulationError(error instanceof Error ? error.message : 'Enter positive whole numbers for each field.');
    }
  };

  const runJudge = async () => {
    setJudgeRunning(true);
    setJudgeError(null);
    try {
      setJudgeReport(await runJudgeRehearsal(import.meta.env.VITE_API_URL));
    } catch (error) {
      setJudgeReport(null);
      setJudgeError(error instanceof Error ? error.message : 'The reply judge could not be reached.');
    } finally {
      setJudgeRunning(false);
    }
  };

  return (
    <div className="tab-layout density-compact">
      <TabHeader
        eyebrow="Test / launch readiness"
        title="Know before you go live."
        copy="Run a quick rehearsal of the hand-offs that matter. A green check means the seam is ready for a real event."
      />
      <section className="readiness-panel" aria-labelledby="readiness-title">
        <div className="panel-kicker">Preflight <span className="panel-status">{readyCount} of {checks.length} ready</span></div>
        <h2 id="readiness-title">{eventName}</h2>
        <div className="readiness-list">
          {checks.map(({ label, value, tone }) => <div className="readiness-row" key={label}><span>{label}</span><strong className={`status-${tone}`}>{value}</strong></div>)}
        </div>
        <button className="button secondary" type="button" onClick={refreshPreflight}>Re-run preflight</button>
      </section>

      <section className="readiness-panel" aria-labelledby="setup-check-title">
        <div className="panel-kicker">
          Setup check
          <span className="panel-status">
            {serverPreflight
              ? serverPreflight.ready ? 'No blockers'
                : serverPreflight.blockers > 0 ? `${serverPreflight.blockers} blocking`
                  // Not-ready with nothing blocking means something could not be
                  // measured. Saying "0 blocking" here would read as reassurance.
                  : `${serverPreflight.unknowns} unverified`
              : serverPreflightError ? 'Unavailable' : 'Checking…'}
          </span>
        </div>
        <h2 id="setup-check-title">Will your guardrails actually hold?</h2>
        <p className="rehearsal-intro">
          The rehearsals below prove the guard works. This checks the settings it will be working from —
          the part that decides whether the copilot can do its job, or is silently refused all night.
        </p>
        {serverPreflightError ? <p className="rehearsal-error" role="alert">{serverPreflightError}</p> : null}
        {serverPreflight ? (
          <div className="setup-check-list">
            {serverPreflight.checks.map((check) => (
              <div className={`setup-check setup-check-${check.status}`} key={check.id}>
                <div className="setup-check-heading">
                  <strong>{check.label}</strong>
                  <span className={check.status === 'ready' ? 'status-success' : check.status === 'blocker' ? 'status-danger' : 'status-warning'}>
                    {check.status === 'ready' ? 'Ready' : check.status === 'blocker' ? 'Blocking' : check.status === 'warning' ? 'Heads up' : 'Unknown'}
                  </span>
                </div>
                <p>{check.detail}</p>
                {check.remedy ? <p className="setup-check-remedy">{check.remedy}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
        <button className="button secondary" type="button" onClick={refreshServerPreflight}>Re-check setup</button>
      </section>

      <section className="dress-rehearsal-panel" aria-labelledby="dress-title">
        <div className="panel-kicker">
          Full dress rehearsal
          <span className="panel-status">
            {verdict ? (verdict.ready ? 'Ready to go live' : `${verdict.blockers.length} blocking`) : dressRunning ? 'Running' : 'Not run'}
          </span>
        </div>
        <h2 id="dress-title">One button, one answer.</h2>
        <p className="rehearsal-intro">
          Runs every rehearsal below in order and folds the result into a single go / no-go, with the
          blocking list in one place. Nothing here reaches a buyer.
        </p>
        <div className="dress-rehearsal-actions">
          <button className="button primary" type="button" onClick={() => void runDress()} disabled={dressRunning}>
            {dressRunning ? 'Running everything…' : 'Run the full rehearsal'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={downloadReport}
            disabled={!verdict && !serverPreflight}
          >
            Download readiness report
          </button>
        </div>
        {dressError ? <p className="rehearsal-error" role="alert">{dressError}</p> : null}
        {verdict ? (
          <div className="dress-rehearsal-result" aria-live="polite">
            <div className="rehearsal-summary">
              <div>
                <strong className={verdict.ready ? 'status-success' : 'status-warning'}>
                  {verdict.passedCases}/{verdict.totalCases}
                </strong>
                <span>checks held</span>
              </div>
              <div><strong>{verdict.reports.length}</strong><span>rehearsals run</span></div>
            </div>
            {verdict.blockers.length > 0 ? (
              <div className="dress-blockers">
                <div className="rehearsal-section-heading">Fix before going live</div>
                <ul>
                  {verdict.blockers.map((blocker) => (
                    <li key={`${blocker.kind}-${blocker.caseId}`}>
                      <strong>{REHEARSAL_LABELS[blocker.kind]}: {blocker.title}</strong>
                      <span>{blocker.observed}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="dress-ready">Every check held. Nothing is blocking this event.</p>
            )}
            {verdict.caveats.length > 0 ? (
              <ul className="rehearsal-caveats">
                {verdict.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {REHEARSAL_KINDS.map((kind) => (
        <RehearsalPanel
          key={kind}
          title={REHEARSAL_LABELS[kind]}
          intro={REHEARSAL_INTROS[kind]}
          report={reports[kind] ?? null}
          running={running[kind] ?? false}
          error={errors[kind] ?? null}
          onRun={() => void runOne(kind)}
          history={history.filter((entry) => entry.kind === kind)}
          delta={historyDelta(history, kind)}
        />
      ))}
      <section className="load-simulator-panel" aria-labelledby="load-simulator-title">
        <div className="panel-kicker">Load rehearsal <span className="panel-status">{simulation ? 'Completed' : 'Not run'}</span></div>
        <h2 id="load-simulator-title">Pressure-test the copilot seam.</h2>
        <p className="load-simulator-copy">Schedule deterministic websocket-client traffic locally before you open the room. This rehearsal checks the scripted price, shipping, policy, variant, stock, offer, and bid prompts without sending anything to buyers.</p>
        <form className="load-simulator-form" onSubmit={runLoadRehearsal}>
          <div className="load-simulator-fields">
            <label className="field-label" htmlFor="load-users">Simulated users
              <input id="load-users" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={users} onChange={(event) => setUsers(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-messages-per-second">Messages / user / sec
              <input id="load-messages-per-second" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={messagesPerSecond} onChange={(event) => setMessagesPerSecond(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-duration">Duration (seconds)
              <input id="load-duration" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} />
            </label>
          </div>
          <button className="button primary" type="submit">Run load rehearsal</button>
        </form>
        {simulationError ? <p className="load-simulator-error" role="alert">{simulationError}</p> : null}
        {simulation ? (
          <div className="load-simulator-result" aria-live="polite">
            <div className="load-simulator-stats">
              <div><strong>{simulation.totalMessages}</strong><span>scheduled messages</span></div>
              <div><strong>{simulation.clients.length}</strong><span>simulated clients</span></div>
              <div><strong>{simulation.request.durationSeconds}s</strong><span>rehearsal duration</span></div>
            </div>
            <div className="load-coverage">
              <div className="load-coverage-heading"><span>Scripted corpus coverage</span><strong>{simulation.coverage.observedKinds.length}/{simulation.coverage.expectedKinds.length} scenarios</strong></div>
              <div className="load-coverage-list">
                {simulation.coverage.expectedKinds.map((kind) => <span className={'coverage-chip' + (simulation.coverage.observedKinds.includes(kind) ? ' covered' : '')} key={kind}>{kind} · {simulation.coverage.counts[kind] ?? 0}</span>)}
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <section className="judge-panel" aria-labelledby="judge-title">
        <div className="panel-kicker">Reply judge <span className="panel-status">{judgeReport ? (judgeReport.passed ? 'Passed' : 'Needs review') : judgeRunning ? 'Running' : 'Not run'}</span></div>
        <h2 id="judge-title">Grade the copilot before buyers do.</h2>
        <p className="judge-copy">Run the deterministic four-dimension rehearsal against the same grounding, policy, price, and tone seam the API exposes. It stays local to this test surface and sends no reply to buyers.</p>
        <button className="button secondary" type="button" onClick={() => void runJudge()} disabled={judgeRunning}>
          {judgeRunning ? 'Running judge…' : 'Run judge rehearsal'}
        </button>
        {judgeError ? <p className="judge-error" role="alert">{judgeError}</p> : null}
        {judgeReport ? (
          <div className="judge-report" aria-live="polite">
            <div className="judge-report-summary">
              <div><strong>{scorePercent(judgeReport.overallScore)}</strong><span>overall score</span></div>
              <div><strong>{judgeReport.passedCases}/{judgeReport.totalCases}</strong><span>cases passed</span></div>
              <div><strong>{judgeReport.latencyMs}ms</strong><span>judge latency</span></div>
            </div>
            <div className="judge-dimensions">
              <div className="judge-section-heading"><span>Dimension scores</span><strong>Threshold {scorePercent(judgeReport.passThreshold)}</strong></div>
              <div className="judge-dimension-grid">
                {JUDGE_DIMENSIONS.map((dimension) => {
                  const result = judgeReport.dimensions[dimension];
                  return (
                    <div className="judge-dimension" key={dimension}>
                      <span>{dimensionLabel(dimension)}</span>
                      <strong className={result.passed ? 'status-success' : 'status-warning'}>{scorePercent(result.score)}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="judge-case-list">
              {judgeReport.cases.map((testCase) => (
                <article className={`judge-case ${testCase.passed ? 'is-passed' : 'is-failed'}`} key={testCase.caseId}>
                  <div className="judge-case-heading">
                    <div><span className="judge-case-label">{testCase.caseId}</span><strong>{testCase.question}</strong></div>
                    <span className={testCase.passed ? 'status-success' : 'status-warning'}>{scorePercent(testCase.overallScore)} · {testCase.passed ? 'Pass' : 'Review'}</span>
                  </div>
                  <p className="judge-case-reply">“{testCase.reply}”</p>
                  <div className="judge-case-dimensions">
                    {JUDGE_DIMENSIONS.map((dimension) => {
                      const result = testCase.dimensions[dimension];
                      return (
                        <div className="judge-case-dimension" key={dimension}>
                          <span>{dimensionLabel(dimension)}</span>
                          <strong className={result.passed ? 'status-success' : 'status-warning'}>{scorePercent(result.score)}</strong>
                          <small>{result.rationale}</small>
                        </div>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      <div className="test-note"><span className="feature-icon cyan">⌁</span><p>Tip: connect your stream when you are ready. You can still rehearse catalog and copilot flows without a camera.</p></div>
    </div>
  );
}

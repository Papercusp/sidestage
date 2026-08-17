import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRestSyncQuery, useSyncMutate } from '@papercusp/sync';
import { TabHeader } from './components/TabHeader';
import {
  JUDGE_DIMENSIONS,
  dimensionLabel,
  runJudgeRehearsal,
  scorePercent,
  type JudgeReport,
} from './judge';
import { simulateLoad, type LoadSimulationResult } from './load-simulator';
import { RehearsalPanel } from './RehearsalPanel';
import {
  historyDelta,
  readHistory,
  recordHistory,
  REHEARSAL_KINDS,
  REHEARSAL_LABELS,
  runRehearsal,
  type RehearsalHistoryEntry,
  type RehearsalKind,
  type RehearsalReport,
} from './rehearsals';
import './test-workbench.css';

const SYSTEM_TEST_HISTORY_ID = 'synthetic-system-tests';

const REHEARSAL_INTROS: Record<RehearsalKind, string> = {
  actions: 'Can generated instructions bypass an action guard?',
  auction: 'Does the isolated auction service preserve bid invariants?',
  checkout: 'Do generated carts keep totals and shipping deterministic?',
  injection: 'Does hostile generated input stay outside the copilot boundary?',
};

export type SystemTestSuiteId = RehearsalKind | 'load' | 'judge';

export interface SystemTestSuiteDefinition {
  id: SystemTestSuiteId;
  label: string;
  description: string;
}

export const SYSTEM_TEST_SUITE_GROUPS: ReadonlyArray<{
  label: string;
  suites: readonly SystemTestSuiteDefinition[];
}> = [
  {
    label: 'Synthetic capabilities',
    suites: REHEARSAL_KINDS.map((kind) => ({
      id: kind,
      label: REHEARSAL_LABELS[kind],
      description: REHEARSAL_INTROS[kind],
    })),
  },
  {
    label: 'Advanced confidence',
    suites: [
      { id: 'load', label: 'Load simulation', description: 'Generated room pressure' },
      { id: 'judge', label: 'Reply judge', description: 'Grounding, policy, price, tone' },
    ],
  },
];

const SYSTEM_TEST_SUITES = SYSTEM_TEST_SUITE_GROUPS.flatMap((group) => group.suites);

type RehearsalState = Partial<Record<RehearsalKind, RehearsalReport>>;
type RehearsalFlags = Partial<Record<RehearsalKind, boolean>>;
type RehearsalErrors = Partial<Record<RehearsalKind, string>>;

function runTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Run time unavailable'
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function SystemTestsTab() {
  const [activeSuite, setActiveSuite] = useState<SystemTestSuiteId>('actions');
  const [reports, setReports] = useState<RehearsalState>({});
  const [running, setRunning] = useState<RehearsalFlags>({});
  const [errors, setErrors] = useState<RehearsalErrors>({});
  const [history, setHistory] = useState<RehearsalHistoryEntry[]>(
    () => readHistory(SYSTEM_TEST_HISTORY_ID),
  );

  const absorb = useCallback((report: RehearsalReport) => {
    setReports((current) => ({ ...current, [report.kind]: report }));
    setHistory(recordHistory(SYSTEM_TEST_HISTORY_ID, report));
  }, []);

  const runRehearsalFallback = useCallback(
    async (kind: RehearsalKind) => runRehearsal(kind),
    [],
  );
  const mutateRehearsal = useSyncMutate<RehearsalKind, RehearsalReport>(
    'rehearsal.run',
    runRehearsalFallback,
  );

  const runOne = useCallback(async (kind: RehearsalKind) => {
    setRunning((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      absorb(await mutateRehearsal(kind));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [kind]: cause instanceof Error ? cause.message : 'The synthetic suite could not be reached.',
      }));
    } finally {
      setRunning((current) => ({ ...current, [kind]: false }));
    }
  }, [absorb, mutateRehearsal]);

  const [users, setUsers] = useState('3');
  const [messagesPerSecond, setMessagesPerSecond] = useState('2');
  const [durationSeconds, setDurationSeconds] = useState('4');
  const [simulation, setSimulation] = useState<LoadSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  const runLoadSimulation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setSimulation(simulateLoad({
        users: Number(users),
        messagesPerSecond: Number(messagesPerSecond),
        durationSeconds: Number(durationSeconds),
      }));
      setSimulationError(null);
    } catch (cause) {
      setSimulation(null);
      setSimulationError(cause instanceof Error ? cause.message : 'Enter positive whole numbers for each field.');
    }
  };

  const [judgeReport, setJudgeReport] = useState<JudgeReport | null>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [judgeRunning, setJudgeRunning] = useState(false);
  const judgeQuery = useRestSyncQuery<JudgeReport>({
    queryName: 'judge.latest',
    pollIntervalMs: 60_000,
  });
  const runJudgeFallback = useCallback(
    async (_input: Record<string, never>) => runJudgeRehearsal(import.meta.env.VITE_API_URL),
    [],
  );
  const mutateJudge = useSyncMutate<Record<string, never>, JudgeReport>('judge.run', runJudgeFallback);

  useEffect(() => {
    const latest = judgeQuery.data?.[0];
    if (latest) setJudgeReport(latest);
  }, [judgeQuery.data]);

  const runJudge = async () => {
    setJudgeRunning(true);
    setJudgeError(null);
    try {
      setJudgeReport(await mutateJudge({}));
      judgeQuery.invalidate();
    } catch (cause) {
      setJudgeReport(null);
      setJudgeError(cause instanceof Error ? cause.message : 'The reply judge could not be reached.');
    } finally {
      setJudgeRunning(false);
    }
  };

  const suiteCount = (suite: SystemTestSuiteId): string => {
    if (suite === 'load') return simulation ? String(simulation.coverage.observedKinds.length) : '—';
    if (suite === 'judge') return judgeReport ? `${judgeReport.passedCases}/${judgeReport.totalCases}` : '—';
    const report = reports[suite];
    return report ? `${report.passedCases}/${report.totalCases}` : '—';
  };
  const activeDefinition = SYSTEM_TEST_SUITES.find((suite) => suite.id === activeSuite)
    ?? SYSTEM_TEST_SUITES[0]!;
  const anySuiteRunning = judgeRunning || Object.values(running).some(Boolean);

  return (
    <div className="tab-layout density-compact test-page system-tests-page">
      <TabHeader
        eyebrow="Synthetic system verification"
        title="Tests"
        copy="Exercise isolated service capabilities with generated inputs, without attaching the run to a live event."
      />

      <section className="test-launch-card is-ready" aria-labelledby="system-tests-isolation-title">
        <div>
          <div className="test-launch-status">
            <span className="test-status-pill is-ready">Isolated by design</span>
            <span>Generated inputs only</span>
          </div>
          <h2 id="system-tests-isolation-title">Safe to run away from the selling floor.</h2>
          <p>
            These synthetic suites do not use the live event, real buyers, real orders, or reserved inventory.
            Event configuration and go-live readiness now live in Studio.
          </p>
        </div>
        <div className="test-event-identity">
          <span>Scope</span>
          <strong>System capability</strong>
          <code>synthetic / no-event</code>
        </div>
      </section>

      <section className="test-workbench" aria-label="Synthetic system test workbench">
        <aside className="test-suite-rail" aria-label="System test suites">
          <div className="test-suite-rail-head">
            <strong>System test suites</strong>
            <span className="test-count-badge">{SYSTEM_TEST_SUITES.length}</span>
          </div>
          <label className="test-mobile-suite-picker">
            <span>Choose test suite</span>
            <select
              aria-label="Choose test suite"
              value={activeSuite}
              onChange={(event) => setActiveSuite(event.target.value as SystemTestSuiteId)}
            >
              {SYSTEM_TEST_SUITES.map((suite) => (
                <option value={suite.id} key={suite.id}>{suite.label}</option>
              ))}
            </select>
          </label>
          <div className="test-desktop-suite-groups">
            {SYSTEM_TEST_SUITE_GROUPS.map((group) => (
              <div className="test-suite-group" key={group.label}>
                <div className="test-suite-group-label">
                  <span>{group.label}</span>
                  <span>{group.suites.length}</span>
                </div>
                <nav aria-label={`${group.label} suites`}>
                  {group.suites.map((suite) => (
                    <button
                      className={`test-suite-button${activeSuite === suite.id ? ' is-active' : ''}`}
                      type="button"
                      aria-current={activeSuite === suite.id ? 'page' : undefined}
                      onClick={() => setActiveSuite(suite.id)}
                      key={suite.id}
                    >
                      <span>
                        <strong>{suite.label}</strong>
                        <small>{suite.description}</small>
                      </span>
                      <span className="test-suite-count">{suiteCount(suite.id)}</span>
                    </button>
                  ))}
                </nav>
              </div>
            ))}
          </div>
          <section className="test-run-timeline" aria-labelledby="system-test-runs-title" aria-live="polite">
            <div className="test-run-timeline-head">
              <strong id="system-test-runs-title">Synthetic runs</strong>
              {anySuiteRunning ? <span>Running now</span> : null}
            </div>
            {history.length ? (
              <ol>
                {history.slice(0, 4).map((entry) => (
                  <li key={`${entry.kind}-${entry.ranAt}`}>
                    <span className={entry.passed ? 'is-passed' : 'is-failed'} aria-hidden="true">
                      {entry.passed ? '✓' : '×'}
                    </span>
                    <span>
                      <strong>{REHEARSAL_LABELS[entry.kind]}</strong>
                      <time dateTime={entry.ranAt}>{runTimestamp(entry.ranAt)}</time>
                    </span>
                    <small>{entry.passedCases}/{entry.totalCases}</small>
                  </li>
                ))}
              </ol>
            ) : <p>Run a suite to build synthetic evidence.</p>}
          </section>
        </aside>

        <div className="test-workbench-main">
          <header className="test-active-suite-head">
            <div>
              <div className="test-active-suite-meta">
                <span className="test-status-pill is-ready">No live data</span>
                <span>{suiteCount(activeSuite)} checks</span>
                <span>{anySuiteRunning ? 'Evidence updating' : 'Ready to run'}</span>
              </div>
              <h2>{activeDefinition.label}</h2>
              <p>{activeDefinition.description}</p>
            </div>
          </header>

          {REHEARSAL_KINDS.map((kind) => (
            <div className="test-suite-panel" hidden={activeSuite !== kind} key={kind}>
              <RehearsalPanel
                title={REHEARSAL_LABELS[kind]}
                intro={REHEARSAL_INTROS[kind]}
                report={reports[kind] ?? null}
                running={running[kind] ?? false}
                error={errors[kind] ?? null}
                onRun={() => void runOne(kind)}
                history={history.filter((entry) => entry.kind === kind)}
                delta={historyDelta(history, kind)}
                runLabel="Run synthetic suite"
              />
            </div>
          ))}

          <section className="test-suite-panel" hidden={activeSuite !== 'load'} aria-label="Load simulation">
            <section className="load-simulator-panel" aria-labelledby="system-load-title">
              <div className="panel-kicker">
                Load simulation <span className="panel-status">{simulation ? 'Completed' : 'Not run'}</span>
              </div>
              <h2 id="system-load-title">Pressure-test the copilot seam.</h2>
              <p className="load-simulator-copy">
                Schedule deterministic generated traffic locally. No live room is joined and no buyer receives a message.
              </p>
              <form className="load-simulator-form" onSubmit={runLoadSimulation}>
                <div className="load-simulator-fields">
                  <label className="field-label" htmlFor="system-load-users">Simulated users
                    <input id="system-load-users" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={users} onChange={(event) => setUsers(event.target.value)} />
                  </label>
                  <label className="field-label" htmlFor="system-load-rate">Messages / user / sec
                    <input id="system-load-rate" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={messagesPerSecond} onChange={(event) => setMessagesPerSecond(event.target.value)} />
                  </label>
                  <label className="field-label" htmlFor="system-load-duration">Duration (seconds)
                    <input id="system-load-duration" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} />
                  </label>
                </div>
                <button className="button primary" type="submit">Run load simulation</button>
              </form>
              {simulationError ? <p className="load-simulator-error" role="alert">{simulationError}</p> : null}
              {simulation ? (
                <div className="load-simulator-result" aria-live="polite">
                  <div className="load-simulator-stats">
                    <div><strong>{simulation.totalMessages}</strong><span>generated messages</span></div>
                    <div><strong>{simulation.clients.length}</strong><span>simulated clients</span></div>
                    <div><strong>{simulation.request.durationSeconds}s</strong><span>duration</span></div>
                  </div>
                </div>
              ) : null}
            </section>
          </section>

          <section className="test-suite-panel" hidden={activeSuite !== 'judge'} aria-label="Reply judge">
            <section className="judge-panel" aria-labelledby="system-judge-title">
              <div className="panel-kicker">
                Reply judge <span className="panel-status">{judgeReport ? (judgeReport.passed ? 'Passed' : 'Needs review') : judgeRunning ? 'Running' : 'Not run'}</span>
              </div>
              <h2 id="system-judge-title">Grade generated replies in isolation.</h2>
              <p className="judge-copy">
                Score deterministic generated cases against grounding, policy, price, and tone. No reply is sent to a buyer.
              </p>
              <button className="button secondary" type="button" onClick={() => void runJudge()} disabled={judgeRunning}>
                {judgeRunning ? 'Running judge…' : 'Run reply judge'}
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
                </div>
              ) : null}
            </section>
          </section>
        </div>
      </section>
    </div>
  );
}

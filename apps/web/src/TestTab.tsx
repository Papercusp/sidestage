import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRestSyncQuery, useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import { fetchCatalog } from './catalog';
import { TabHeader } from './components/TabHeader';
import { browserEventId, DEFAULT_EVENT_TITLE } from './event-identity';
import { JUDGE_DIMENSIONS, dimensionLabel, runJudgeRehearsal, scorePercent, type JudgeReport } from './judge';
import { simulateLoad, type LoadSimulationResult } from './load-simulator';
import { RehearsalPanel } from './RehearsalPanel';
import { tabHref } from './app-routing';
import {
  buildReadinessReport,
  historyDelta,
  readHistory,
  readinessReportFilename,
  recordHistory,
  REHEARSAL_KINDS,
  REHEARSAL_LABELS,
  runClientPreflight,
  runDressRehearsal,
  runRehearsal,
  type ClientPreflightReport,
  type DressRehearsalVerdict,
  type PreflightReport,
  type RehearsalHistoryEntry,
  type RehearsalKind,
  type RehearsalReport,
} from './rehearsals';
import './test-workbench.css';

interface PreflightCheck {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'muted' | 'danger';
}

const PREFLIGHT_PENDING: readonly PreflightCheck[] = [
  { label: 'Catalog connection', value: 'Checking…', tone: 'muted' },
  { label: 'Copilot grounding', value: 'Checking…', tone: 'muted' },
  { label: 'Reply approval', value: 'Checking…', tone: 'muted' },
];

export interface EventConfigRead {
  name?: string;
  updatedAt?: string;
  policy?: { automationLevel?: string };
  guardrails?: { priceChanges?: boolean };
}

export function configPreflightChecks(
  config: EventConfigRead | null,
  unavailable: boolean,
): readonly [PreflightCheck, PreflightCheck] {
  const configCheck: PreflightCheck = config
    ? config.policy
      ? { label: 'Copilot grounding', value: 'Ready', tone: 'success' }
      : { label: 'Copilot grounding', value: 'No policy', tone: 'warning' }
    : unavailable
      ? { label: 'Copilot grounding', value: 'Unreachable', tone: 'danger' }
      : { label: 'Copilot grounding', value: 'Checking…', tone: 'muted' };
  const approvalCheck: PreflightCheck = config
    ? config.guardrails?.priceChanges
      ? { label: 'Reply approval', value: 'Required', tone: 'warning' }
      : { label: 'Reply approval', value: 'Auto allowed', tone: 'muted' }
    : unavailable
      ? { label: 'Reply approval', value: 'Unknown', tone: 'muted' }
      : { label: 'Reply approval', value: 'Checking…', tone: 'muted' };
  return [configCheck, approvalCheck];
}

/** Real preflight (P-106): every row is a live probe, not a literal. */
async function runPreflight(config: EventConfigRead | null, configUnavailable: boolean): Promise<PreflightCheck[]> {
  const catalogCheck: PreflightCheck = await fetchCatalog({ pageSize: 1 })
    .then((page) => (page.rows.length > 0
      ? { label: 'Catalog connection', value: page.totalIsFloor ? `${page.total.toLocaleString()}+ products` : `${page.total.toLocaleString()} products`, tone: 'success' as const }
      : { label: 'Catalog connection', value: 'Empty catalog', tone: 'warning' as const }))
    .catch(() => ({ label: 'Catalog connection', value: 'Unreachable', tone: 'danger' as const }));

  const [configCheck, approvalCheck] = configPreflightChecks(config, configUnavailable);

  return [catalogCheck, configCheck, approvalCheck];
}

/** Written for the host: what this rehearsal is protecting them from. */
const REHEARSAL_INTROS: Record<RehearsalKind, string> = {
  actions: 'Can the copilot be talked into a write it should not make?',
  auction: 'Does the auction hold up when the room bids all at once?',
  checkout: 'Does the money add up, every time?',
  injection: 'What happens when a buyer tries to work the copilot?',
};

type TestSuiteId = 'preflight' | 'full' | 'failed' | RehearsalKind | 'load' | 'judge';

interface TestSuiteDefinition {
  id: TestSuiteId;
  label: string;
  description: string;
}

export const TEST_SUITE_GROUPS: ReadonlyArray<{
  label: string;
  suites: readonly TestSuiteDefinition[];
}> = [
  {
    label: 'Go live',
    suites: [
      { id: 'preflight', label: 'Preflight', description: 'Required configuration' },
      { id: 'full', label: 'Full rehearsal', description: 'One launch verdict' },
      { id: 'failed', label: 'Failed only', description: 'Fast corrective loop' },
    ],
  },
  {
    label: 'Capabilities',
    suites: REHEARSAL_KINDS.map((kind) => ({
      id: kind,
      label: REHEARSAL_LABELS[kind],
      description: REHEARSAL_INTROS[kind],
    })),
  },
  {
    label: 'Advanced confidence',
    suites: [
      { id: 'load', label: 'Load rehearsal', description: 'Deterministic room pressure' },
      { id: 'judge', label: 'Reply judge', description: 'Grounding, policy, price, tone' },
    ],
  },
];

export interface LaunchSummary {
  ready: boolean;
  label: 'Ready to go live' | 'Not ready';
  blockers: number;
  unverified: number;
}

/** A launch is green only after both setup probes and the full rehearsal ran and passed. */
export function buildLaunchSummary(input: {
  serverPreflight: PreflightReport | null;
  clientPreflight: ClientPreflightReport | null;
  verdict: DressRehearsalVerdict | null;
}): LaunchSummary {
  const blockers = (input.serverPreflight?.blockers ?? 0)
    + (input.clientPreflight?.blockers ?? 0)
    + (input.verdict?.blockers.length ?? 0);
  const unverified = (input.serverPreflight?.unknowns ?? Number(!input.serverPreflight))
    + (input.clientPreflight?.unknowns ?? Number(!input.clientPreflight))
    + Number(!input.verdict);
  const ready = Boolean(input.serverPreflight?.ready)
    && Boolean(input.clientPreflight?.ready)
    && Boolean(input.verdict?.ready);
  return { ready, label: ready ? 'Ready to go live' : 'Not ready', blockers, unverified };
}

type WorkbenchCheckStatus = 'ready' | 'warning' | 'blocker' | 'unknown';

interface WorkbenchCheck {
  id: string;
  label: string;
  status: WorkbenchCheckStatus;
  detail: string;
  remedy?: string;
  capability: string;
  source: 'overview' | 'settings' | 'browser';
}

function checkStatusLabel(status: WorkbenchCheckStatus): string {
  if (status === 'ready') return 'Ready';
  if (status === 'blocker') return 'Blocking';
  if (status === 'warning') return 'Heads up';
  return 'Unverified';
}

function runTimestamp(value: string | undefined): string {
  if (!value) return 'No complete run yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Run time unavailable';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

type RehearsalState = Partial<Record<RehearsalKind, RehearsalReport>>;
type RehearsalFlags = Partial<Record<RehearsalKind, boolean>>;
type RehearsalErrors = Partial<Record<RehearsalKind, string>>;

export function TestTab() {
  const eventId = browserEventId();
  const principal = useSyncPrincipal() ?? undefined;
  const [activeSuite, setActiveSuite] = useState<TestSuiteId>('preflight');
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  // REST on every transport: payload-jsonb document store, no Zero leaf (D-025).
  const eventConfigQuery = useRestSyncQuery<EventConfigRead>({
    queryName: 'event.config',
    args: { eventId },
    pollIntervalMs: 30_000,
  });
  const eventConfig = eventConfigQuery.data?.[0] ?? null;
  const [checks, setChecks] = useState<readonly PreflightCheck[]>(PREFLIGHT_PENDING);
  const [eventName, setEventName] = useState<string>(DEFAULT_EVENT_TITLE);
  const refreshChecks = useCallback(() => {
    void runPreflight(eventConfig, Boolean(eventConfigQuery.error)).then(setChecks);
  }, [eventConfig, eventConfigQuery.error]);
  useEffect(() => {
    refreshChecks();
  }, [refreshChecks]);
  const refreshPreflight = useCallback(() => {
    eventConfigQuery.invalidate();
    refreshChecks();
  }, [eventConfigQuery.invalidate, refreshChecks]);
  const readyCount = checks.filter((check) => check.tone === 'success').length;

  // ---- Event identity: show the host THEIR event, not a hardcoded example ----
  useEffect(() => {
    if (eventConfig?.name?.trim()) setEventName(eventConfig.name.trim());
  }, [eventConfig?.name]);

  // ---- Server-side preflight (the config lint) --------------------------------
  const serverPreflightQuery = useRestSyncQuery<PreflightReport>({
    queryName: 'rehearsal.preflight',
    args: { eventId },
    pollIntervalMs: 30_000,
  });
  const serverPreflight = serverPreflightQuery.data?.[0] ?? null;
  const serverPreflightError = serverPreflightQuery.error?.message ?? null;
  const refreshServerPreflight = serverPreflightQuery.invalidate;

  // ---- Client-side preflight (actual SSE/media/clock measurements) ------------
  const [clientPreflight, setClientPreflight] = useState<ClientPreflightReport | null>(null);
  const [clientPreflightError, setClientPreflightError] = useState<string | null>(null);
  const [clientPreflightRunning, setClientPreflightRunning] = useState(false);
  const clientProbeStarted = useRef(false);
  const refreshClientPreflight = useCallback(() => {
    setClientPreflightRunning(true);
    setClientPreflightError(null);
    void runClientPreflight(eventId, { realtime: { principal } })
      .then(setClientPreflight)
      .catch((error: unknown) => {
        setClientPreflight(null);
        setClientPreflightError(error instanceof Error ? error.message : 'The browser checks could not run.');
      })
      .finally(() => setClientPreflightRunning(false));
  }, [eventId, principal]);
  useEffect(() => {
    // React StrictMode replays effects in development. A readiness probe may
    // prompt for camera/microphone access, so it must still run only once.
    if (clientProbeStarted.current) return;
    clientProbeStarted.current = true;
    refreshClientPreflight();
  }, [refreshClientPreflight]);

  const refreshSetup = useCallback(() => {
    refreshServerPreflight();
    refreshClientPreflight();
  }, [refreshClientPreflight, refreshServerPreflight]);

  const workbenchChecks = useMemo<WorkbenchCheck[]>(() => [
    ...checks.map((check, index): WorkbenchCheck => ({
      id: `overview-${index}-${check.label}`,
      label: check.label,
      status: check.tone === 'success'
        ? 'ready'
        : check.tone === 'danger' ? 'blocker' : check.tone === 'warning' ? 'warning' : 'unknown',
      detail: check.value,
      capability: check.label === 'Catalog connection' ? 'Catalog' : 'Copilot',
      source: 'overview',
    })),
    ...(serverPreflight?.checks.map((check): WorkbenchCheck => ({
      id: `settings-${check.id}`,
      label: check.label,
      status: check.status,
      detail: check.detail,
      ...(check.remedy ? { remedy: check.remedy } : {}),
      capability: 'Settings',
      source: 'settings',
    })) ?? []),
    ...(clientPreflight?.checks.map((check): WorkbenchCheck => ({
      id: `browser-${check.id}`,
      label: check.label,
      status: check.status,
      detail: check.observed,
      ...(check.remedy ? { remedy: check.remedy } : {}),
      capability: 'Browser',
      source: 'browser',
    })) ?? []),
  ], [checks, clientPreflight?.checks, serverPreflight?.checks]);
  const passedCheckCount = workbenchChecks.filter((check) => check.status === 'ready').length;
  const failedCheckCount = workbenchChecks.filter((check) => check.status === 'blocker').length;
  const priorityCheck = workbenchChecks.find((check) => check.status === 'blocker')
    ?? workbenchChecks.find((check) => check.status === 'unknown')
    ?? workbenchChecks[0]
    ?? null;
  const focusedCheck = workbenchChecks.find((check) => check.id === selectedCheckId) ?? priorityCheck;

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

  const runRehearsalFallback = useCallback(
    async (kind: RehearsalKind) => runRehearsal(kind),
    [],
  );
  const mutateRehearsal = useSyncMutate<RehearsalKind, RehearsalReport>(
    'rehearsal.run',
    runRehearsalFallback,
  );
  const runDressFallback = useCallback(
    async (_input: Record<string, never>) => runDressRehearsal(),
    [],
  );
  const mutateDressRehearsal = useSyncMutate<Record<string, never>, DressRehearsalVerdict>(
    'rehearsal.runAll',
    runDressFallback,
  );

  const runOne = useCallback(async (kind: RehearsalKind) => {
    setRunning((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      absorb(await mutateRehearsal(kind));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : 'The rehearsal could not be reached.',
      }));
    } finally {
      setRunning((current) => ({ ...current, [kind]: false }));
    }
  }, [absorb, mutateRehearsal]);

  const runDress = useCallback(async () => {
    setDressRunning(true);
    setDressError(null);
    try {
      const result = await mutateDressRehearsal({});
      setVerdict(result);
      result.reports.forEach(absorb);
      refreshSetup();
    } catch (error) {
      setVerdict(null);
      setDressError(error instanceof Error ? error.message : 'The full rehearsal could not be reached.');
    } finally {
      setDressRunning(false);
    }
  }, [absorb, mutateDressRehearsal, refreshSetup]);

  const readinessReport = useMemo(
    () => buildReadinessReport({ eventId, preflight: serverPreflight, clientPreflight, verdict }),
    [clientPreflight, eventId, serverPreflight, verdict],
  );
  const launchSummary = useMemo(
    () => buildLaunchSummary({ serverPreflight, clientPreflight, verdict }),
    [clientPreflight, serverPreflight, verdict],
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
      setJudgeReport(await mutateJudge({}));
      judgeQuery.invalidate();
    } catch (error) {
      setJudgeReport(null);
      setJudgeError(error instanceof Error ? error.message : 'The reply judge could not be reached.');
    } finally {
      setJudgeRunning(false);
    }
  };

  const failedKinds = REHEARSAL_KINDS.filter((kind) => reports[kind]?.passed === false);
  const hasCompletedEvidence = Boolean(verdict || serverPreflight || clientPreflight || history.length > 0);
  const failedOnlyEnabled = hasCompletedEvidence && (failedCheckCount > 0 || failedKinds.length > 0);
  const runPreflightSuite = () => {
    refreshPreflight();
    refreshSetup();
  };
  const runFailedOnly = async () => {
    if (failedCheckCount > 0) runPreflightSuite();
    await Promise.all(failedKinds.map((kind) => runOne(kind)));
  };
  const suiteCount = (suite: TestSuiteId): string => {
    if (suite === 'preflight') return `${passedCheckCount}/${workbenchChecks.length}`;
    if (suite === 'full') return verdict ? `${verdict.passedCases}/${verdict.totalCases}` : '—';
    if (suite === 'failed') return String(failedCheckCount + failedKinds.length);
    if (suite === 'load') return simulation ? String(simulation.coverage.observedKinds.length) : '—';
    if (suite === 'judge') return judgeReport ? `${judgeReport.passedCases}/${judgeReport.totalCases}` : '—';
    const report = reports[suite];
    return report ? `${report.passedCases}/${report.totalCases}` : '—';
  };
  const activeSuiteDefinition = TEST_SUITE_GROUPS
    .flatMap((group) => group.suites)
    .find((suite) => suite.id === activeSuite) ?? TEST_SUITE_GROUPS[0].suites[0];
  const latestRunAt = verdict?.ranAt ?? history[0]?.ranAt ?? serverPreflight?.ranAt ?? clientPreflight?.ranAt;
  const anySuiteRunning = dressRunning || judgeRunning || clientPreflightRunning
    || Object.values(running).some(Boolean);

  return (
    <div className="tab-layout density-compact test-page">
      <TabHeader
        eyebrow="Testing workbench"
        title="Rehearse before you go live."
        copy="Choose a focused suite, scan the evidence, and run only what advances this event's launch decision."
      />

      <section
        className={'test-launch-card ' + (launchSummary.ready ? 'is-ready' : 'is-blocked')}
        aria-labelledby="test-launch-title"
      >
        <div>
          <div className="test-launch-status">
            <span className={'test-status-pill ' + (launchSummary.ready ? 'is-ready' : 'is-blocked')}>
              {launchSummary.label}
            </span>
            <span>
              {launchSummary.blockers > 0
                ? launchSummary.blockers + ' ' + (launchSummary.blockers === 1 ? 'blocker' : 'blockers')
                : launchSummary.unverified > 0
                  ? launchSummary.unverified + ' unverified'
                  : 'No blockers'}
            </span>
            <span>Last run: {runTimestamp(latestRunAt)}</span>
          </div>
          <h2 id="test-launch-title">{eventName}</h2>
          <p>
            {launchSummary.ready
              ? 'Every required setup probe and rehearsal passed for this event.'
              : 'Finish the required evidence below before opening the room to buyers.'}
          </p>
        </div>
        <div className="test-launch-actions">
          <div className="test-event-identity" aria-label="Event under test">
            <span>Event under test</span>
            <strong>{eventName}</strong>
            <code>{eventId}</code>
          </div>
          <button
            className="button primary"
            type="button"
            onClick={() => {
              setActiveSuite('full');
              void runDress();
            }}
            disabled={dressRunning}
          >
            {dressRunning ? 'Running full rehearsal…' : 'Run full rehearsal'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={downloadReport}
            disabled={!verdict && !serverPreflight}
          >
            Download report
          </button>
        </div>
      </section>

      <section className="test-workbench" aria-label="Event rehearsal workbench" aria-busy={anySuiteRunning}>
        <aside className="test-suite-rail" aria-label="Test suites">
          <div className="test-suite-rail-head">
            <strong>Test suites</strong>
            <span className={'test-count-badge ' + (failedCheckCount + failedKinds.length > 0 ? 'is-failed' : '')}>
              {failedCheckCount + failedKinds.length} failed
            </span>
          </div>

          <label className="test-mobile-suite-picker">
            <span>Choose test suite</span>
            <select
              value={activeSuite}
              onChange={(event) => setActiveSuite(event.target.value as TestSuiteId)}
            >
              {TEST_SUITE_GROUPS.flatMap((group) => group.suites).map((suite) => (
                <option value={suite.id} key={suite.id}>{suite.label}</option>
              ))}
            </select>
          </label>

          <div className="test-desktop-suite-groups">
            {TEST_SUITE_GROUPS.map((group) => (
              <div className="test-suite-group" key={group.label}>
                <div className="test-suite-group-label">
                  <span>{group.label}</span>
                  <span>{group.suites.length}</span>
                </div>
                <nav aria-label={group.label + ' suites'}>
                  {group.suites.map((suite) => (
                    <button
                      className={'test-suite-button ' + (activeSuite === suite.id ? 'is-active' : '')}
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

          <section className="test-run-timeline" aria-labelledby="test-run-timeline-title" aria-live="polite">
            <div className="test-run-timeline-head">
              <strong id="test-run-timeline-title">Recent runs</strong>
              {anySuiteRunning ? <span>Running now</span> : null}
            </div>
            {history.length > 0 ? (
              <ol>
                {history.slice(0, 4).map((entry) => (
                  <li key={entry.kind + '-' + entry.ranAt}>
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
            ) : (
              <p>Run a suite to build a timestamped evidence trail.</p>
            )}
          </section>
        </aside>

        <div className="test-workbench-main">
          <header className="test-active-suite-head">
            <div>
              <div className="test-active-suite-meta">
                <span className={'test-status-pill ' + (launchSummary.ready ? 'is-ready' : 'is-blocked')}>
                  {launchSummary.label}
                </span>
                <span>{suiteCount(activeSuite)} checks</span>
                <span>{anySuiteRunning ? 'Evidence updating' : 'Evidence available'}</span>
              </div>
              <h2>{activeSuiteDefinition.label}</h2>
              <p>{activeSuiteDefinition.description}</p>
            </div>
            <div className="test-active-suite-actions">
              {activeSuite === 'preflight' ? (
                <>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void runFailedOnly()}
                    disabled={!failedOnlyEnabled}
                  >
                    Run failed only
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    onClick={runPreflightSuite}
                    disabled={clientPreflightRunning}
                  >
                    {clientPreflightRunning ? 'Running preflight…' : 'Run preflight'}
                  </button>
                </>
              ) : null}
              {activeSuite === 'failed' ? (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void runFailedOnly()}
                  disabled={!failedOnlyEnabled}
                >
                  {failedOnlyEnabled ? 'Run failed only' : 'No failed checks'}
                </button>
              ) : null}
            </div>
          </header>

          <section className="test-suite-panel" hidden={activeSuite !== 'preflight'} aria-label="Preflight evidence">
            {priorityCheck?.status === 'blocker' ? (
              <div className="test-blocker-banner" role="alert">
                <span aria-hidden="true">!</span>
                <div>
                  <strong>First fix: {priorityCheck.label}</strong>
                  <p>{priorityCheck.remedy ?? priorityCheck.detail}</p>
                </div>
                {priorityCheck.source === 'settings' ? (
                  <a
                    className="button primary"
                    href={tabHref('config', typeof window === 'undefined' ? '/' : window.location.href)}
                  >
                    Fix in Settings
                  </a>
                ) : (
                  <button className="button secondary" type="button" onClick={runPreflightSuite}>Re-check</button>
                )}
              </div>
            ) : null}
            {serverPreflightError ? <p className="rehearsal-error" role="alert">{serverPreflightError}</p> : null}
            {clientPreflightError ? <p className="rehearsal-error" role="alert">{clientPreflightError}</p> : null}

            <div className="test-evidence-columns">
              <section className="test-check-list-card" aria-labelledby="test-required-title">
                <header>
                  <div>
                    <span className="eyebrow">Launch evidence</span>
                    <h3 id="test-required-title">Required before live</h3>
                  </div>
                  <span>{passedCheckCount} / {workbenchChecks.length} ready</span>
                </header>
                <ul>
                  {workbenchChecks.map((check) => (
                    <li className={'test-check-row is-' + check.status} key={check.id}>
                      <span className="test-check-icon" aria-hidden="true">
                        {check.status === 'ready' ? '✓' : check.status === 'blocker' ? '×' : check.status === 'warning' ? '!' : '·'}
                      </span>
                      <button type="button" onClick={() => setSelectedCheckId(check.id)}>
                        <strong>{check.label}</strong>
                        <small>{check.detail}</small>
                      </button>
                      <span>{checkStatusLabel(check.status)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <aside className="test-focus-card" aria-labelledby="test-focus-title">
                <div className="test-focus-heading">
                  <div>
                    <span className="eyebrow">Focused check</span>
                    <h3 id="test-focus-title">{focusedCheck?.label ?? 'Waiting for evidence'}</h3>
                  </div>
                  {focusedCheck ? (
                    <span className={'test-status-pill is-' + focusedCheck.status}>
                      {checkStatusLabel(focusedCheck.status)}
                    </span>
                  ) : null}
                </div>
                {focusedCheck ? (
                  <>
                    <p><strong>Why it matters</strong><br />{focusedCheck.remedy ?? focusedCheck.detail}</p>
                    <div className="test-focus-meta">
                      <span>Capability: {focusedCheck.capability}</span>
                      <span>Source: {focusedCheck.source}</span>
                    </div>
                    <div className="test-run-log" role="log" aria-live="polite" aria-label="Check output">
                      <span>{runTimestamp(latestRunAt)}</span>
                      <strong>{checkStatusLabel(focusedCheck.status)}</strong>
                      <p>{focusedCheck.detail}</p>
                    </div>
                    <div className="test-focus-actions">
                      {focusedCheck.source === 'settings' ? (
                        <a
                          className="button primary"
                          href={tabHref('config', typeof window === 'undefined' ? '/' : window.location.href)}
                        >
                          Fix in Settings
                        </a>
                      ) : null}
                      <button className="button secondary" type="button" onClick={runPreflightSuite}>Re-check</button>
                    </div>
                  </>
                ) : (
                  <p>Live server and browser probes are still loading.</p>
                )}
              </aside>
            </div>
          </section>

          <section className="test-suite-panel" hidden={activeSuite !== 'full'} aria-label="Full rehearsal">
            <section className="dress-rehearsal-panel" aria-labelledby="dress-title">
              <div className="panel-kicker">
                Full dress rehearsal
                <span className="panel-status">
                  {verdict ? (verdict.ready ? 'Ready to go live' : verdict.blockers.length + ' blocking') : dressRunning ? 'Running' : 'Not run'}
                </span>
              </div>
              <h2 id="dress-title">One button, one answer.</h2>
              <p className="rehearsal-intro">
                Runs every required rehearsal in order and folds the result into a single go / no-go.
                Nothing here reaches a buyer.
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
                          <li key={blocker.kind + '-' + blocker.caseId}>
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
          </section>

          <section className="test-suite-panel" hidden={activeSuite !== 'failed'} aria-label="Failed checks">
            <div className="test-failed-overview">
              <span className="eyebrow">Corrective loop</span>
              <h3>{failedCheckCount + failedKinds.length > 0 ? 'Fix what failed, then prove it.' : 'No failed checks in the latest evidence.'}</h3>
              <p>Failed-only reruns keep successful evidence intact and return you to the checks that can change the launch decision.</p>
              {failedKinds.length > 0 ? (
                <ul>
                  {failedKinds.map((kind) => (
                    <li key={kind}>
                      <button type="button" onClick={() => setActiveSuite(kind)}>
                        <strong>{REHEARSAL_LABELS[kind]}</strong>
                        <span>{reports[kind]?.passedCases}/{reports[kind]?.totalCases} held</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

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
              />
            </div>
          ))}

          <section className="test-suite-panel" hidden={activeSuite !== 'load'} aria-label="Load rehearsal">
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
            <div className="test-note"><span className="feature-icon cyan">⌁</span><p>Tip: connect your stream when you are ready. You can still rehearse catalog and copilot flows without a camera.</p></div>
          </section>

          <section className="test-suite-panel" hidden={activeSuite !== 'judge'} aria-label="Reply judge">
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
                      <article className={'judge-case ' + (testCase.passed ? 'is-passed' : 'is-failed')} key={testCase.caseId}>
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
          </section>
        </div>
      </section>
    </div>
  );
}

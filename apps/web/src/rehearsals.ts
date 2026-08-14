import { resolveApiBaseUrl } from './catalog';

/**
 * Browser contract for the launch-readiness rehearsals.
 *
 * These types mirror `apps/api/src/rehearsals/rehearsal.types.ts`. The two
 * workspaces do not share a package, so the mirror is checked by a test that
 * runs a real report through this module's own type guard rather than by
 * hoping the two files stay in step.
 */

export const REHEARSAL_KINDS = ['actions', 'auction', 'checkout', 'injection'] as const;
export type RehearsalKind = (typeof REHEARSAL_KINDS)[number];

export type RehearsalEvidence = Record<string, string | number | boolean>;

export interface RehearsalCaseResult {
  caseId: string;
  title: string;
  expectation: string;
  passed: boolean;
  observed: string;
  evidence?: RehearsalEvidence;
}

export interface RehearsalReport {
  runId: string;
  kind: RehearsalKind;
  title: string;
  summary: string;
  totalCases: number;
  passedCases: number;
  passed: boolean;
  latencyMs: number;
  ranAt: string;
  cases: RehearsalCaseResult[];
  caveats?: string[];
}

export interface DressRehearsalBlocker {
  kind: RehearsalKind;
  caseId: string;
  title: string;
  observed: string;
}

export interface DressRehearsalVerdict {
  ranAt: string;
  ready: boolean;
  totalCases: number;
  passedCases: number;
  blockers: DressRehearsalBlocker[];
  caveats: string[];
  reports: RehearsalReport[];
}

export type PreflightStatus = 'ready' | 'warning' | 'blocker' | 'unknown';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  remedy?: string;
}

export interface PreflightReport {
  eventId: string;
  ranAt: string;
  /** False when anything blocks OR anything could not be measured. */
  ready: boolean;
  blockers: number;
  warnings: number;
  /** Checks that could not be established either way — these hold back `ready`. */
  unknowns: number;
  checks: PreflightCheck[];
}

export const REHEARSAL_LABELS: Record<RehearsalKind, string> = {
  actions: 'Guarded actions',
  auction: 'Live auction',
  checkout: 'Checkout and shipping',
  injection: 'Hostile input',
};

async function postJson<T>(path: string, apiBaseUrl?: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload;
}

export function runRehearsal(kind: RehearsalKind, apiBaseUrl?: string): Promise<RehearsalReport> {
  return postJson<RehearsalReport>(`/rehearsals/${kind}`, apiBaseUrl);
}

export function runDressRehearsal(apiBaseUrl?: string): Promise<DressRehearsalVerdict> {
  return postJson<DressRehearsalVerdict>('/rehearsals/all', apiBaseUrl);
}

export async function fetchPreflight(eventId: string, apiBaseUrl?: string): Promise<PreflightReport> {
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}/rehearsals/preflight/${encodeURIComponent(eventId)}`);
  const payload = await response.json() as PreflightReport & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Preflight failed (${response.status})`);
  return payload;
}

// ---- Run history -------------------------------------------------------------

export interface RehearsalHistoryEntry {
  kind: RehearsalKind;
  ranAt: string;
  passedCases: number;
  totalCases: number;
  passed: boolean;
}

const HISTORY_KEY_PREFIX = 'sidestage:rehearsal-history:';
const HISTORY_LIMIT = 10;

function historyKey(eventId: string): string {
  return `${HISTORY_KEY_PREFIX}${eventId}`;
}

function safeStorage(): Storage | null {
  try {
    // Private-mode Safari throws on access rather than returning null, and a
    // readiness screen must not break because history is unavailable.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readHistory(eventId: string): RehearsalHistoryEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(historyKey(eventId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
  } catch {
    return [];
  }
}

function isHistoryEntry(value: unknown): value is RehearsalHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.kind === 'string'
    && (REHEARSAL_KINDS as readonly string[]).includes(entry.kind)
    && typeof entry.ranAt === 'string'
    && typeof entry.passedCases === 'number'
    && typeof entry.totalCases === 'number'
    && typeof entry.passed === 'boolean';
}

export function recordHistory(eventId: string, report: RehearsalReport): RehearsalHistoryEntry[] {
  const storage = safeStorage();
  const entry: RehearsalHistoryEntry = {
    kind: report.kind,
    ranAt: report.ranAt,
    passedCases: report.passedCases,
    totalCases: report.totalCases,
    passed: report.passed,
  };
  const next = [entry, ...readHistory(eventId)].slice(0, HISTORY_LIMIT);
  if (storage) {
    try {
      storage.setItem(historyKey(eventId), JSON.stringify(next));
    } catch {
      // A full or blocked storage must not fail the run the host just did.
    }
  }
  return next;
}

/**
 * The change since the previous run of the SAME rehearsal.
 *
 * Returns null when there is nothing to compare against — a first run has no
 * delta, and inventing "0" would read as "nothing changed", which is a
 * different and misleading claim.
 */
export function historyDelta(history: readonly RehearsalHistoryEntry[], kind: RehearsalKind): number | null {
  const forKind = history.filter((entry) => entry.kind === kind);
  const [latest, previous] = forKind;
  if (!latest || !previous) return null;
  return latest.passedCases - previous.passedCases;
}

// ---- Report export -----------------------------------------------------------

export interface ReadinessReportFile {
  generatedAt: string;
  eventId: string;
  ready: boolean;
  preflight: PreflightReport | null;
  verdict: DressRehearsalVerdict | null;
}

export function buildReadinessReport(input: {
  eventId: string;
  preflight: PreflightReport | null;
  verdict: DressRehearsalVerdict | null;
  now?: () => number;
}): ReadinessReportFile {
  const now = input.now ?? Date.now;
  // Ready requires BOTH halves to have actually run and passed. A missing half
  // is not a pass — that is the whole reason this is computed here rather than
  // read off whichever report happens to be present.
  const ready = Boolean(input.preflight?.ready) && Boolean(input.verdict?.ready);
  return {
    generatedAt: new Date(now()).toISOString(),
    eventId: input.eventId,
    ready,
    preflight: input.preflight,
    verdict: input.verdict,
  };
}

export function readinessReportFilename(eventId: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return `sidestage-readiness-${eventId}-${stamp}.json`;
}

import { randomUUID } from 'node:crypto';
import type {
  RehearsalCaseResult,
  RehearsalCaseSpec,
  RehearsalEvidence,
  RehearsalKind,
  RehearsalObservation,
  RehearsalReport,
} from './rehearsal.types';

/** What a refused call told us. Extracted without depending on Nest's class identity. */
export interface RefusalDetail {
  code?: string;
  message: string;
  status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Normalizes a thrown value into a readable refusal.
 *
 * Nest carries the interesting part in `getResponse()`, which is either the
 * object a service threw deliberately (`{ code, message }` — the guarded-action
 * service does exactly this) or Nest's own envelope (`{ statusCode, message,
 * error }`) when the service threw a bare string. We duck-type rather than
 * `instanceof HttpException` so this stays unit-testable without booting Nest,
 * and so a plain `Error` from a non-Nest seam is described just as well.
 */
export function describeRefusal(error: unknown): RefusalDetail {
  if (isRecord(error) && typeof error.getResponse === 'function') {
    const response = (error.getResponse as () => unknown)();
    const status = typeof error.getStatus === 'function'
      ? (error.getStatus as () => unknown)()
      : undefined;
    const detail: RefusalDetail = {
      message: 'The call was refused.',
      ...(typeof status === 'number' ? { status } : {}),
    };
    if (typeof response === 'string') {
      detail.message = response;
      return detail;
    }
    if (isRecord(response)) {
      const code = readString(response, 'code');
      if (code) detail.code = code;
      // Nest renders a multi-error `message` as an array; join rather than drop it.
      const message = Array.isArray(response.message)
        ? response.message.filter((part): part is string => typeof part === 'string').join('; ')
        : readString(response, 'message');
      if (message) detail.message = message;
      else {
        const fallback = readString(response, 'error');
        if (fallback) detail.message = fallback;
      }
      return detail;
    }
    return detail;
  }
  if (error instanceof Error) {
    return { message: error.message || error.name };
  }
  return { message: String(error) };
}

/**
 * Runs one rehearsal case.
 *
 * A probe that throws unexpectedly becomes a FAILED CASE carrying the error
 * text — it never propagates. A rehearsal that dies halfway through tells the
 * seller nothing about the cases it never reached, so the whole run staying
 * alive is worth more than a clean stack trace.
 */
export async function runCase(
  spec: RehearsalCaseSpec,
  probe: () => Promise<RehearsalObservation> | RehearsalObservation,
): Promise<RehearsalCaseResult> {
  try {
    const observation = await probe();
    return { ...spec, ...observation };
  } catch (error) {
    const refusal = describeRefusal(error);
    return {
      ...spec,
      passed: false,
      observed: `The rehearsal case itself failed to run: ${refusal.message}`,
      evidence: {
        error: refusal.message,
        ...(refusal.code ? { code: refusal.code } : {}),
        ...(refusal.status ? { status: refusal.status } : {}),
      },
    };
  }
}

/**
 * A case that passes only when the seam REFUSES the call.
 *
 * The dangerous outcome here is the call SUCCEEDING, so that path is reported
 * loudly rather than as a quiet mismatch: an unguarded write is exactly the
 * thing the depth area exists to prevent.
 */
export async function expectRefusal(
  spec: RehearsalCaseSpec,
  call: () => Promise<unknown>,
  options: { code?: string } = {},
): Promise<RehearsalCaseResult> {
  return runCase(spec, async () => {
    let result: unknown;
    try {
      result = await call();
    } catch (error) {
      const refusal = describeRefusal(error);
      const evidence: RehearsalEvidence = { refusal: refusal.message };
      if (refusal.code) evidence.code = refusal.code;
      if (refusal.status) evidence.status = refusal.status;
      if (options.code && refusal.code && refusal.code !== options.code) {
        return {
          passed: false,
          observed: `Refused, but for the wrong reason: expected ${options.code}, got ${refusal.code}.`,
          evidence,
        };
      }
      return {
        passed: true,
        observed: `Refused: ${refusal.message}`,
        evidence,
      };
    }
    return {
      passed: false,
      observed: 'NOT REFUSED — the call was allowed through. This write would have reached a real buyer.',
      evidence: { allowedResult: summarize(result) },
    };
  });
}

/** A case that passes when the call succeeds and the supplied check holds. */
export async function expectSuccess<T>(
  spec: RehearsalCaseSpec,
  call: () => Promise<T>,
  check: (value: T) => RehearsalObservation,
): Promise<RehearsalCaseResult> {
  return runCase(spec, async () => check(await call()));
}

const SUMMARY_MAX_CHARS = 300;

function clamp(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
}

/**
 * Compact one-line rendering of an arbitrary value for evidence rows.
 *
 * Clamped for EVERY input shape, strings included: an evidence value is
 * rendered in a fixed-width cell, and a pasted-in wall of text is the one
 * thing that would push the failing case the seller needs off the screen.
 */
export function summarize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return clamp(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clamp(JSON.stringify(value));
  } catch {
    return clamp(String(value));
  }
}

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BuildReportInput {
  kind: RehearsalKind;
  title: string;
  cases: readonly RehearsalCaseResult[];
  /** `Date.now()` captured before the first case ran. */
  startedMs: number;
  caveats?: readonly string[];
  /** Injectable clock, so the report builder is testable without faking globals. */
  now?: () => number;
}

export function buildRehearsalReport(input: BuildReportInput): RehearsalReport {
  const now = input.now ?? Date.now;
  const cases = [...input.cases];
  const passedCases = cases.filter((entry) => entry.passed).length;
  const passed = cases.length > 0 && passedCases === cases.length;
  const failed = cases.length - passedCases;
  return {
    runId: `rehearsal_${randomUUID()}`,
    kind: input.kind,
    title: input.title,
    summary: cases.length === 0
      ? 'No cases ran.'
      : passed
        ? `All ${cases.length} checks held.`
        : `${failed} of ${cases.length} checks failed.`,
    totalCases: cases.length,
    passedCases,
    passed,
    latencyMs: Math.max(0, now() - input.startedMs),
    ranAt: new Date(now()).toISOString(),
    cases,
    ...(input.caveats && input.caveats.length > 0 ? { caveats: [...input.caveats] } : {}),
  };
}

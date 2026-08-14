import type { CopilotPolicy } from '../copilot/copilot.types';
import type { EventConfig } from '../config/event-config.service';

/**
 * Server-side preflight.
 *
 * The browser already probes what a browser should probe — can it reach the
 * API, is there a camera, does the media server answer. This side answers the
 * question the browser cannot: given the guardrails this host has actually
 * saved, will the copilot be able to do its job, and will anything survive a
 * restart?
 *
 * `unknown` is a first-class status on purpose. A check that could not be
 * measured must never render as a green light — that is the single most
 * expensive way for a readiness screen to lie.
 */

export type PreflightStatus = 'ready' | 'warning' | 'blocker' | 'unknown';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  /** What was observed, in the host's language. */
  detail: string;
  /** What to do about it. Present whenever the status is not `ready`. */
  remedy?: string;
}

export interface PreflightReport {
  eventId: string;
  ranAt: string;
  /**
   * True only when nothing is blocking AND nothing is unmeasured. Warnings do
   * not stop a launch; an `unknown` check does, because a green light standing
   * on a question nobody answered is the specific lie this screen exists to
   * prevent.
   */
  ready: boolean;
  blockers: number;
  warnings: number;
  unknowns: number;
  checks: PreflightCheck[];
}

export const CLIENT_REALTIME_PROBE_EVENT = 'rehearsal.client-round-trip';

export interface ClientClockReceipt {
  serverTimeMs: number;
}

export interface ClientRealtimeProbeReceipt extends ClientClockReceipt {
  eventId: string;
  nonce: string;
}

/** One timestamp feeds both the HTTP receipt and the correlated SSE event. */
export function createClientRealtimeProbeReceipt(
  eventId: string,
  nonce: string,
  now: () => number = Date.now,
): ClientRealtimeProbeReceipt {
  return { eventId, nonce, serverTimeMs: now() };
}

/**
 * The outcome of the live durability probe.
 *
 * Four cases rather than a boolean, because they ask four different things of
 * the host — and collapsing them is exactly how "we never asked" ends up
 * rendering as "yes".
 */
export type DurabilityProbe =
  | { kind: 'reachable'; latencyMs: number }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'absent' };

/** The narrow slice of a pg Pool the probe needs — structural, so tests need no database. */
export interface DurabilityQuery {
  query(sql: string): Promise<unknown>;
}

export const DURABILITY_PROBE_TIMEOUT_MS = 2_000;

/**
 * Ask the database, right now, whether it is answering.
 *
 * A non-null pool already means Postgres answered ONCE — createPoolOrNull
 * probes with SELECT 1 at startup. That is precisely the trap this closes:
 * boot may have been hours ago, and a host runs this check in the minutes
 * before going live. On screen, a boot-time fact stated in the present tense
 * is indistinguishable from one measured just now.
 *
 * A hang is reported as `unknown`, not as failure: a query that never returns
 * has not told us the database is down, only that we did not find out. The
 * timeout also keeps the probe from outliving the request that asked for it.
 */
export async function probeDurability(
  pool: DurabilityQuery | null,
  options: { now?: () => number; timeoutMs?: number } = {},
): Promise<DurabilityProbe> {
  if (pool === null) return { kind: 'absent' };
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DURABILITY_PROBE_TIMEOUT_MS;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answered = await Promise.race([
      pool.query('SELECT 1').then(() => true as const),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    return answered
      ? { kind: 'reachable', latencyMs: Math.max(0, Math.round(now() - started)) }
      : { kind: 'unknown', message: `no answer within ${timeoutMs}ms` };
  } catch (error) {
    return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PreflightInput {
  eventId: string;
  config: EventConfig;
  /** The policy the saved config actually produces — what the guard will enforce. */
  policy: CopilotPolicy;
  /** The outcome of a LIVE durability probe — never a cached or boot-time verdict. */
  durability: DurabilityProbe;
  now?: () => number;
}

const DEFAULT_EVENT_NAME = 'Sunday vintage drop';

/**
 * The check that would have caught the Config-tab wiring gap.
 *
 * PolicyActionGuard refuses every price-bearing action for a product with no
 * configured floor. A host reading "guardrails: on" reasonably expects guarded
 * discounting, not a blanket refusal, so an empty floor map is reported as a
 * launch blocker rather than a silent quirk.
 */
export function lintPricingPolicy(policy: CopilotPolicy): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const floors = Object.keys(policy.priceFloorCentsByProduct ?? {});

  checks.push(floors.length === 0
    ? {
      id: 'price-floors',
      label: 'Price floors',
      status: 'blocker',
      detail: 'No price floor is configured for any product, so every markdown, price change and targeted offer will be refused.',
      remedy: 'Set a price floor for the products in this event before going live.',
    }
    : {
      id: 'price-floors',
      label: 'Price floors',
      status: 'ready',
      detail: `${floors.length} product${floors.length === 1 ? '' : 's'} have a price floor the copilot cannot go under.`,
    });

  checks.push(policy.maxMarkdownPercent >= 100
    ? {
      id: 'markdown-cap',
      label: 'Discount cap',
      status: 'warning',
      detail: `The discount cap is ${policy.maxMarkdownPercent}%, which is no cap at all.`,
      remedy: 'Turn the price guardrail on, or set a lower cap, so a discount cannot reach zero.',
    }
    : {
      id: 'markdown-cap',
      label: 'Discount cap',
      status: 'ready',
      detail: `Discounts are capped at ${policy.maxMarkdownPercent}%.`,
    });

  checks.push(policy.automationLevel === 'auto' && policy.allowAutoActions
    ? {
      id: 'automation-level',
      label: 'Automation level',
      status: 'warning',
      detail: 'The copilot can apply actions on its own, without you confirming them first.',
      remedy: 'Switch the price guardrail on if you want to approve changes before they take effect.',
    }
    : {
      id: 'automation-level',
      label: 'Automation level',
      status: 'ready',
      detail: `Actions are set to "${policy.automationLevel}", so they wait for you.`,
    });

  return checks;
}

export function lintEventConfig(config: EventConfig): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const neverSaved = Date.parse(config.updatedAt) === 0;

  checks.push(neverSaved
    ? {
      id: 'config-saved',
      label: 'Event setup',
      status: 'warning',
      detail: `This event is running on defaults — the Config tab has never been saved${config.name === DEFAULT_EVENT_NAME ? `, and it is still called "${DEFAULT_EVENT_NAME}"` : ''}.`,
      remedy: 'Open the Config tab, set the event name and tone, and save.',
    }
    : {
      id: 'config-saved',
      label: 'Event setup',
      status: 'ready',
      detail: `Saved as "${config.name}" with a ${config.replyTone} reply tone.`,
    });

  const offGuardrails = [
    !config.guardrails.priceChanges ? 'price changes' : null,
    !config.guardrails.inventoryClaims ? 'inventory claims' : null,
    !config.guardrails.buyerSensitive ? 'buyer-sensitive topics' : null,
  ].filter((entry): entry is string => entry !== null);

  checks.push(offGuardrails.length > 0
    ? {
      id: 'guardrails',
      label: 'Always-ask guardrails',
      status: 'warning',
      detail: `The copilot will not stop to ask about: ${offGuardrails.join(', ')}.`,
      remedy: 'Switch those guardrails back on unless you mean to run without them.',
    }
    : {
      id: 'guardrails',
      label: 'Always-ask guardrails',
      status: 'ready',
      detail: 'Price changes, inventory claims and buyer-sensitive topics all wait for your approval.',
    });

  return checks;
}

/**
 * Report what the probe actually found.
 *
 * Note the asymmetry between the two failure cases, which is deliberate: NO
 * database is a warning (the API falls back to in-memory stores and still
 * works, just without durability), while a database that is wired but not
 * answering is a BLOCKER — the stores bound themselves to Postgres at boot, so
 * every write during the event would fail. "Worse than nothing" is the honest
 * reading, and the earlier boolean could not express it.
 */
export function lintDurability(probe: DurabilityProbe): PreflightCheck {
  switch (probe.kind) {
    case 'reachable':
      return {
        id: 'durability',
        label: 'Saved data',
        status: 'ready',
        detail: `Postgres answered a live check in ${probe.latencyMs}ms, so orders and settings survive a restart.`,
      };
    case 'unreachable':
      return {
        id: 'durability',
        label: 'Saved data',
        status: 'blocker',
        detail: `This API is wired to Postgres, but the database did not answer just now (${probe.message}). Orders, carts and settings written during the event would fail to save.`,
        remedy: 'Bring Postgres back up (docker compose up -d), then run this check again before going live.',
      };
    case 'unknown':
      return {
        id: 'durability',
        label: 'Saved data',
        status: 'unknown',
        detail: `Postgres is configured, but it did not answer in time (${probe.message}), so whether your data will be saved could not be established.`,
        remedy: 'Run the check again. If it keeps timing out, treat the database as down and look into it before going live.',
      };
    case 'absent':
      return {
        id: 'durability',
        label: 'Saved data',
        status: 'warning',
        detail: 'Running without a database: orders, carts and settings are held in memory and are lost if the API restarts.',
        remedy: 'Start Postgres (docker compose up -d) before a real event.',
      };
  }
}

export function buildPreflightReport(input: PreflightInput): PreflightReport {
  const now = input.now ?? Date.now;
  const checks: PreflightCheck[] = [
    ...lintEventConfig(input.config),
    ...lintPricingPolicy(input.policy),
    lintDurability(input.durability),
  ];
  const blockers = checks.filter((check) => check.status === 'blocker').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const unknowns = checks.filter((check) => check.status === 'unknown').length;
  return {
    eventId: input.eventId,
    ranAt: new Date(now()).toISOString(),
    ready: blockers === 0 && unknowns === 0,
    blockers,
    warnings,
    unknowns,
    checks,
  };
}

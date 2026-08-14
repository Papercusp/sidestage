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
  /** True only when nothing is blocking. Warnings do not stop a launch. */
  ready: boolean;
  blockers: number;
  warnings: number;
  checks: PreflightCheck[];
}

export interface PreflightInput {
  eventId: string;
  config: EventConfig;
  /** The policy the saved config actually produces — what the guard will enforce. */
  policy: CopilotPolicy;
  /** Whether a Postgres pool is wired. Null/undefined means "no database". */
  hasDatabase: boolean;
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

export function lintDurability(hasDatabase: boolean): PreflightCheck {
  return hasDatabase
    ? {
      id: 'durability',
      label: 'Saved data',
      status: 'ready',
      detail: 'Postgres is connected, so orders and settings survive a restart.',
    }
    : {
      id: 'durability',
      label: 'Saved data',
      status: 'warning',
      detail: 'Running without a database: orders, carts and settings are held in memory and are lost if the API restarts.',
      remedy: 'Start Postgres (docker compose up -d) before a real event.',
    };
}

export function buildPreflightReport(input: PreflightInput): PreflightReport {
  const now = input.now ?? Date.now;
  const checks: PreflightCheck[] = [
    ...lintEventConfig(input.config),
    ...lintPricingPolicy(input.policy),
    lintDurability(input.hasDatabase),
  ];
  const blockers = checks.filter((check) => check.status === 'blocker').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return {
    eventId: input.eventId,
    ranAt: new Date(now()).toISOString(),
    ready: blockers === 0,
    blockers,
    warnings,
    checks,
  };
}

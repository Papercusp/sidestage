import { createHash } from 'node:crypto';
import { COPILOT_TONES } from '../copilot/copilot.types';
import type {
  AutomationDecision,
  AutomationLevel,
  AutomationPolicy,
  CopilotPolicy,
  PolicyBody,
  ProviderCapabilities,
  ValidationFinding,
  ValidationSummary,
} from './policy.types';

/**
 * Deterministic policy pipeline (P-114, docs/config-policies.md §Validation):
 * parse → normalize (idempotent) → cross-field invariants → capability checks →
 * versioned guardrails → fingerprint. Validation is side-effect free; the
 * service owns persistence.
 */

export const GUARDRAIL_VERSION = 'sidestage-guardrails-v1';

/** Versioned platform bounds — returned with validation, evaluated server-side. */
export const GUARDRAILS_V1 = {
  'returns.windowDays': { min: 0, max: 90 },
  'returns.restockingFeeBps': { min: 0, max: 1_500, reviewAboveBps: 1_500 },
  'returns.warrantyMonths': { min: 0, max: 12 },
  'shipping.handlingDays': { min: 0, max: 30 },
  'shipping.transitDays': { min: 0, max: 60 },
  'shipping.flatRateCents': { min: 0, max: 200_000 },
  'shipping.freeShippingMinimumCents': { min: 0, max: 10_000_000 },
  'payment.paymentDueMinutes': { min: 5, max: 2_880 },
  'payment.sellerCancellationMinutes': { min: 0, max: 10_080 },
  'automation.confidenceFloor': { min: 0, max: 1, autoFloor: 0.85 },
  'automation.maxPriceDeltaBps': { min: 0, max: 2_000 },
  'automation.maxOrderValueCents': { min: 0, max: 500_000 },
} as const;

export type GuardrailBoundId = keyof typeof GUARDRAILS_V1;

const RETURN_CONDITIONS = ['sealed', 'unused', 'used', 'damaged'] as const;
const FINAL_SALE_REASONS = ['perishable', 'custom', 'digital', 'safety'] as const;
const RATE_MODES = ['free', 'flat', 'calculated'] as const;
const SERVICE_LEVELS = ['standard', 'expedited', 'local_pickup'] as const;
const PAYMENT_METHODS = ['card', 'wallet'] as const;
const CAPTURE_MODES = ['on_order', 'on_fulfillment'] as const;
const AUTOMATION_LEVELS = ['suggest', 'confirm', 'auto'] as const;
const TONES = COPILOT_TONES;
const ACTION_KINDS = ['markdown', 'price-adjust', 'targeted-offer', 'push', 'swap', 'stock-adjust'] as const;

/** Platform baseline (docs/config-policies.md): Restart-compatible resale defaults. */
export function baselinePolicyBody(): PolicyBody {
  return {
    returns: {
      accepted: true,
      windowDays: 30,
      returnShipping: 'buyer',
      restockingFeeBps: 0,
      acceptedConditions: ['sealed', 'unused'],
      finalSaleReasons: [],
      warrantyMonths: 12,
    },
    shipping: {
      rateMode: 'calculated',
      flatRateCents: null,
      currency: 'USD',
      handlingDays: 2,
      transitDays: { min: 2, max: 7 },
      serviceLevel: 'standard',
      shipsTo: ['US'],
      freeShippingMinimumCents: null,
      insuranceIncluded: false,
    },
    payment: {
      methods: ['card'],
      authorizationRequired: true,
      captureMode: 'on_order',
      paymentDueMinutes: 30,
      allowPartialPayment: false,
      sellerCancellationMinutes: 30,
    },
    automation: {
      automationLevel: 'confirm',
      allowAutoActions: false,
      priceFloorCentsByProduct: {},
      maxMarkdownPercent: 20,
      blockedActionKinds: [],
      tone: 'warm',
      confidenceFloor: 0.85,
      maxOrderValueCents: 500_000,
    },
  };
}

export class PolicyParseError extends Error {
  constructor(readonly findings: ValidationFinding[]) {
    super(findings[0]?.message ?? 'policy payload is invalid');
  }
}

function err(code: string, path: string, observed: unknown, message: string, boundId: GuardrailBoundId | null = null): ValidationFinding {
  return { severity: 'error', code, path, observed, boundId, message };
}

function warn(code: string, path: string, observed: unknown, message: string, boundId: GuardrailBoundId | null = null): ValidationFinding {
  return { severity: 'warning', code, path, observed, boundId, message };
}

type Parser = {
  findings: ValidationFinding[];
};

function readObject(p: Parser, value: unknown, path: string, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be an object`));
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) p.findings.push(err('POLICY_UNKNOWN_FIELD', `${path}/${key}`, record[key], `unknown field ${path}/${key}`));
  }
  return record;
}

function readBool(p: Parser, value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be a boolean`));
    return false;
  }
  return value;
}

function readInt(p: Parser, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be a non-negative integer`));
    return 0;
  }
  return value;
}

function readIntOrNull(p: Parser, value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return readInt(p, value, path);
}

function readEnum<T extends string>(p: Parser, value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be one of ${allowed.join(', ')}`));
    return allowed[0];
  }
  return value as T;
}

function readEnumArray<T extends string>(p: Parser, value: unknown, path: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be an array`));
    return [];
  }
  const seen = new Set<string>();
  const out: T[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) {
      p.findings.push(err('POLICY_FIELD_INVALID', `${path}/${i}`, entry, `${path} entries must be one of ${allowed.join(', ')}`));
      return;
    }
    if (seen.has(entry)) {
      p.findings.push(err('POLICY_DUPLICATE_ENTRY', `${path}/${i}`, entry, `${path} must not repeat ${entry}`));
      return;
    }
    seen.add(entry);
    out.push(entry as T);
  });
  return out.sort();
}

const COUNTRY_RE = /^[A-Z]{2}$/;

function readCountries(p: Parser, value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be an array of ISO 3166-1 alpha-2 codes`));
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || !COUNTRY_RE.test(entry)) {
      p.findings.push(err('POLICY_COUNTRY_INVALID', `${path}/${i}`, entry, `${path} entries must be uppercase ISO 3166-1 alpha-2 codes`));
      return;
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  });
  return out.sort();
}

function readUnit(p: Parser, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    p.findings.push(err('POLICY_FIELD_INVALID', path, value, `${path} must be a number between 0 and 1`));
    return 0;
  }
  return value;
}

/**
 * Parse + normalize an untyped policy body. Rejects unknown fields, wrong
 * types, decimal cents, and malformed country codes; sorts every list and
 * canonicalizes representation so normalization is idempotent and the
 * fingerprint is stable. Throws PolicyParseError on any structural finding.
 */
export function normalizePolicyBody(input: unknown): PolicyBody {
  const p: Parser = { findings: [] };
  const root = readObject(p, input, '', ['returns', 'shipping', 'payment', 'automation']);
  if (!root) throw new PolicyParseError(p.findings);

  const returnsRaw = readObject(p, root.returns, '/returns', [
    'accepted', 'windowDays', 'returnShipping', 'restockingFeeBps', 'acceptedConditions', 'finalSaleReasons', 'warrantyMonths',
  ]) ?? {};
  const shippingRaw = readObject(p, root.shipping, '/shipping', [
    'rateMode', 'flatRateCents', 'currency', 'handlingDays', 'transitDays', 'serviceLevel', 'shipsTo', 'freeShippingMinimumCents', 'insuranceIncluded',
  ]) ?? {};
  const paymentRaw = readObject(p, root.payment, '/payment', [
    'methods', 'authorizationRequired', 'captureMode', 'paymentDueMinutes', 'allowPartialPayment', 'sellerCancellationMinutes',
  ]) ?? {};
  const automationRaw = readObject(p, root.automation, '/automation', [
    'automationLevel', 'allowAutoActions', 'priceFloorCentsByProduct', 'maxMarkdownPercent', 'blockedActionKinds', 'tone', 'confidenceFloor', 'maxOrderValueCents',
  ]) ?? {};

  const transitRaw = readObject(p, shippingRaw.transitDays ?? { min: 0, max: 0 }, '/shipping/transitDays', ['min', 'max']) ?? {};

  const floorsRaw = automationRaw.priceFloorCentsByProduct ?? {};
  const floors: Record<string, number> = {};
  if (typeof floorsRaw !== 'object' || floorsRaw === null || Array.isArray(floorsRaw)) {
    p.findings.push(err('POLICY_FIELD_INVALID', '/automation/priceFloorCentsByProduct', floorsRaw, 'priceFloorCentsByProduct must be an object of integer cents'));
  } else {
    for (const key of Object.keys(floorsRaw as Record<string, unknown>).sort()) {
      floors[key] = readInt(p, (floorsRaw as Record<string, unknown>)[key], `/automation/priceFloorCentsByProduct/${key}`);
    }
  }

  const maxMarkdown = automationRaw.maxMarkdownPercent;
  if (typeof maxMarkdown !== 'number' || !Number.isFinite(maxMarkdown) || maxMarkdown < 0 || maxMarkdown > 100) {
    p.findings.push(err('POLICY_FIELD_INVALID', '/automation/maxMarkdownPercent', maxMarkdown, 'maxMarkdownPercent must be between 0 and 100'));
  }

  const body: PolicyBody = {
    returns: {
      accepted: readBool(p, returnsRaw.accepted, '/returns/accepted'),
      windowDays: readInt(p, returnsRaw.windowDays, '/returns/windowDays'),
      returnShipping: readEnum(p, returnsRaw.returnShipping, '/returns/returnShipping', ['buyer', 'seller'] as const),
      restockingFeeBps: readInt(p, returnsRaw.restockingFeeBps, '/returns/restockingFeeBps'),
      acceptedConditions: readEnumArray(p, returnsRaw.acceptedConditions, '/returns/acceptedConditions', RETURN_CONDITIONS),
      finalSaleReasons: readEnumArray(p, returnsRaw.finalSaleReasons, '/returns/finalSaleReasons', FINAL_SALE_REASONS),
      warrantyMonths: readInt(p, returnsRaw.warrantyMonths, '/returns/warrantyMonths'),
    },
    shipping: {
      rateMode: readEnum(p, shippingRaw.rateMode, '/shipping/rateMode', RATE_MODES),
      flatRateCents: readIntOrNull(p, shippingRaw.flatRateCents, '/shipping/flatRateCents'),
      currency: readEnum(p, shippingRaw.currency, '/shipping/currency', ['USD'] as const),
      handlingDays: readInt(p, shippingRaw.handlingDays, '/shipping/handlingDays'),
      transitDays: {
        min: readInt(p, transitRaw.min, '/shipping/transitDays/min'),
        max: readInt(p, transitRaw.max, '/shipping/transitDays/max'),
      },
      serviceLevel: readEnum(p, shippingRaw.serviceLevel, '/shipping/serviceLevel', SERVICE_LEVELS),
      shipsTo: readCountries(p, shippingRaw.shipsTo, '/shipping/shipsTo'),
      freeShippingMinimumCents: readIntOrNull(p, shippingRaw.freeShippingMinimumCents, '/shipping/freeShippingMinimumCents'),
      insuranceIncluded: readBool(p, shippingRaw.insuranceIncluded, '/shipping/insuranceIncluded'),
    },
    payment: {
      methods: readEnumArray(p, paymentRaw.methods, '/payment/methods', PAYMENT_METHODS),
      authorizationRequired: readBool(p, paymentRaw.authorizationRequired, '/payment/authorizationRequired'),
      captureMode: readEnum(p, paymentRaw.captureMode, '/payment/captureMode', CAPTURE_MODES),
      paymentDueMinutes: readInt(p, paymentRaw.paymentDueMinutes, '/payment/paymentDueMinutes'),
      allowPartialPayment: readBool(p, paymentRaw.allowPartialPayment, '/payment/allowPartialPayment'),
      sellerCancellationMinutes: readInt(p, paymentRaw.sellerCancellationMinutes, '/payment/sellerCancellationMinutes'),
    },
    automation: {
      automationLevel: readEnum(p, automationRaw.automationLevel, '/automation/automationLevel', AUTOMATION_LEVELS),
      allowAutoActions: readBool(p, automationRaw.allowAutoActions, '/automation/allowAutoActions'),
      priceFloorCentsByProduct: floors,
      maxMarkdownPercent: typeof maxMarkdown === 'number' && Number.isFinite(maxMarkdown) ? maxMarkdown : 0,
      blockedActionKinds: readEnumArray(p, automationRaw.blockedActionKinds, '/automation/blockedActionKinds', ACTION_KINDS),
      tone: readEnum(p, automationRaw.tone, '/automation/tone', TONES),
      confidenceFloor: readUnit(p, automationRaw.confidenceFloor, '/automation/confidenceFloor'),
      maxOrderValueCents: readInt(p, automationRaw.maxOrderValueCents, '/automation/maxOrderValueCents'),
    },
  };

  if (p.findings.length > 0) throw new PolicyParseError(p.findings);
  return body;
}

function bound(p: ValidationFinding[], id: GuardrailBoundId, path: string, value: number): boolean {
  const b = GUARDRAILS_V1[id];
  if (value < b.min || value > b.max) {
    p.push(err('POLICY_BOUND_EXCEEDED', path, value, `${path} must be between ${b.min} and ${b.max}`, id));
    return false;
  }
  return true;
}

/**
 * Cross-field invariants + capability checks + versioned guardrails over a
 * NORMALIZED body. Side-effect free; deterministic ordering.
 */
export function validatePolicyBody(body: PolicyBody, capabilities: ProviderCapabilities): ValidationSummary {
  const f: ValidationFinding[] = [];
  const { returns, shipping, payment, automation } = body;

  // Returns
  bound(f, 'returns.windowDays', '/returns/windowDays', returns.windowDays);
  if (!returns.accepted && returns.windowDays !== 0) {
    f.push(err('POLICY_RETURNS_DISABLED_WINDOW', '/returns/windowDays', returns.windowDays, 'windowDays must be 0 when returns are not accepted'));
  }
  if (returns.restockingFeeBps > GUARDRAILS_V1['returns.restockingFeeBps'].reviewAboveBps) {
    f.push(err('POLICY_BOUND_EXCEEDED', '/returns/restockingFeeBps', returns.restockingFeeBps, 'a restocking fee above 15% cannot be auto-published', 'returns.restockingFeeBps'));
  } else if (returns.restockingFeeBps > 1_000) {
    f.push(warn('POLICY_RESTOCKING_FEE_REVIEW', '/returns/restockingFeeBps', returns.restockingFeeBps, 'a restocking fee above 10% is flagged for review', 'returns.restockingFeeBps'));
  }
  if (returns.warrantyMonths > capabilities.extendedWarrantyMonths) {
    f.push(err('POLICY_WARRANTY_CAPABILITY_REQUIRED', '/returns/warrantyMonths', returns.warrantyMonths,
      `a warranty above ${capabilities.extendedWarrantyMonths} months requires a registered platform capability`, 'returns.warrantyMonths'));
  }

  // Shipping
  bound(f, 'shipping.handlingDays', '/shipping/handlingDays', shipping.handlingDays);
  bound(f, 'shipping.transitDays', '/shipping/transitDays/min', shipping.transitDays.min);
  bound(f, 'shipping.transitDays', '/shipping/transitDays/max', shipping.transitDays.max);
  if (shipping.transitDays.min > shipping.transitDays.max) {
    f.push(err('POLICY_TRANSIT_RANGE_INVALID', '/shipping/transitDays', shipping.transitDays, 'transitDays.min must not exceed transitDays.max'));
  }
  if (shipping.serviceLevel === 'local_pickup' && (shipping.transitDays.min !== 0 || shipping.transitDays.max !== 0 || shipping.shipsTo.length !== 0)) {
    f.push(err('POLICY_LOCAL_PICKUP_SHAPE', '/shipping/serviceLevel', shipping.serviceLevel, 'local_pickup requires transitDays 0–0 and an empty shipsTo list'));
  }
  if (shipping.rateMode === 'flat') {
    if (shipping.flatRateCents === null) {
      f.push(err('POLICY_FLAT_RATE_REQUIRED', '/shipping/flatRateCents', null, 'flatRateCents is required in flat mode', 'shipping.flatRateCents'));
    } else {
      bound(f, 'shipping.flatRateCents', '/shipping/flatRateCents', shipping.flatRateCents);
    }
  } else if (shipping.flatRateCents !== null) {
    f.push(err('POLICY_FLAT_RATE_FORBIDDEN', '/shipping/flatRateCents', shipping.flatRateCents, 'flatRateCents must be null outside flat mode'));
  }
  if (shipping.freeShippingMinimumCents !== null) {
    bound(f, 'shipping.freeShippingMinimumCents', '/shipping/freeShippingMinimumCents', shipping.freeShippingMinimumCents);
  }
  if (shipping.handlingDays > shipping.transitDays.max && shipping.serviceLevel !== 'local_pickup') {
    f.push(warn('POLICY_HANDLING_EXCEEDS_TRANSIT', '/shipping/handlingDays', shipping.handlingDays, 'handling above the transit maximum requires review', 'shipping.handlingDays'));
  }

  // Payment
  if (payment.methods.length === 0) {
    f.push(err('POLICY_PAYMENT_METHOD_REQUIRED', '/payment/methods', payment.methods, 'at least one payment method is required'));
  }
  for (const method of payment.methods) {
    if (!capabilities.configuredPaymentMethods.includes(method)) {
      f.push(err('PAYMENT_PROVIDER_UNAVAILABLE', '/payment/methods', method, `no configured provider capability for ${method}`));
    }
  }
  bound(f, 'payment.paymentDueMinutes', '/payment/paymentDueMinutes', payment.paymentDueMinutes);
  if (payment.paymentDueMinutes > 240) {
    f.push(warn('POLICY_PAYMENT_WINDOW_REVIEW', '/payment/paymentDueMinutes', payment.paymentDueMinutes, 'a payment window above 4 hours routes to review', 'payment.paymentDueMinutes'));
  }
  bound(f, 'payment.sellerCancellationMinutes', '/payment/sellerCancellationMinutes', payment.sellerCancellationMinutes);
  if (payment.sellerCancellationMinutes > 0 && payment.sellerCancellationMinutes < payment.paymentDueMinutes) {
    f.push(err('POLICY_CANCELLATION_TOO_SHORT', '/payment/sellerCancellationMinutes', payment.sellerCancellationMinutes, 'sellerCancellationMinutes must be at least paymentDueMinutes when enabled'));
  }

  // Automation
  bound(f, 'automation.confidenceFloor', '/automation/confidenceFloor', automation.confidenceFloor);
  bound(f, 'automation.maxOrderValueCents', '/automation/maxOrderValueCents', automation.maxOrderValueCents);
  if (automation.automationLevel === 'auto' && automation.confidenceFloor < GUARDRAILS_V1['automation.confidenceFloor'].autoFloor) {
    f.push(err('POLICY_CONFIDENCE_FLOOR_TOO_LOW', '/automation/confidenceFloor', automation.confidenceFloor,
      `auto mode requires a confidence floor of at least ${GUARDRAILS_V1['automation.confidenceFloor'].autoFloor}`, 'automation.confidenceFloor'));
  }
  const markdownBps = Math.round(automation.maxMarkdownPercent * 100);
  if (automation.automationLevel === 'auto' && markdownBps > GUARDRAILS_V1['automation.maxPriceDeltaBps'].max) {
    f.push(err('POLICY_PRICE_DELTA_TOO_WIDE', '/automation/maxMarkdownPercent', automation.maxMarkdownPercent,
      'auto mode may not move a price more than 20% from its approved base', 'automation.maxPriceDeltaBps'));
  }

  const errors = f.filter((x) => x.severity === 'error').length;
  const warnings = f.length - errors;
  return { guardrailVersion: GUARDRAIL_VERSION, findings: f, errors, warnings, needsReview: warnings > 0 };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/** Hash of the canonical normalized payload — stable across key order. */
export function policyFingerprint(body: PolicyBody): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex').slice(0, 32);
}

const LEVEL_RANK: Record<AutomationLevel, number> = { suggest: 0, confirm: 1, auto: 2 };

export interface AutomationRequest {
  requestedLevel: AutomationLevel;
  confidence: number;
  priceDeltaBps: number | null; // price move from approved base, when price-bearing
  orderValueCents: number | null;
  hasHardError: boolean;
}

/**
 * The automation ladder: the effective level is the LOWER of the policy level
 * and what guardrail evaluation permits. No LLM proposal executes on
 * enthusiasm — below-floor confidence, wide price deltas, large orders, and
 * hard errors each force the rung down with a stable reason code.
 */
export function decideAutomation(
  policy: AutomationPolicy,
  request: AutomationRequest,
  meta: { policyRevisionId: string | null; auditId: string },
): AutomationDecision {
  const reasonCodes: string[] = [];
  let rank = Math.min(LEVEL_RANK[policy.automationLevel], LEVEL_RANK[request.requestedLevel]);
  if (rank === LEVEL_RANK.auto && !policy.allowAutoActions) {
    rank = LEVEL_RANK.confirm;
    reasonCodes.push('AUTO_ACTIONS_DISABLED');
  }
  if (rank === LEVEL_RANK.auto && request.confidence < policy.confidenceFloor) {
    rank = LEVEL_RANK.confirm;
    reasonCodes.push('CONFIDENCE_BELOW_FLOOR');
  }
  if (rank === LEVEL_RANK.auto && request.confidence < GUARDRAILS_V1['automation.confidenceFloor'].autoFloor) {
    rank = LEVEL_RANK.confirm;
    reasonCodes.push('CONFIDENCE_BELOW_PLATFORM_FLOOR');
  }
  if (rank === LEVEL_RANK.auto && request.priceDeltaBps !== null && request.priceDeltaBps > GUARDRAILS_V1['automation.maxPriceDeltaBps'].max) {
    rank = LEVEL_RANK.confirm;
    reasonCodes.push('PRICE_DELTA_EXCEEDS_BOUND');
  }
  if (rank === LEVEL_RANK.auto && request.orderValueCents !== null
    && (request.orderValueCents > policy.maxOrderValueCents || request.orderValueCents > GUARDRAILS_V1['automation.maxOrderValueCents'].max)) {
    rank = LEVEL_RANK.confirm;
    reasonCodes.push('ORDER_VALUE_REQUIRES_CONFIRMATION');
  }

  let outcome: AutomationDecision['outcome'];
  if (request.hasHardError) {
    outcome = 'blocked';
    reasonCodes.push('GUARDRAIL_HARD_ERROR');
  } else if (rank === LEVEL_RANK.auto) {
    outcome = 'executed';
  } else if (rank === LEVEL_RANK.confirm) {
    outcome = 'awaiting-confirmation';
  } else {
    outcome = 'suggested';
  }

  return {
    requestedLevel: request.requestedLevel,
    effectiveLevel: AUTOMATION_LEVELS[rank],
    outcome,
    reasonCodes,
    policyRevisionId: meta.policyRevisionId,
    guardrailVersion: GUARDRAIL_VERSION,
    auditId: meta.auditId,
  };
}

/**
 * Config-to-copilot projection (docs/config-policies.md §Automation ladder):
 * picks exactly the provider-neutral CopilotPolicy fields so the pipeline
 * cannot be elevated by a request body. confidenceFloor/maxOrderValueCents are
 * ENFORCED by decideAutomation — since WI-38815 the pipeline routes every
 * would-be auto execution through that ladder, so the published policy's
 * floors are carried here as ladder INPUTS (the guard type still never
 * enforces them itself).
 */
export function copilotPolicyFromAutomation(automation: AutomationPolicy): CopilotPolicy {
  return {
    automationLevel: automation.automationLevel,
    allowAutoActions: automation.allowAutoActions,
    priceFloorCentsByProduct: { ...automation.priceFloorCentsByProduct },
    maxMarkdownPercent: automation.maxMarkdownPercent,
    blockedActionKinds: [...automation.blockedActionKinds],
    tone: automation.tone,
    confidenceFloor: automation.confidenceFloor,
    maxOrderValueCents: automation.maxOrderValueCents,
  };
}

import type { CopilotActionKind, CopilotPolicy } from '../copilot/copilot.types';

/**
 * Seller policy contract types (P-114, docs/config-policies.md).
 *
 * Field names, units, and invariants are the contract: integer minor units for
 * money, basis points for percentages, days/minutes for time. Deviation from
 * the doc: `blockedActionKinds` uses the full CopilotActionKind vocabulary
 * (P-115 added push/swap/stock-adjust after the doc was written) — a superset
 * of the doc's three kinds, contract-compatible.
 */

export type PolicyState = 'draft' | 'validated' | 'published' | 'superseded' | 'rejected';

export type ReturnCondition = 'sealed' | 'unused' | 'used' | 'damaged';
export type FinalSaleReason = 'perishable' | 'custom' | 'digital' | 'safety';

export interface ReturnPolicy {
  accepted: boolean;
  windowDays: number;
  returnShipping: 'buyer' | 'seller';
  restockingFeeBps: number;
  acceptedConditions: ReturnCondition[];
  finalSaleReasons: FinalSaleReason[];
  warrantyMonths: number;
}

export type ShippingRateMode = 'free' | 'flat' | 'calculated';
export type ShippingServiceLevel = 'standard' | 'expedited' | 'local_pickup';

export interface ShippingPolicy {
  rateMode: ShippingRateMode;
  flatRateCents: number | null;
  currency: 'USD';
  handlingDays: number;
  transitDays: { min: number; max: number };
  serviceLevel: ShippingServiceLevel;
  shipsTo: string[];
  freeShippingMinimumCents: number | null;
  insuranceIncluded: boolean;
}

export type PaymentMethod = 'card' | 'wallet';
export type CaptureMode = 'on_order' | 'on_fulfillment';

export interface PaymentPolicy {
  methods: PaymentMethod[];
  authorizationRequired: boolean;
  captureMode: CaptureMode;
  paymentDueMinutes: number;
  allowPartialPayment: boolean;
  sellerCancellationMinutes: number;
}

export type AutomationLevel = 'suggest' | 'confirm' | 'auto';

export interface AutomationPolicy {
  automationLevel: AutomationLevel;
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: CopilotActionKind[];
  tone: 'concise' | 'warm' | 'professional';
  confidenceFloor: number;
  maxOrderValueCents: number;
}

export interface PolicyBody {
  returns: ReturnPolicy;
  shipping: ShippingPolicy;
  payment: PaymentPolicy;
  automation: AutomationPolicy;
}

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  observed: unknown;
  boundId: string | null;
  message: string;
}

export interface ValidationSummary {
  guardrailVersion: string;
  findings: ValidationFinding[];
  errors: number;
  warnings: number;
  needsReview: boolean;
}

export interface SellerPolicyRevision {
  id: string;
  sellerId: string;
  eventId: string | null;
  revision: number;
  state: PolicyState;
  returns: ReturnPolicy;
  shipping: ShippingPolicy;
  payment: PaymentPolicy;
  automation: AutomationPolicy;
  policyFingerprint: string;
  validationSummary: ValidationSummary;
  createdBy: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EffectiveSource = 'event' | 'seller' | 'baseline';

export interface EffectivePolicy {
  source: EffectiveSource;
  policyRevisionId: string | null; // null when the platform baseline applies
  policyFingerprint: string;
  revision: number | null;
  sellerId: string;
  eventId: string | null;
  body: PolicyBody;
}

export type PolicyAuditAction =
  | 'draft_created'
  | 'draft_updated'
  | 'validated'
  | 'published'
  | 'superseded'
  | 'automation_applied'
  | 'automation_queued'
  | 'rejected';

export interface PolicyAuditEntry {
  id: string;
  sellerId: string;
  eventId: string | null;
  policyRevisionId: string | null;
  actorType: 'seller' | 'operator' | 'copilot' | 'system';
  actorId: string;
  action: PolicyAuditAction;
  requestId: string;
  correlationId: string;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  guardrailVersion: string;
  decision: 'allowed' | 'review' | 'rejected';
  reasonCodes: string[];
  createdAt: string;
}

export interface PolicyOutboxEvent {
  id: string;
  name: string;
  payload: {
    eventId: string;
    sellerId: string;
    scopeEventId: string | null;
    policyRevisionId: string;
    revision: number;
    policyFingerprint: string;
    occurredAt: string;
    correlationId: string;
  };
  createdAt: string;
}

export interface AutomationDecision {
  requestedLevel: AutomationLevel;
  effectiveLevel: AutomationLevel;
  outcome: 'executed' | 'awaiting-confirmation' | 'suggested' | 'blocked';
  reasonCodes: string[];
  policyRevisionId: string | null;
  guardrailVersion: string;
  auditId: string;
}

/** Provider capabilities resolved server-side (never from the client). */
export interface ProviderCapabilities {
  configuredPaymentMethods: PaymentMethod[];
  extendedWarrantyMonths: number; // max months a registered capability allows (baseline 12)
}

export type { CopilotPolicy };

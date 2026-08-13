# Seller policy and automation contract

Status: P-021 design artifact (WI-38480).

This document defines the Config tab contract for seller policies, policy
validation, automation guardrails, audit records, and sync behavior. It is a
design contract for the API and UI work that follows; it does not add a second
commerce-policy implementation to Restart.

## Goals and ownership

The Config tab lets a seller manage the terms that apply to a SideStage event
and its listings:

- returns and the resale warranty;
- shipping and handling;
- payment and order-capture behavior; and
- the automation level and limits used by the live-selling copilot.

The policy is attached to a seller and optionally an event. A listing may
reference a policy set, but a product variant remains the catalog/inventory
identity described by `docs/variations-schema.md`. Policy changes must never
create a second variant table or duplicate inventory state.

There are three distinct authorities:

| Concern | Authority | Consequence |
| --- | --- | --- |
| Product title, images, attributes, variant identity, and stock | SideStage catalog and inventory model | Policy code reads `variant_id`; it does not rewrite catalog data. |
| Existing resale defaults during the Restart import | Restart `apps/shop/src/lib/policy.ts` and the imported order defaults | Preserve a 12-month resale warranty and 30-day return window unless a published SideStage policy explicitly overrides the seller-facing terms. |
| A seller's current event terms | SideStage `seller_policy_sets` and its immutable revisions | Checkout, the event UI, automation, and audit records resolve one published revision. |

The intake metadata in Restart (`inventory_item.warranty`) is manufacturer or
intake history, not the resale promise. It must not be surfaced as the Config
tab's warranty policy.

## Policy lifecycle

Policies are immutable revisions behind a small state machine:

```text
draft -> validated -> published -> superseded
  \-> rejected
published -> draft (new revision only; never mutate a published revision)
```

`draft` is editable by the seller. `validated` has passed structural and
guardrail checks but is not yet the effective policy. `published` is the only
state that a new listing, checkout, or copilot action may resolve. Publishing a
new revision atomically supersedes the previous revision for the same seller
and event scope. A rejected draft remains inspectable with its validation
errors. A published revision is never deleted; retention and privacy policies
may redact actor metadata, but not the policy values needed to explain an
order.

The effective scope is selected in this order:

1. a published event policy for the current event;
2. a published seller policy when the event has no override; or
3. the platform baseline policy.

The resolver returns the selected revision id and a `policyFingerprint` (a
hash of normalized values). Consumers store both with an order, listing, or
automation decision so a later policy edit cannot silently change historical
meaning.

## Normalized data model

The names below are logical names. P-001 owns the migration shape and may use
Drizzle camelCase properties, but the fields, units, and invariants are part of
this contract.

### Policy set and revision

```ts
type PolicyScope = {
  sellerId: string;
  eventId: string | null; // null means seller-wide
};

type SellerPolicyRevision = {
  id: string;
  sellerId: string;
  eventId: string | null;
  revision: number; // monotonic within sellerId + eventId
  state: "draft" | "validated" | "published" | "superseded" | "rejected";
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
};
```

The database enforces a unique `(seller_id, event_id, revision)` and at most
one `published` revision per `(seller_id, event_id)`. The API must enforce
optimistic concurrency with `expectedRevision`/`If-Match`; a stale update
returns `409 POLICY_REVISION_CONFLICT` instead of overwriting another tab's
work.

### Returns

```ts
type ReturnPolicy = {
  accepted: boolean;
  windowDays: number;
  returnShipping: "buyer" | "seller";
  restockingFeeBps: number;
  acceptedConditions: Array<"sealed" | "unused" | "used" | "damaged">;
  finalSaleReasons: Array<"perishable" | "custom" | "digital" | "safety">;
  warrantyMonths: number;
};
```

`windowDays` is measured from delivery confirmation. The platform baseline is
`accepted: true`, `windowDays: 30`, `returnShipping: "buyer"`,
`restockingFeeBps: 0`, and `warrantyMonths: 12`, matching Restart's existing
resale defaults. A seller can narrow or extend the published terms only within
the guardrails below; a product's imported warranty metadata is not a source
for `warrantyMonths`.

### Shipping

```ts
type ShippingPolicy = {
  rateMode: "free" | "flat" | "calculated";
  flatRateCents: number | null;
  currency: "USD"; // extend by an explicit currency decision
  handlingDays: number;
  transitDays: { min: number; max: number };
  serviceLevel: "standard" | "expedited" | "local_pickup";
  shipsTo: string[]; // ISO 3166-1 alpha-2 country codes
  freeShippingMinimumCents: number | null;
  insuranceIncluded: boolean;
};
```

`flatRateCents` is required only for `flat`; it is `null` for the other modes.
`local_pickup` uses `transitDays: { min: 0, max: 0 }` and an empty `shipsTo`
list. The initial public contract is USD and country-code based so a clean
clone can validate it deterministically; multi-currency and postal-region
rules require a later versioned extension.

### Payment

```ts
type PaymentPolicy = {
  methods: Array<"card" | "wallet">;
  authorizationRequired: boolean;
  captureMode: "on_order" | "on_fulfillment";
  paymentDueMinutes: number;
  allowPartialPayment: boolean;
  sellerCancellationMinutes: number;
};
```

SideStage stores provider tokens or payment-intent ids, never card numbers,
CVCs, or other raw payment credentials. `methods` describes accepted provider
rails, not a promise that a provider is configured. The API rejects a published
policy whose selected method has no configured provider capability, while the
UI shows the capability error without exposing secrets.

## Baseline guardrails

Guardrails are versioned platform constants, returned in the policy validation
response, and evaluated server-side. Client limits are usability hints only.
Every threshold has an explicit unit; percentages are basis points and money
is integer minor units. `null` is not used as an accidental bypass.

| Field | Default bound | Rule |
| --- | ---: | --- |
| `returns.windowDays` | 0–90 days | Must be zero when `accepted` is false; the baseline is 30. |
| `returns.restockingFeeBps` | 0–1,500 bps | A fee above 15% requires human review and cannot be auto-published. |
| `returns.warrantyMonths` | 0–12 months | The baseline is 12; a value above 12 requires a separately registered platform capability. |
| `shipping.handlingDays` | 0–30 days | Must not exceed `transitDays.max` without a warning and human review. |
| `shipping.transitDays` | 0–60 days | `min <= max`; local pickup is exactly 0–0. |
| `shipping.flatRateCents` | 0–200,000 cents | Required in flat mode and rejected above $2,000. |
| `shipping.freeShippingMinimumCents` | 0–10,000,000 cents | Required only when configured; must be >= the lowest sellable listing price. |
| `payment.paymentDueMinutes` | 5–2,880 minutes | The default is 30 minutes; longer windows route to review. |
| `payment.sellerCancellationMinutes` | 0–10,080 minutes | Must be at least `paymentDueMinutes` when seller cancellation is enabled. |
| automation confidence | 0–1 | Copilot suggestions below 0.85 cannot be auto-applied. |
| automated price delta | 0–2,000 bps | A bounded auto action may not move a price more than 20% from its approved base. |
| automated order value | 0–500,000 cents | Above $5,000 always requires seller confirmation. |

Validation produces typed findings with `severity: "error" | "warning"`, a
stable `code`, a JSON-pointer `path`, the observed value, the applicable bound
id, and a remediation message. Errors block validation and publication.
Warnings permit a draft but force the next automation rung down and mark the
publish action `needsReview: true`. Do not log payment tokens or customer PII
in a finding.

The guardrail constants are not a substitute for fraud, tax, carrier, or legal
decisions. Those systems can add a stricter rejection, but they must not widen
these bounds implicitly.

## Automation ladder

Automation level is explicit on every revision and can be lowered per action.
The v1 API uses the same string vocabulary as the grounded copilot pipeline:
`automationLevel: "suggest" | "confirm" | "auto"`, plus the independent
`allowAutoActions` boolean. The effective level is the lower of the policy
level, the action's required level, and the result of guardrail evaluation.

| Level | API value | Allowed behavior | Never allowed at this level |
| ---: | --- | --- | --- |
| 0 | `suggest` | Draft copy, show policy suggestions, and explain warnings. | Any persistent policy, price, inventory, order, refund, or payment write. |
| 1 | `confirm` | Save a draft and queue a proposed policy/listing change for seller approval. | Publish, capture, refund, or change inventory without approval. |
| 2 | `auto` | Auto-apply normalized changes inside the thresholds above, only through the audited executor and only when `allowAutoActions` is true. | Payment capture, refunds, price changes outside the delta, or any action with a hard error. |

The initial Config tab default is level 1 (`confirm`) with
`allowAutoActions: false`. A seller may choose `suggest` or `auto` after seeing
the effective limits. A future higher-trust mode is intentionally not accepted
by the v1 type; it requires a separately registered capability and a versioned
contract rather than silently widening `auto`. The level is a control-plane
setting, not an authorization grant: server-side role checks, seller
ownership, provider state, and event state still apply.

The Config-to-copilot projection must preserve the existing provider-neutral
fields so the pipeline cannot be elevated by a request body:

```ts
type AutomationPolicy = {
  automationLevel: "suggest" | "confirm" | "auto";
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: Array<"markdown" | "price-adjust" | "targeted-offer">;
  tone: "concise" | "warm" | "professional";
  confidenceFloor: number;
  maxOrderValueCents: number;
};
```

Each copilot action returns an `automationDecision`:

```ts
type AutomationDecision = {
  requestedLevel: "suggest" | "confirm" | "auto";
  effectiveLevel: "suggest" | "confirm" | "auto";
  outcome: "executed" | "awaiting-confirmation" | "suggested" | "blocked";
  reasonCodes: string[];
  policyRevisionId: string;
  guardrailVersion: string;
  auditId: string;
};
```

No action is considered successful merely because an LLM proposed it. The
proposal must be normalized, validated, authorized, and recorded before an
`applied` result is returned.

## Config tab interaction contract

The tab loads the effective policy and the editable seller/event draft in one
request. It renders four sections: Returns, Shipping, Payment, and Copilot
automation. Each section shows the normalized value, its unit, the current
guardrail, and whether the value is inherited or event-specific.

Required UI behavior:

1. Use integer cents, days, minutes, and basis points in the API model; format
   dollars and percentages only at the edge.
2. Show cross-field errors beside every affected field and a summary with
   stable error codes. Do not allow a submit button to hide a server finding.
3. Preview the effective policy before publish, including the selected scope,
   revision, warranty/return defaults, shipping estimate mode, payment methods,
   and automation level.
4. Save creates or updates a draft with the revision token. Publish performs
   validate-then-publish and reports a stale-revision conflict with a reload
   action rather than discarding local edits.
5. A lower automation level takes effect immediately for new decisions. An
   in-flight action keeps the policy revision it recorded when it began.
6. Payment fields never accept or display card data. A missing provider is an
   actionable capability error, not an invitation to paste a secret into the
   form.

## API contract

The NestJS API should expose these resource-oriented routes. Authentication
and seller/event scope come from the request principal; a client-supplied
seller id cannot widen access.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/seller/policies/effective?eventId=` | Resolve the effective policy, revision, fingerprint, and inheritance source. |
| `GET` | `/v1/seller/policies/:id` | Read a draft or immutable revision the seller may inspect. |
| `POST` | `/v1/seller/policies` | Create a draft for seller-wide or event scope. Requires an idempotency key. |
| `PATCH` | `/v1/seller/policies/:id` | Update a draft with `If-Match`/expected revision. |
| `POST` | `/v1/seller/policies/:id/validate` | Run structural, capability, and guardrail validation without publishing. |
| `POST` | `/v1/seller/policies/:id/publish` | Validate and atomically publish; accepts an expected revision. |
| `GET` | `/v1/seller/policies/:id/audit` | Return policy and automation audit entries visible to the seller. |

Success responses use `{ data, requestId }`. Errors use
`{ error: { code, message, fields? }, requestId }`. Stable codes include:
`POLICY_NOT_FOUND`, `POLICY_SCOPE_FORBIDDEN`, `POLICY_REVISION_CONFLICT`,
`POLICY_VALIDATION_FAILED`, `POLICY_GUARDRAIL_REVIEW_REQUIRED`,
`PAYMENT_PROVIDER_UNAVAILABLE`, `POLICY_NOT_PUBLISHABLE`, and
`IDEMPOTENCY_REPLAY`.

Mutation rules:

- Every mutating request accepts an idempotency key scoped to seller and route.
- A duplicate key with the same request hash returns the original result; a
  duplicate key with a different hash returns `IDEMPOTENCY_REPLAY`.
- `PATCH` is draft-only. Publishing is a separate command and never silently
  follows a save.
- The publish transaction locks the policy scope, rechecks the expected
  revision and provider capabilities, writes the immutable revision state,
  appends an audit record, and writes one sync/outbox event before commit.
- API latency instrumentation must record time to first response and complete
  response for copilot-assisted validation. The contest target is a measured
  sub-2-second p50/p95 reply budget, not an unmeasured UX claim.

## Audit and sync contract

Every read that resolves an effective policy includes `policyRevisionId` and
`policyFingerprint` in the response metadata. Every write and automation
decision creates an immutable audit row:

```ts
type PolicyAuditEntry = {
  id: string;
  sellerId: string;
  eventId: string | null;
  policyRevisionId: string | null;
  actorType: "seller" | "operator" | "copilot" | "system";
  actorId: string;
  action: "draft_created" | "draft_updated" | "validated" | "published" |
    "superseded" | "automation_applied" | "automation_queued" | "rejected";
  requestId: string;
  correlationId: string;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  guardrailVersion: string;
  decision: "allowed" | "review" | "rejected";
  reasonCodes: string[];
  createdAt: string;
};
```

Audit entries contain normalized policy diffs and fingerprints, never raw card
data, provider secrets, or unnecessary customer address data. They are the
explanation source for a seller-facing history view and for contest review.

The outbox/sync event is emitted in the same database transaction as the
revision and audit row. Event names are versioned:

```text
sidestage.seller-policy.v1.draft-updated
sidestage.seller-policy.v1.validated
sidestage.seller-policy.v1.published
sidestage.seller-policy.v1.superseded
sidestage.automation.v1.decision-recorded
```

Each event carries `eventId`, `sellerId`, `eventId` (as `scopeEventId` in the
payload to avoid ambiguity), `policyRevisionId`, `revision`,
`policyFingerprint`, `occurredAt`, and `correlationId`. Consumers apply events
idempotently by event id and ignore a lower revision for the same scope. The
sync adapter must use the existing `@papercusp/sync` seam; it must not create a
second websocket or ad-hoc polling channel. A failed delivery is retried from
the outbox without duplicating the audit row.

## Validation pipeline

Validation is deterministic and ordered so the UI can explain the first useful
failure without allowing a partial write:

1. Parse the DTO and reject unknown fields, invalid enum values, non-integer
   amounts, negative numbers, and malformed country codes.
2. Normalize ordering and representation: sort methods/countries/reason codes,
   canonicalize booleans, and convert money/percentages to their integer units.
3. Check cross-field invariants (`flatRateCents`, transit ranges, accepted
   returns, payment timing, and automation constraints).
4. Resolve the seller/event scope and provider capabilities from the server;
   never trust client-provided scope or capability claims.
5. Evaluate the versioned guardrail registry and produce stable findings.
6. Compute the fingerprint from the canonical normalized payload.
7. Persist only after all errors are absent. Warnings mark the draft for review
   and can lower the effective automation level.

Normalization must be idempotent: applying it twice yields the same payload and
fingerprint. Validation must be side-effect free; publication owns the
transaction that writes state, audit, and outbox data.

## Test and acceptance matrix

The implementation is complete only when the following tests ship with the
feature:

| Area | Required assertions |
| --- | --- |
| Schema/normalization | Valid baseline normalizes to the same payload/fingerprint twice; unknown fields, decimal cents, invalid enums, duplicate methods, and bad country codes fail with stable paths. |
| Returns | 30-day/12-month baseline is accepted; disabled returns require a zero window; 91 days, >15% fee, and warranty above 12 months produce the documented findings. |
| Shipping | Free/flat/calculated modes enforce their required fields; transit `min <= max`; local pickup is 0–0; rate and handling ceilings reject or warn at the stated bounds. |
| Payment | Provider capability is checked server-side; payment timing bounds and capture modes are enforced; request fixtures contain no raw card data. |
| Automation | Levels 0–2 produce the exact allowed outcomes; low confidence, hard guardrails, >20% price deltas, and >$5,000 orders cannot be auto-applied; every decision has an audit id. |
| Concurrency | Stale `If-Match` returns 409 without changing the draft; two publishes serialize and leave exactly one current published revision. |
| Idempotency | Replaying the same mutation key returns the original result; changing the request under an existing key fails; retries do not duplicate audit or outbox rows. |
| Audit/sync | Publish writes policy, audit, and outbox atomically; a rolled-back transaction writes none; duplicate and out-of-order events converge to the newest revision. |
| API | Route responses use the documented envelope/codes, enforce seller scope, expose revision/fingerprint metadata, and preserve request/correlation ids. |
| UI | Config tab loads inherited and event-specific values, renders server findings, handles revision conflicts without data loss, previews effective policy, and never renders a payment secret field. |
| Clean clone | From a clean clone with initialized submodules: `npm install`, `npm run check`, and `npm run build` pass using only `.env.example` placeholders. |

The test suite must include at least one end-to-end path from Config tab save to
validated publish, effective-policy resolution, sync event, and audit history.
The latency test records TTFT and complete-response p50/p95 for the copilot
validation path and reports the measured values alongside the pass/fail result.

## Non-goals and compatibility

- Do not edit Restart's `policy.ts` or copy its implementation into SideStage;
  use the documented defaults as the import compatibility baseline.
- Do not attach policy fields to `product_catalog` or
  `storefront_product`; policy scope is seller/event, while variants remain
  the inventory identity.
- Do not store payment credentials, secrets, or production-sized catalog data
  in this public repository.
- Do not add a polling-based sync loop. Use the existing shared sync/outbox
  seam and make delivery idempotent.
- Do not let an automation level bypass authorization, provider capability,
  guardrails, audit, or the measured response budget.

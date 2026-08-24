import { describe, expect, it, vi } from 'vitest';
import {
  GUARDRAIL_VERSION,
  PolicyParseError,
  baselinePolicyBody,
  copilotPolicyFromAutomation,
  decideAutomation,
  normalizePolicyBody,
  policyFingerprint,
  validatePolicyBody,
} from './policy-rules';
import {
  IDEMPOTENCY_RETENTION_MS,
  InMemoryPolicyStore,
  PolicyError,
  PolicyService,
  type RequestContext,
} from './policy.service';
import type { PolicyBody, ProviderCapabilities } from './policy.types';
import { COPILOT_TONES } from '../copilot/copilot.types';

const CAPS: ProviderCapabilities = { configuredPaymentMethods: ['card', 'wallet'], extendedWarrantyMonths: 12 };

const ctx: RequestContext = { requestId: 'req_test', correlationId: 'corr_test', actorType: 'seller', actorId: 'demo-seller' };

function body(overrides: (b: PolicyBody) => void = () => {}): PolicyBody {
  const b = baselinePolicyBody();
  overrides(b);
  return b;
}

function harness() {
  const store = new InMemoryPolicyStore();
  const service = new PolicyService(store, CAPS);
  return { store, service };
}

async function expectPolicyError(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected PolicyError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    const e = err as PolicyError;
    expect((e.getResponse() as { error: { code: string } }).error.code).toBe(code);
    if (status !== undefined) expect(e.getStatus()).toBe(status);
  }
}

describe('normalizePolicyBody', () => {
  it('is idempotent and fingerprint-stable', () => {
    const once = normalizePolicyBody(body());
    const twice = normalizePolicyBody(once);
    expect(twice).toEqual(once);
    expect(policyFingerprint(twice)).toBe(policyFingerprint(once));
  });

  it('sorts lists and dedupes countries so representation is canonical', () => {
    const a = normalizePolicyBody(body((b) => { b.shipping.shipsTo = ['US', 'CA']; b.payment.methods = ['wallet', 'card']; }));
    const b2 = normalizePolicyBody(body((b) => { b.shipping.shipsTo = ['CA', 'US', 'CA']; b.payment.methods = ['card', 'wallet']; }));
    expect(policyFingerprint(a)).toBe(policyFingerprint(b2));
  });

  it('accepts every canonical Copilot tone, including playful', () => {
    for (const tone of COPILOT_TONES) {
      expect(normalizePolicyBody(body((candidate) => { candidate.automation.tone = tone; })).automation.tone)
        .toBe(tone);
    }
  });

  it('rejects unknown fields, decimal cents, invalid enums, duplicate methods, and bad country codes with stable paths', () => {
    const cases: Array<{ mutate: (raw: Record<string, unknown>) => void; path: string }> = [
      { mutate: (raw) => { (raw.returns as Record<string, unknown>).surprise = 1; }, path: '/returns/surprise' },
      { mutate: (raw) => { (raw.shipping as Record<string, unknown>).flatRateCents = 12.5; }, path: '/shipping/flatRateCents' },
      { mutate: (raw) => { (raw.payment as Record<string, unknown>).captureMode = 'sometime'; }, path: '/payment/captureMode' },
      { mutate: (raw) => { (raw.payment as Record<string, unknown>).methods = ['card', 'card']; }, path: '/payment/methods/1' },
      { mutate: (raw) => { (raw.shipping as Record<string, unknown>).shipsTo = ['usa']; }, path: '/shipping/shipsTo/0' },
    ];
    for (const { mutate, path } of cases) {
      const raw = JSON.parse(JSON.stringify(body())) as Record<string, unknown>;
      mutate(raw);
      try {
        normalizePolicyBody(raw);
        expect.unreachable(`expected parse failure for ${path}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyParseError);
        expect((err as PolicyParseError).findings.map((f) => f.path)).toContain(path);
      }
    }
  });
});

describe('validatePolicyBody', () => {
  it('accepts the platform baseline with zero findings', () => {
    const summary = validatePolicyBody(body(), CAPS);
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.needsReview).toBe(false);
    expect(summary.guardrailVersion).toBe(GUARDRAIL_VERSION);
  });

  it('enforces the documented returns bounds', () => {
    expect(validatePolicyBody(body((b) => { b.returns.windowDays = 91; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_BOUND_EXCEEDED', path: '/returns/windowDays' }));
    expect(validatePolicyBody(body((b) => { b.returns.accepted = false; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_RETURNS_DISABLED_WINDOW' }));
    expect(validatePolicyBody(body((b) => { b.returns.restockingFeeBps = 1_600; }), CAPS).errors).toBeGreaterThan(0);
    expect(validatePolicyBody(body((b) => { b.returns.warrantyMonths = 13; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_WARRANTY_CAPABILITY_REQUIRED' }));
  });

  it('enforces shipping mode/range rules', () => {
    expect(validatePolicyBody(body((b) => { b.shipping.rateMode = 'flat'; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_FLAT_RATE_REQUIRED' }));
    expect(validatePolicyBody(body((b) => { b.shipping.flatRateCents = 5_000; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_FLAT_RATE_FORBIDDEN' }));
    expect(validatePolicyBody(body((b) => { b.shipping.rateMode = 'flat'; b.shipping.flatRateCents = 250_000; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_BOUND_EXCEEDED', path: '/shipping/flatRateCents' }));
    expect(validatePolicyBody(body((b) => { b.shipping.transitDays = { min: 9, max: 3 }; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_TRANSIT_RANGE_INVALID' }));
    expect(validatePolicyBody(body((b) => { b.shipping.serviceLevel = 'local_pickup'; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_LOCAL_PICKUP_SHAPE' }));
    const pickup = validatePolicyBody(body((b) => {
      b.shipping.serviceLevel = 'local_pickup';
      b.shipping.transitDays = { min: 0, max: 0 };
      b.shipping.shipsTo = [];
    }), CAPS);
    expect(pickup.errors).toBe(0);
    // handling above transit max is a WARNING that flags review, not an error
    const handling = validatePolicyBody(body((b) => { b.shipping.handlingDays = 10; }), CAPS);
    expect(handling.errors).toBe(0);
    expect(handling.needsReview).toBe(true);
  });

  it('enforces payment capability and timing rules', () => {
    expect(validatePolicyBody(body((b) => { b.payment.methods = []; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_PAYMENT_METHOD_REQUIRED' }));
    const noWallet: ProviderCapabilities = { configuredPaymentMethods: ['card'], extendedWarrantyMonths: 12 };
    expect(validatePolicyBody(body((b) => { b.payment.methods = ['card', 'wallet']; }), noWallet).findings)
      .toContainEqual(expect.objectContaining({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' }));
    expect(validatePolicyBody(body((b) => { b.payment.paymentDueMinutes = 3; }), CAPS).errors).toBeGreaterThan(0);
    expect(validatePolicyBody(body((b) => { b.payment.sellerCancellationMinutes = 10; }), CAPS).findings)
      .toContainEqual(expect.objectContaining({ code: 'POLICY_CANCELLATION_TOO_SHORT' }));
  });

  it('enforces the automation bounds for auto mode', () => {
    expect(validatePolicyBody(body((b) => {
      b.automation.automationLevel = 'auto';
      b.automation.confidenceFloor = 0.5;
    }), CAPS).findings).toContainEqual(expect.objectContaining({ code: 'POLICY_CONFIDENCE_FLOOR_TOO_LOW' }));
    expect(validatePolicyBody(body((b) => {
      b.automation.automationLevel = 'auto';
      b.automation.maxMarkdownPercent = 30;
    }), CAPS).findings).toContainEqual(expect.objectContaining({ code: 'POLICY_PRICE_DELTA_TOO_WIDE' }));
  });
});

describe('decideAutomation', () => {
  const auto = body((b) => {
    b.automation.automationLevel = 'auto';
    b.automation.allowAutoActions = true;
  }).automation;

  it('executes inside every bound and steps down on each violated one', () => {
    const meta = { policyRevisionId: 'pol_x', auditId: 'aud_x' };
    const ok = decideAutomation(auto, { requestedLevel: 'auto', confidence: 0.95, priceDeltaBps: 500, orderValueCents: 10_000, hasHardError: false }, meta);
    expect(ok.outcome).toBe('executed');
    expect(ok.effectiveLevel).toBe('auto');

    const lowConf = decideAutomation(auto, { requestedLevel: 'auto', confidence: 0.5, priceDeltaBps: 0, orderValueCents: 0, hasHardError: false }, meta);
    expect(lowConf.outcome).toBe('awaiting-confirmation');
    expect(lowConf.reasonCodes).toContain('CONFIDENCE_BELOW_FLOOR');

    const wideDelta = decideAutomation(auto, { requestedLevel: 'auto', confidence: 0.95, priceDeltaBps: 2_500, orderValueCents: 0, hasHardError: false }, meta);
    expect(wideDelta.outcome).toBe('awaiting-confirmation');
    expect(wideDelta.reasonCodes).toContain('PRICE_DELTA_EXCEEDS_BOUND');

    const bigOrder = decideAutomation(auto, { requestedLevel: 'auto', confidence: 0.95, priceDeltaBps: 0, orderValueCents: 600_000, hasHardError: false }, meta);
    expect(bigOrder.outcome).toBe('awaiting-confirmation');
    expect(bigOrder.reasonCodes).toContain('ORDER_VALUE_REQUIRES_CONFIRMATION');

    const hardError = decideAutomation(auto, { requestedLevel: 'auto', confidence: 0.95, priceDeltaBps: 0, orderValueCents: 0, hasHardError: true }, meta);
    expect(hardError.outcome).toBe('blocked');
    expect(hardError.reasonCodes).toContain('GUARDRAIL_HARD_ERROR');

    const suggest = decideAutomation({ ...auto, automationLevel: 'suggest' }, { requestedLevel: 'auto', confidence: 0.95, priceDeltaBps: 0, orderValueCents: 0, hasHardError: false }, meta);
    expect(suggest.outcome).toBe('suggested');
    expect(suggest.auditId).toBe('aud_x');
  });
});

describe('PolicyService lifecycle', () => {
  it('drafts, validates, publishes, resolves effective, and supersedes atomically', async () => {
    const { store, service } = harness();

    const draft = await service.createDraft('demo-seller', { eventId: null, body: body() }, ctx, 'key-1');
    expect(draft.state).toBe('draft');
    expect(draft.revision).toBe(1);

    const validated = await service.validate('demo-seller', draft.id, ctx);
    expect(validated.state).toBe('validated');

    const published = await service.publish('demo-seller', draft.id, 1, ctx, 'key-2');
    expect(published.state).toBe('published');
    expect(store.outbox.map((e) => e.name)).toEqual(['sidestage.seller-policy.v1.published']);

    // Effective: seller-wide policy applies to any event without an override.
    const effective = await service.effective('demo-seller', 'event-1');
    expect(effective.source).toBe('seller');
    expect(effective.policyRevisionId).toBe(published.id);
    expect(effective.policyFingerprint).toBe(published.policyFingerprint);

    // Event-scoped publish overrides the seller-wide policy for that event.
    const eventDraft = await service.createDraft('demo-seller', {
      eventId: 'event-1',
      body: body((b) => { b.returns.windowDays = 14; }),
    }, ctx, 'key-3');
    await service.publish('demo-seller', eventDraft.id, 1, ctx, 'key-4');
    const eventEffective = await service.effective('demo-seller', 'event-1');
    expect(eventEffective.source).toBe('event');
    expect(eventEffective.body.returns.windowDays).toBe(14);

    // A second seller-wide publish supersedes the first, leaving exactly one published.
    const second = await service.createDraft('demo-seller', { eventId: null, body: body((b) => { b.returns.windowDays = 60; }) }, ctx, 'key-5');
    await service.publish('demo-seller', second.id, 2, ctx, 'key-6');
    const first = await store.get(published.id);
    expect(first?.state).toBe('superseded');
    expect((await service.effective('demo-seller', null)).body.returns.windowDays).toBe(60);
    expect(store.outbox.filter((e) => e.name === 'sidestage.seller-policy.v1.superseded')).toHaveLength(1);

    // Audit history explains the lifecycle.
    const audit = await service.audit('demo-seller', published.id);
    expect(audit.map((a) => a.action)).toEqual(['draft_created', 'validated', 'published', 'superseded']);
  });

  it('resolves the platform baseline when nothing is published', async () => {
    const { service } = harness();
    const effective = await service.effective('demo-seller', 'event-9');
    expect(effective.source).toBe('baseline');
    expect(effective.policyRevisionId).toBeNull();
    expect(effective.body.returns.windowDays).toBe(30);
    expect(effective.body.returns.warrantyMonths).toBe(12);
  });

  it('returns 409 POLICY_REVISION_CONFLICT on a stale expected revision without changing the draft', async () => {
    const { service } = harness();
    const draft = await service.createDraft('demo-seller', { eventId: null, body: body() }, ctx, 'key-1');
    await expectPolicyError(
      service.updateDraft('demo-seller', draft.id, { body: body((b) => { b.returns.windowDays = 7; }) }, 99, ctx),
      'POLICY_REVISION_CONFLICT', 409,
    );
    const unchanged = await service.getRevision('demo-seller', draft.id);
    expect(unchanged.returns.windowDays).toBe(30);
  });

  it('returns 422 POLICY_VALIDATION_FAILED when expectedRevision is omitted from publish', async () => {
    const { service } = harness();
    const draft = await service.createDraft('demo-seller', { eventId: null, body: body() }, ctx, 'key-1');

    await expectPolicyError(
      service.publish('demo-seller', draft.id, undefined, ctx, 'key-2'),
      'POLICY_VALIDATION_FAILED', 422,
    );
    await expectPolicyError(
      service.publish('demo-seller', draft.id, 99, ctx, 'key-3'),
      'POLICY_REVISION_CONFLICT', 409,
    );
    expect((await service.getRevision('demo-seller', draft.id)).state).toBe('draft');
  });

  it('rejects a publish that fails validation, records the rejection, and writes no outbox row', async () => {
    const { store, service } = harness();
    const draft = await service.createDraft('demo-seller', { eventId: null, body: body((b) => { b.returns.windowDays = 91; }) }, ctx, 'key-1');
    await expectPolicyError(service.publish('demo-seller', draft.id, 1, ctx, 'key-2'), 'POLICY_VALIDATION_FAILED', 422);
    const rejected = await service.getRevision('demo-seller', draft.id);
    expect(rejected.state).toBe('rejected');
    expect(rejected.validationSummary.errors).toBeGreaterThan(0); // inspectable with its findings
    expect(store.outbox).toHaveLength(0);
    expect((await service.effective('demo-seller', null)).source).toBe('baseline');
  });

  it('scopes reads to the owning seller without revealing whether a foreign revision exists', async () => {
    const { service } = harness();
    const draft = await service.createDraft('demo-seller', { eventId: null, body: body() }, ctx, 'key-1');
    await expectPolicyError(service.getRevision('other-seller', draft.id), 'POLICY_NOT_FOUND', 404);
    await expectPolicyError(service.getRevision('other-seller', 'missing-revision'), 'POLICY_NOT_FOUND', 404);
  });

  it('replays an idempotency key with the same hash and refuses a different request under it', async () => {
    const { service } = harness();
    const input = { eventId: null as string | null, body: body() };
    const first = await service.createDraft('demo-seller', input, ctx, 'same-key');
    const replay = await service.createDraft('demo-seller', input, ctx, 'same-key');
    expect(replay.id).toBe(first.id); // original result, no duplicate revision
    await expectPolicyError(
      service.createDraft('demo-seller', { eventId: null, body: body((b) => { b.returns.windowDays = 5; }) }, ctx, 'same-key'),
      'IDEMPOTENCY_REPLAY', 409,
    );
  });

  it('projects the published automation policy for the copilot, stepping needsReview down to confirm', async () => {
    const { service } = harness();
    expect(await service.effectiveCopilotPolicy('demo-seller', null)).toBeNull(); // baseline → no projection

    // handlingDays warning ⇒ needsReview ⇒ auto is stepped down to confirm.
    const draft = await service.createDraft('demo-seller', {
      eventId: null,
      body: body((b) => {
        b.automation.automationLevel = 'auto';
        b.automation.allowAutoActions = true;
        b.shipping.handlingDays = 10;
      }),
    }, ctx, 'key-1');
    await service.publish('demo-seller', draft.id, 1, ctx, 'key-2');
    const projected = await service.effectiveCopilotPolicy('demo-seller', null);
    expect(projected?.policy.automationLevel).toBe('confirm');
    expect(projected?.policy.allowAutoActions).toBe(false);

    const clean = copilotPolicyFromAutomation(body().automation);
    expect(clean).toEqual({
      automationLevel: 'confirm',
      allowAutoActions: false,
      priceFloorCentsByProduct: {},
      maxMarkdownPercent: 20,
      blockedActionKinds: [],
      tone: 'warm',
      // WI-38815: the published policy's floors now ride the projection as
      // INPUTS to the pipeline's decideAutomation ladder (which remains the
      // sole enforcement engine).
      confidenceFloor: 0.85,
      maxOrderValueCents: 500_000,
    });
  });
});

describe('idempotency retention (P-006 / WI-39262)', () => {
  const put = (store: InMemoryPolicyStore, key: string) =>
    store.idempotencyPut('seller-1', 'publish', key, `hash-${key}`, { ok: key });

  it('drops entries older than the cutoff and keeps newer ones', async () => {
    // Deterministic clock on purpose: two puts in the same millisecond are
    // indistinguishable by age, so a wall-clock version of this test passes or
    // fails on scheduling luck.
    const store = new InMemoryPolicyStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await put(store, 'stale');
      vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
      await put(store, 'fresh');
    } finally {
      vi.useRealTimers();
    }
    const cutoff = new Date('2026-01-02T00:00:00Z');

    expect(await store.pruneIdempotency(cutoff)).toBe(1);

    // Positive control: the sweep must not be vacuous. If BOTH lookups came back
    // undefined the assertion above would still pass while the store was simply
    // empty, so assert the survivor is genuinely still readable.
    expect(await store.idempotencyGet('seller-1', 'publish', 'fresh')).toEqual({
      requestHash: 'hash-fresh',
      response: { ok: 'fresh' },
    });
    expect(await store.idempotencyGet('seller-1', 'publish', 'stale')).toBeUndefined();
  });

  it('is a no-op when nothing has aged out', async () => {
    const store = new InMemoryPolicyStore();
    await put(store, 'a');
    await put(store, 'b');

    expect(await store.pruneIdempotency(new Date(Date.now() - 60_000))).toBe(0);
    expect(await store.idempotencyGet('seller-1', 'publish', 'a')).toBeDefined();
    expect(await store.idempotencyGet('seller-1', 'publish', 'b')).toBeDefined();
  });

  it('does not leak the retention timestamp into the replay payload', async () => {
    // idempotencyGet feeds the replay response; createdAt is retention
    // bookkeeping and must stay out of what a caller sees.
    const store = new InMemoryPolicyStore();
    await put(store, 'k');
    const got = await store.idempotencyGet('seller-1', 'publish', 'k');
    expect(got).toBeDefined();
    expect(Object.keys(got!).sort()).toEqual(['requestHash', 'response']);
  });

  it('keeps a retention window long enough to outlast any client retry budget', () => {
    // The window is what makes dropping a row safe: past it, a replayed key is
    // correctly treated as a fresh request. A short window would silently turn
    // legitimate retries into duplicate writes.
    expect(IDEMPOTENCY_RETENTION_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});

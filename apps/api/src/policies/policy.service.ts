import { HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  GUARDRAIL_VERSION,
  PolicyParseError,
  baselinePolicyBody,
  copilotPolicyFromAutomation,
  normalizePolicyBody,
  policyFingerprint,
  validatePolicyBody,
} from './policy-rules';
import type {
  CopilotPolicy,
  EffectivePolicy,
  PolicyAuditAction,
  PolicyAuditEntry,
  PolicyBody,
  PolicyOutboxEvent,
  ProviderCapabilities,
  SellerPolicyRevision,
  ValidationSummary,
} from './policy.types';

export const POLICY_STORE = Symbol('POLICY_STORE');
export const PROVIDER_CAPABILITIES = Symbol('PROVIDER_CAPABILITIES');

/** Demo principal: real deployments derive the seller from the request principal. */
export const DEFAULT_SELLER_ID = 'demo-seller';

export interface PolicyErrorBody {
  code: string;
  message: string;
  fields?: Array<{ path: string; code: string; message: string }>;
}

export class PolicyError extends HttpException {
  constructor(status: number, body: PolicyErrorBody) {
    super({ error: body }, status);
  }
}

export interface PublishBundle {
  revision: SellerPolicyRevision;
  superseded: SellerPolicyRevision | null;
  audit: PolicyAuditEntry[];
  outbox: PolicyOutboxEvent[];
}

export interface PolicyStore {
  get(id: string): Promise<SellerPolicyRevision | undefined>;
  /** Highest revision number for the scope (0 when none). */
  maxRevision(sellerId: string, eventId: string | null): Promise<number>;
  findPublished(sellerId: string, eventId: string | null): Promise<SellerPolicyRevision | undefined>;
  insert(revision: SellerPolicyRevision, audit: PolicyAuditEntry): Promise<void>;
  /** Draft-state update; the caller has already enforced lifecycle + concurrency. */
  update(revision: SellerPolicyRevision, audit: PolicyAuditEntry | null): Promise<void>;
  /** Atomic publish: supersede + publish + audit + outbox in ONE transaction. */
  publish(bundle: PublishBundle): Promise<void>;
  listAudit(sellerId: string, filter: { eventId?: string | null; policyRevisionId?: string }): Promise<PolicyAuditEntry[]>;
  appendAudit(entry: PolicyAuditEntry): Promise<void>;
  idempotencyGet(sellerId: string, route: string, key: string): Promise<{ requestHash: string; response: unknown } | undefined>;
  idempotencyPut(sellerId: string, route: string, key: string, requestHash: string, response: unknown): Promise<void>;
}

@Injectable()
export class InMemoryPolicyStore implements PolicyStore {
  private readonly revisions = new Map<string, SellerPolicyRevision>();
  private readonly audits: PolicyAuditEntry[] = [];
  readonly outbox: PolicyOutboxEvent[] = [];
  private readonly idem = new Map<string, { requestHash: string; response: unknown }>();

  async get(id: string): Promise<SellerPolicyRevision | undefined> {
    const rev = this.revisions.get(id);
    return rev ? structuredClone(rev) : undefined;
  }

  async maxRevision(sellerId: string, eventId: string | null): Promise<number> {
    let max = 0;
    for (const rev of this.revisions.values()) {
      if (rev.sellerId === sellerId && rev.eventId === eventId) max = Math.max(max, rev.revision);
    }
    return max;
  }

  async findPublished(sellerId: string, eventId: string | null): Promise<SellerPolicyRevision | undefined> {
    for (const rev of this.revisions.values()) {
      if (rev.sellerId === sellerId && rev.eventId === eventId && rev.state === 'published') return structuredClone(rev);
    }
    return undefined;
  }

  async insert(revision: SellerPolicyRevision, audit: PolicyAuditEntry): Promise<void> {
    this.revisions.set(revision.id, structuredClone(revision));
    this.audits.push(structuredClone(audit));
  }

  async update(revision: SellerPolicyRevision, audit: PolicyAuditEntry | null): Promise<void> {
    this.revisions.set(revision.id, structuredClone(revision));
    if (audit) this.audits.push(structuredClone(audit));
  }

  async publish(bundle: PublishBundle): Promise<void> {
    // Mirrors the PG transaction: all-or-nothing.
    if (bundle.superseded) this.revisions.set(bundle.superseded.id, structuredClone(bundle.superseded));
    this.revisions.set(bundle.revision.id, structuredClone(bundle.revision));
    for (const entry of bundle.audit) this.audits.push(structuredClone(entry));
    for (const event of bundle.outbox) this.outbox.push(structuredClone(event));
  }

  async listAudit(sellerId: string, filter: { eventId?: string | null; policyRevisionId?: string }): Promise<PolicyAuditEntry[]> {
    return this.audits
      .filter((a) => a.sellerId === sellerId
        && (filter.policyRevisionId === undefined || a.policyRevisionId === filter.policyRevisionId)
        && (filter.eventId === undefined || a.eventId === filter.eventId))
      .map((a) => structuredClone(a));
  }

  async appendAudit(entry: PolicyAuditEntry): Promise<void> {
    this.audits.push(structuredClone(entry));
  }

  async idempotencyGet(sellerId: string, route: string, key: string) {
    return this.idem.get(`${sellerId}\x1f${route}\x1f${key}`);
  }

  async idempotencyPut(sellerId: string, route: string, key: string, requestHash: string, response: unknown): Promise<void> {
    this.idem.set(`${sellerId}\x1f${route}\x1f${key}`, { requestHash, response });
  }
}

function rowToRevision(payload: SellerPolicyRevision): SellerPolicyRevision {
  return payload;
}

export class PgPolicyStore implements PolicyStore {
  constructor(private readonly pool: Pool) {}

  async get(id: string): Promise<SellerPolicyRevision | undefined> {
    const r = await this.pool.query<{ payload: SellerPolicyRevision }>(
      'SELECT payload FROM seller_policy_revision WHERE id = $1', [id]);
    return r.rows[0] ? rowToRevision(r.rows[0].payload) : undefined;
  }

  async maxRevision(sellerId: string, eventId: string | null): Promise<number> {
    const r = await this.pool.query<{ max: number | null }>(
      `SELECT max(revision)::int AS max FROM seller_policy_revision WHERE seller_id = $1 AND event_id IS NOT DISTINCT FROM $2`,
      [sellerId, eventId]);
    return r.rows[0]?.max ?? 0;
  }

  async findPublished(sellerId: string, eventId: string | null): Promise<SellerPolicyRevision | undefined> {
    const r = await this.pool.query<{ payload: SellerPolicyRevision }>(
      `SELECT payload FROM seller_policy_revision WHERE seller_id = $1 AND event_id IS NOT DISTINCT FROM $2 AND state = 'published'`,
      [sellerId, eventId]);
    return r.rows[0] ? rowToRevision(r.rows[0].payload) : undefined;
  }

  private insertRevisionSql(rev: SellerPolicyRevision) {
    return {
      text: `INSERT INTO seller_policy_revision (id, seller_id, event_id, revision, state, fingerprint, payload, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, fingerprint = EXCLUDED.fingerprint, payload = EXCLUDED.payload, updated_at = now()`,
      values: [rev.id, rev.sellerId, rev.eventId, rev.revision, rev.state, rev.policyFingerprint, JSON.stringify(rev)],
    };
  }

  private insertAuditSql(a: PolicyAuditEntry) {
    return {
      text: `INSERT INTO policy_audit_entry (id, seller_id, event_id, policy_revision_id, action, payload)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      values: [a.id, a.sellerId, a.eventId, a.policyRevisionId, a.action, JSON.stringify(a)],
    };
  }

  async insert(revision: SellerPolicyRevision, audit: PolicyAuditEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rev = this.insertRevisionSql(revision);
      await client.query(rev.text, rev.values);
      const aud = this.insertAuditSql(audit);
      await client.query(aud.text, aud.values);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(revision: SellerPolicyRevision, audit: PolicyAuditEntry | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rev = this.insertRevisionSql(revision);
      await client.query(rev.text, rev.values);
      if (audit) {
        const aud = this.insertAuditSql(audit);
        await client.query(aud.text, aud.values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async publish(bundle: PublishBundle): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (bundle.superseded) {
        const sup = this.insertRevisionSql(bundle.superseded);
        await client.query(sup.text, sup.values);
      }
      const rev = this.insertRevisionSql(bundle.revision);
      await client.query(rev.text, rev.values);
      for (const entry of bundle.audit) {
        const aud = this.insertAuditSql(entry);
        await client.query(aud.text, aud.values);
      }
      for (const event of bundle.outbox) {
        await client.query(
          `INSERT INTO policy_outbox_event (id, name, payload) VALUES ($1, $2, $3::jsonb)`,
          [event.id, event.name, JSON.stringify(event.payload)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listAudit(sellerId: string, filter: { eventId?: string | null; policyRevisionId?: string }): Promise<PolicyAuditEntry[]> {
    const clauses = ['seller_id = $1'];
    const values: unknown[] = [sellerId];
    if (filter.policyRevisionId !== undefined) {
      values.push(filter.policyRevisionId);
      clauses.push(`policy_revision_id = $${values.length}`);
    }
    if (filter.eventId !== undefined) {
      values.push(filter.eventId);
      clauses.push(`event_id IS NOT DISTINCT FROM $${values.length}`);
    }
    const r = await this.pool.query<{ payload: PolicyAuditEntry }>(
      `SELECT payload FROM policy_audit_entry WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`, values);
    return r.rows.map((row) => row.payload);
  }

  async appendAudit(entry: PolicyAuditEntry): Promise<void> {
    const aud = this.insertAuditSql(entry);
    await this.pool.query(aud.text, aud.values);
  }

  async idempotencyGet(sellerId: string, route: string, key: string) {
    const r = await this.pool.query<{ request_hash: string; response: unknown }>(
      'SELECT request_hash, response FROM policy_idempotency WHERE seller_id = $1 AND route = $2 AND key = $3',
      [sellerId, route, key]);
    const row = r.rows[0];
    return row ? { requestHash: row.request_hash, response: row.response } : undefined;
  }

  async idempotencyPut(sellerId: string, route: string, key: string, requestHash: string, response: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO policy_idempotency (seller_id, route, key, request_hash, response)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (seller_id, route, key) DO NOTHING`,
      [sellerId, route, key, requestHash, JSON.stringify(response)]);
  }
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
  actorType: PolicyAuditEntry['actorType'];
  actorId: string;
}

function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex').slice(0, 32);
}

const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

@Injectable()
export class PolicyService {
  constructor(
    @Inject(POLICY_STORE) private readonly store: PolicyStore,
    @Inject(PROVIDER_CAPABILITIES) private readonly capabilities: ProviderCapabilities,
  ) {}

  private auditEntry(
    ctx: RequestContext,
    partial: Pick<PolicyAuditEntry, 'sellerId' | 'eventId' | 'policyRevisionId' | 'action' | 'decision'>
      & Partial<Pick<PolicyAuditEntry, 'beforeFingerprint' | 'afterFingerprint' | 'reasonCodes'>>,
  ): PolicyAuditEntry {
    return {
      id: `aud_${randomUUID()}`,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      guardrailVersion: GUARDRAIL_VERSION,
      beforeFingerprint: partial.beforeFingerprint ?? null,
      afterFingerprint: partial.afterFingerprint ?? null,
      reasonCodes: partial.reasonCodes ?? [],
      createdAt: new Date().toISOString(),
      ...partial,
    };
  }

  private normalizeOrThrow(input: unknown): { body: PolicyBody; summary: ValidationSummary } {
    let body: PolicyBody;
    try {
      body = normalizePolicyBody(input);
    } catch (err) {
      if (err instanceof PolicyParseError) {
        throw new PolicyError(422, {
          code: 'POLICY_VALIDATION_FAILED',
          message: 'policy payload failed structural validation',
          fields: err.findings.map((x) => ({ path: x.path, code: x.code, message: x.message })),
        });
      }
      throw err;
    }
    return { body, summary: validatePolicyBody(body, this.capabilities) };
  }

  private readScope(eventId: string | null | undefined): string | null {
    if (eventId === null || eventId === undefined || eventId === '') return null;
    const id = String(eventId).trim().toLowerCase();
    if (!EVENT_ID_RE.test(id)) {
      throw new PolicyError(422, { code: 'POLICY_VALIDATION_FAILED', message: 'eventId must be lowercase letters, numbers, and hyphens' });
    }
    return id;
  }

  private async withIdempotency<T>(
    sellerId: string, route: string, key: string | undefined, body: unknown, run: () => Promise<T>,
  ): Promise<T> {
    if (!key) {
      throw new PolicyError(422, { code: 'POLICY_VALIDATION_FAILED', message: 'an Idempotency-Key header is required for this route' });
    }
    const hash = requestHash(body);
    const existing = await this.store.idempotencyGet(sellerId, route, key);
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new PolicyError(409, { code: 'IDEMPOTENCY_REPLAY', message: 'this idempotency key was already used with a different request' });
      }
      return existing.response as T;
    }
    const result = await run();
    await this.store.idempotencyPut(sellerId, route, key, hash, result);
    return result;
  }

  async createDraft(
    sellerId: string, input: { eventId?: string | null; body: unknown }, ctx: RequestContext, idempotencyKey?: string,
  ): Promise<SellerPolicyRevision> {
    const eventId = this.readScope(input.eventId);
    return this.withIdempotency(sellerId, 'POST /v1/seller/policies', idempotencyKey, input, async () => {
      const { body, summary } = this.normalizeOrThrow(input.body);
      const now = new Date().toISOString();
      const revision: SellerPolicyRevision = {
        id: `pol_${randomUUID()}`,
        sellerId,
        eventId,
        revision: (await this.store.maxRevision(sellerId, eventId)) + 1,
        state: 'draft',
        ...body,
        policyFingerprint: policyFingerprint(body),
        validationSummary: summary,
        createdBy: ctx.actorId,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.insert(revision, this.auditEntry(ctx, {
        sellerId, eventId, policyRevisionId: revision.id, action: 'draft_created',
        decision: 'allowed', afterFingerprint: revision.policyFingerprint,
      }));
      return revision;
    });
  }

  async getRevision(sellerId: string, id: string): Promise<SellerPolicyRevision> {
    const revision = await this.store.get(id);
    // A foreign revision id and an absent id intentionally collapse to the
    // same response. Returning a distinct scope error would let one seller
    // enumerate another seller's policy revisions by probing ids.
    if (!revision || revision.sellerId !== sellerId) {
      throw new PolicyError(404, {
        code: 'POLICY_NOT_FOUND',
        message: `no policy revision ${id}`,
      });
    }
    return revision;
  }

  async updateDraft(
    sellerId: string, id: string, input: { body: unknown }, expectedRevision: number | undefined, ctx: RequestContext,
  ): Promise<SellerPolicyRevision> {
    const current = await this.getRevision(sellerId, id);
    if (current.state !== 'draft' && current.state !== 'validated') {
      throw new PolicyError(409, { code: 'POLICY_NOT_PUBLISHABLE', message: `a ${current.state} revision is immutable; create a new draft` });
    }
    if (expectedRevision === undefined || expectedRevision !== current.revision) {
      throw new PolicyError(409, { code: 'POLICY_REVISION_CONFLICT', message: 'the revision changed under you; reload before editing' });
    }
    const { body, summary } = this.normalizeOrThrow(input.body);
    const before = current.policyFingerprint;
    const next: SellerPolicyRevision = {
      ...current,
      ...body,
      state: 'draft', // an edit invalidates a prior validation pass
      policyFingerprint: policyFingerprint(body),
      validationSummary: summary,
      updatedAt: new Date().toISOString(),
    };
    await this.store.update(next, this.auditEntry(ctx, {
      sellerId, eventId: next.eventId, policyRevisionId: next.id, action: 'draft_updated',
      decision: 'allowed', beforeFingerprint: before, afterFingerprint: next.policyFingerprint,
    }));
    return next;
  }

  async validate(sellerId: string, id: string, ctx: RequestContext): Promise<SellerPolicyRevision> {
    const current = await this.getRevision(sellerId, id);
    if (current.state !== 'draft' && current.state !== 'validated') {
      throw new PolicyError(409, { code: 'POLICY_NOT_PUBLISHABLE', message: `a ${current.state} revision cannot be re-validated` });
    }
    const body: PolicyBody = { returns: current.returns, shipping: current.shipping, payment: current.payment, automation: current.automation };
    const summary = validatePolicyBody(body, this.capabilities);
    const next: SellerPolicyRevision = {
      ...current,
      state: summary.errors === 0 ? 'validated' : 'draft',
      validationSummary: summary,
      updatedAt: new Date().toISOString(),
    };
    await this.store.update(next, this.auditEntry(ctx, {
      sellerId, eventId: next.eventId, policyRevisionId: next.id, action: 'validated',
      decision: summary.errors > 0 ? 'rejected' : summary.needsReview ? 'review' : 'allowed',
      reasonCodes: summary.findings.map((f) => f.code),
      afterFingerprint: next.policyFingerprint,
    }));
    return next;
  }

  async publish(
    sellerId: string, id: string, expectedRevision: number | undefined, ctx: RequestContext, idempotencyKey?: string,
  ): Promise<SellerPolicyRevision> {
    return this.withIdempotency(sellerId, `POST /v1/seller/policies/${id}/publish`, idempotencyKey, { id, expectedRevision }, async () => {
      const current = await this.getRevision(sellerId, id);
      if (current.state === 'published') return current; // idempotent re-publish of the same revision
      if (current.state !== 'draft' && current.state !== 'validated') {
        throw new PolicyError(409, { code: 'POLICY_NOT_PUBLISHABLE', message: `a ${current.state} revision cannot be published` });
      }
      if (expectedRevision === undefined || expectedRevision !== current.revision) {
        throw new PolicyError(409, { code: 'POLICY_REVISION_CONFLICT', message: 'the revision changed under you; reload before publishing' });
      }
      // Re-validate inside the publish path: capabilities may have changed since draft.
      const body: PolicyBody = { returns: current.returns, shipping: current.shipping, payment: current.payment, automation: current.automation };
      const summary = validatePolicyBody(body, this.capabilities);
      if (summary.errors > 0) {
        const rejected: SellerPolicyRevision = { ...current, state: 'rejected', validationSummary: summary, updatedAt: new Date().toISOString() };
        await this.store.update(rejected, this.auditEntry(ctx, {
          sellerId, eventId: current.eventId, policyRevisionId: current.id, action: 'rejected',
          decision: 'rejected', reasonCodes: summary.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        }));
        throw new PolicyError(422, {
          code: 'POLICY_VALIDATION_FAILED',
          message: 'the revision failed validation and was rejected; create a new draft',
          fields: summary.findings.map((x) => ({ path: x.path, code: x.code, message: x.message })),
        });
      }

      const now = new Date().toISOString();
      const prior = await this.store.findPublished(sellerId, current.eventId);
      const published: SellerPolicyRevision = { ...current, state: 'published', validationSummary: summary, publishedAt: now, updatedAt: now };
      const superseded: SellerPolicyRevision | null = prior && prior.id !== current.id
        ? { ...prior, state: 'superseded', updatedAt: now }
        : null;

      const audit: PolicyAuditEntry[] = [];
      if (superseded) {
        audit.push(this.auditEntry(ctx, {
          sellerId, eventId: superseded.eventId, policyRevisionId: superseded.id, action: 'superseded',
          decision: 'allowed', beforeFingerprint: superseded.policyFingerprint,
        }));
      }
      audit.push(this.auditEntry(ctx, {
        sellerId, eventId: published.eventId, policyRevisionId: published.id, action: 'published',
        decision: summary.needsReview ? 'review' : 'allowed',
        reasonCodes: summary.findings.map((f) => f.code),
        beforeFingerprint: prior?.policyFingerprint ?? null,
        afterFingerprint: published.policyFingerprint,
      }));

      const outbox: PolicyOutboxEvent[] = [{
        id: `obx_${randomUUID()}`,
        name: 'sidestage.seller-policy.v1.published',
        payload: {
          eventId: `evt_${randomUUID()}`,
          sellerId,
          scopeEventId: published.eventId,
          policyRevisionId: published.id,
          revision: published.revision,
          policyFingerprint: published.policyFingerprint,
          occurredAt: now,
          correlationId: ctx.correlationId,
        },
        createdAt: now,
      }];
      if (superseded) {
        outbox.push({
          id: `obx_${randomUUID()}`,
          name: 'sidestage.seller-policy.v1.superseded',
          payload: {
            eventId: `evt_${randomUUID()}`,
            sellerId,
            scopeEventId: superseded.eventId,
            policyRevisionId: superseded.id,
            revision: superseded.revision,
            policyFingerprint: superseded.policyFingerprint,
            occurredAt: now,
            correlationId: ctx.correlationId,
          },
          createdAt: now,
        });
      }

      await this.store.publish({ revision: published, superseded, audit, outbox });
      return published;
    });
  }

  /** Effective scope: published event policy > published seller policy > platform baseline. */
  async effective(sellerId: string, eventId: string | null | undefined): Promise<EffectivePolicy> {
    const scope = this.readScope(eventId);
    if (scope) {
      const eventPolicy = await this.store.findPublished(sellerId, scope);
      if (eventPolicy) return this.toEffective('event', eventPolicy);
    }
    const sellerPolicy = await this.store.findPublished(sellerId, null);
    if (sellerPolicy) return this.toEffective('seller', sellerPolicy);
    const baseline = baselinePolicyBody();
    return {
      source: 'baseline',
      policyRevisionId: null,
      policyFingerprint: policyFingerprint(baseline),
      revision: null,
      sellerId,
      eventId: scope,
      body: baseline,
    };
  }

  private toEffective(source: 'event' | 'seller', rev: SellerPolicyRevision): EffectivePolicy {
    return {
      source,
      policyRevisionId: rev.id,
      policyFingerprint: rev.policyFingerprint,
      revision: rev.revision,
      sellerId: rev.sellerId,
      eventId: rev.eventId,
      body: { returns: rev.returns, shipping: rev.shipping, payment: rev.payment, automation: rev.automation },
    };
  }

  /**
   * The copilot projection of the effective policy. A published-with-warnings
   * revision (needsReview) forces the automation rung down to confirm — the
   * doc's "warnings force the next automation rung down".
   */
  async effectiveCopilotPolicy(sellerId: string, eventId: string | null | undefined): Promise<{ policy: CopilotPolicy; effective: EffectivePolicy } | null> {
    const effective = await this.effective(sellerId, eventId);
    if (effective.source === 'baseline') return null;
    const revision = effective.policyRevisionId ? await this.store.get(effective.policyRevisionId) : undefined;
    const policy = copilotPolicyFromAutomation(effective.body.automation);
    if (revision?.validationSummary.needsReview && policy.automationLevel === 'auto') {
      policy.automationLevel = 'confirm';
      policy.allowAutoActions = false;
    }
    return { policy, effective };
  }

  async audit(sellerId: string, id: string): Promise<PolicyAuditEntry[]> {
    await this.getRevision(sellerId, id); // scope check
    return this.store.listAudit(sellerId, { policyRevisionId: id });
  }
}

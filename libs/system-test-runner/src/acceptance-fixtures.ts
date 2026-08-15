import { createHash } from 'node:crypto';

export const ACCEPTANCE_FIXTURE_RESOURCE_KINDS = [
  'postgres-database',
  'postgres-schema',
  'typesense-collection-prefix',
  'redis-key-prefix',
  'mediamtx-path-prefix',
  'user-id',
  'event-id',
  'order-id',
  'idempotency-key',
  'external-sandbox',
] as const;

export type AcceptanceFixtureResourceKind = (typeof ACCEPTANCE_FIXTURE_RESOURCE_KINDS)[number];
export type AcceptanceFixtureLeaseStatus = 'active' | 'cleaning' | 'leaked' | 'released';
export type AcceptanceFixtureResourceStatus = 'leased' | 'active' | 'leaked' | 'released';

export interface AcceptanceFixtureResourceDescriptor {
  kind: AcceptanceFixtureResourceKind;
  identifier: string;
  cleanupOrder: number;
}

export interface AcceptanceFixturePlan {
  runId: string;
  namespace: string;
  resources: AcceptanceFixtureResourceDescriptor[];
}

export interface StoredAcceptanceFixtureResource extends AcceptanceFixtureResourceDescriptor {
  status: AcceptanceFixtureResourceStatus;
  metadata: Record<string, unknown>;
  cleanupAttempts: number;
  lastError: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface StoredAcceptanceFixtureLease {
  runId: string;
  namespace: string;
  status: AcceptanceFixtureLeaseStatus;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
  updatedAt: string;
  resources: StoredAcceptanceFixtureResource[];
}

export interface AcceptanceFixtureLeaseStore {
  acquireFixtureLease(
    plan: AcceptanceFixturePlan,
    expiresAt: Date,
    at?: Date,
  ): Promise<StoredAcceptanceFixtureLease>;
  getFixtureLease(runId: string): Promise<StoredAcceptanceFixtureLease | null>;
  markFixtureResourceActive(
    runId: string,
    resource: AcceptanceFixtureResourceDescriptor,
    metadata?: Record<string, unknown>,
    at?: Date,
  ): Promise<void>;
  beginFixtureCleanup(runId: string, at?: Date): Promise<StoredAcceptanceFixtureLease>;
  recordFixtureResourceCleanup(
    runId: string,
    resource: AcceptanceFixtureResourceDescriptor,
    outcome: { status: 'released' | 'leaked'; error?: string; at?: Date },
  ): Promise<void>;
  finishFixtureCleanup(
    runId: string,
    status: 'released' | 'leaked',
    at?: Date,
  ): Promise<StoredAcceptanceFixtureLease>;
  listFixtureRunIdsForReaping(expiresBefore: Date, limit?: number): Promise<string[]>;
  recordCleanup(
    runId: string,
    input: { status: 'running' | 'succeeded' | 'failed'; summary: string; at?: Date },
  ): Promise<unknown>;
}

export interface AcceptanceFixtureResourceDriver {
  ensure(
    resource: AcceptanceFixtureResourceDescriptor,
    context: { runId: string; namespace: string },
  ): Promise<Record<string, unknown> | void>;
  remove(
    resource: AcceptanceFixtureResourceDescriptor,
    context: { runId: string; namespace: string },
  ): Promise<void>;
  exists(
    resource: AcceptanceFixtureResourceDescriptor,
    context: { runId: string; namespace: string },
  ): Promise<boolean>;
}

export interface AcceptanceFixtureCleanupResult {
  runId: string;
  released: boolean;
  alreadyReleased: boolean;
  leaked: AcceptanceFixtureResourceDescriptor[];
}

export interface AcceptanceFixtureReaperResult {
  inspected: string[];
  released: string[];
  leaked: string[];
}

export class AcceptanceFixtureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceFixtureValidationError';
  }
}

const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const NAMESPACE_PATTERN = /^sst_[a-z0-9_]{1,58}$/;
const PRODUCTION_IDENTIFIER_PATTERN = /(?:^|[._:/-])(?:prod(?:uction)?|live)(?:$|[._:/-])|sidestage\.buyrestart\.com|\/opt\/sidestage/i;

function assertNonProductionIdentifier(value: string, label: string): void {
  if (PRODUCTION_IDENTIFIER_PATTERN.test(value)) {
    throw new AcceptanceFixtureValidationError(`${label} contains a production identifier`);
  }
}

function fixtureStem(runId: string): { stem: string; digest: string } {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new AcceptanceFixtureValidationError(
      'runId must be a lowercase identifier no longer than 40 characters',
    );
  }
  assertNonProductionIdentifier(runId, 'runId');
  return {
    stem: runId.replaceAll('-', '_').slice(0, 32),
    digest: createHash('sha256').update(runId).digest('hex').slice(0, 10),
  };
}

/**
 * Produce every per-run name from one stable namespace. The digest prevents
 * truncation collisions while keeping PostgreSQL identifiers below 63 bytes.
 */
export function createAcceptanceFixturePlan(runId: string): AcceptanceFixturePlan {
  const { stem, digest } = fixtureStem(runId);
  const namespace = `sst_${stem}_${digest}`;
  const resources: AcceptanceFixtureResourceDescriptor[] = [
    { kind: 'postgres-database', identifier: `acceptance_${stem}_${digest}`, cleanupOrder: 100 },
    { kind: 'postgres-schema', identifier: namespace, cleanupOrder: 90 },
    { kind: 'typesense-collection-prefix', identifier: `${namespace}__`, cleanupOrder: 80 },
    { kind: 'redis-key-prefix', identifier: `${namespace}:`, cleanupOrder: 70 },
    { kind: 'mediamtx-path-prefix', identifier: `${namespace}/`, cleanupOrder: 60 },
    { kind: 'order-id', identifier: `${namespace}_order`, cleanupOrder: 50 },
    { kind: 'event-id', identifier: `${namespace}_event`, cleanupOrder: 40 },
    { kind: 'user-id', identifier: `${namespace}_user`, cleanupOrder: 30 },
    { kind: 'idempotency-key', identifier: `${namespace}_idempotency`, cleanupOrder: 20 },
    { kind: 'external-sandbox', identifier: `sandbox:${namespace}`, cleanupOrder: 10 },
  ];
  const plan = { runId, namespace, resources };
  validateAcceptanceFixturePlan(plan);
  return plan;
}

/** Validate caller-supplied plans too, so the PostgreSQL store cannot be bypassed. */
export function validateAcceptanceFixturePlan(plan: AcceptanceFixturePlan): void {
  fixtureStem(plan.runId);
  if (!NAMESPACE_PATTERN.test(plan.namespace)) {
    throw new AcceptanceFixtureValidationError('fixture namespace has an invalid format');
  }
  assertNonProductionIdentifier(plan.namespace, 'fixture namespace');
  if (plan.resources.length !== ACCEPTANCE_FIXTURE_RESOURCE_KINDS.length) {
    throw new AcceptanceFixtureValidationError('fixture plan must contain exactly one resource of every kind');
  }
  const kinds = new Set<AcceptanceFixtureResourceKind>();
  const identifiers = new Set<string>();
  const cleanupOrders = new Set<number>();
  for (const resource of plan.resources) {
    if (!ACCEPTANCE_FIXTURE_RESOURCE_KINDS.includes(resource.kind)) {
      throw new AcceptanceFixtureValidationError(`unknown fixture resource kind ${String(resource.kind)}`);
    }
    if (kinds.has(resource.kind)) {
      throw new AcceptanceFixtureValidationError(`fixture resource kind ${resource.kind} is duplicated`);
    }
    if (!resource.identifier || resource.identifier.length > 160 || /\s/.test(resource.identifier)) {
      throw new AcceptanceFixtureValidationError(`${resource.kind} identifier has an invalid format`);
    }
    assertNonProductionIdentifier(resource.identifier, `${resource.kind} identifier`);
    if (identifiers.has(resource.identifier)) {
      throw new AcceptanceFixtureValidationError(`fixture identifier ${resource.identifier} is duplicated`);
    }
    if (!Number.isInteger(resource.cleanupOrder) || resource.cleanupOrder < 0) {
      throw new AcceptanceFixtureValidationError(`${resource.kind} cleanupOrder must be a non-negative integer`);
    }
    if (cleanupOrders.has(resource.cleanupOrder)) {
      throw new AcceptanceFixtureValidationError(`cleanupOrder ${resource.cleanupOrder} is duplicated`);
    }
    kinds.add(resource.kind);
    identifiers.add(resource.identifier);
    cleanupOrders.add(resource.cleanupOrder);
  }
  for (const kind of ACCEPTANCE_FIXTURE_RESOURCE_KINDS) {
    if (!kinds.has(kind)) throw new AcceptanceFixtureValidationError(`fixture resource kind ${kind} is missing`);
  }
}

export function acceptanceFixtureResource(
  plan: AcceptanceFixturePlan,
  kind: AcceptanceFixtureResourceKind,
): AcceptanceFixtureResourceDescriptor {
  const resource = plan.resources.find((entry) => entry.kind === kind);
  if (!resource) throw new AcceptanceFixtureValidationError(`fixture resource kind ${kind} is missing`);
  return resource;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trusted orchestration seam; concrete drivers live beside the domains they clean. */
export class AcceptanceFixtureCoordinator {
  readonly #store: AcceptanceFixtureLeaseStore;
  readonly #driver: AcceptanceFixtureResourceDriver;

  constructor(store: AcceptanceFixtureLeaseStore, driver: AcceptanceFixtureResourceDriver) {
    this.#store = store;
    this.#driver = driver;
  }

  async provision(runId: string, expiresAt: Date, at = new Date()): Promise<StoredAcceptanceFixtureLease> {
    const plan = createAcceptanceFixturePlan(runId);
    const context = { runId, namespace: plan.namespace };
    await this.#store.acquireFixtureLease(plan, expiresAt, at);
    for (const resource of [...plan.resources].sort((a, b) => a.cleanupOrder - b.cleanupOrder)) {
      const metadata = await this.#driver.ensure(resource, context);
      await this.#store.markFixtureResourceActive(runId, resource, metadata ?? {}, at);
    }
    const lease = await this.#store.getFixtureLease(runId);
    if (!lease) throw new Error(`fixture lease for ${runId} disappeared after provisioning`);
    return lease;
  }

  async cleanup(runId: string, at = new Date()): Promise<AcceptanceFixtureCleanupResult> {
    const current = await this.#store.getFixtureLease(runId);
    if (!current) throw new Error(`fixture lease for ${runId} does not exist`);
    if (current.status === 'released') {
      return { runId, released: true, alreadyReleased: true, leaked: [] };
    }

    const lease = await this.#store.beginFixtureCleanup(runId, at);
    const context = { runId, namespace: lease.namespace };
    await this.#store.recordCleanup(runId, {
      status: 'running',
      summary: 'Acceptance fixture cleanup is running.',
      at,
    });

    const leaked: AcceptanceFixtureResourceDescriptor[] = [];
    for (const resource of [...lease.resources].sort((a, b) => b.cleanupOrder - a.cleanupOrder)) {
      if (resource.status === 'released') continue;
      try {
        await this.#driver.remove(resource, context);
        if (await this.#driver.exists(resource, context)) {
          leaked.push(resource);
          await this.#store.recordFixtureResourceCleanup(runId, resource, {
            status: 'leaked',
            error: 'resource still exists after cleanup',
            at,
          });
        } else {
          await this.#store.recordFixtureResourceCleanup(runId, resource, { status: 'released', at });
        }
      } catch (error) {
        leaked.push(resource);
        await this.#store.recordFixtureResourceCleanup(runId, resource, {
          status: 'leaked',
          error: errorText(error),
          at,
        });
      }
    }

    if (leaked.length > 0) {
      await this.#store.finishFixtureCleanup(runId, 'leaked', at);
      await this.#store.recordCleanup(runId, {
        status: 'failed',
        summary: `Acceptance fixture cleanup leaked ${leaked.length} resource(s): ${leaked.map((entry) => entry.kind).join(', ')}.`,
        at,
      });
      return { runId, released: false, alreadyReleased: false, leaked };
    }

    await this.#store.finishFixtureCleanup(runId, 'released', at);
    await this.#store.recordCleanup(runId, {
      status: 'succeeded',
      summary: 'Acceptance fixture cleanup verified every resource absent.',
      at,
    });
    return { runId, released: true, alreadyReleased: false, leaked: [] };
  }

  async reapExpired(
    expiresBefore: Date,
    options: { limit?: number; at?: Date } = {},
  ): Promise<AcceptanceFixtureReaperResult> {
    const inspected = await this.#store.listFixtureRunIdsForReaping(expiresBefore, options.limit);
    const released: string[] = [];
    const leaked: string[] = [];
    for (const runId of inspected) {
      const result = await this.cleanup(runId, options.at ?? new Date());
      (result.released ? released : leaked).push(runId);
    }
    return { inspected, released, leaked };
  }
}

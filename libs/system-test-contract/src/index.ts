/**
 * The browser-safe wire contract for SideStage's real-system Tests tab.
 *
 * This module deliberately has no Node or framework dependency. The web app can
 * render the catalog and parse results, while only the trusted API/worker side
 * is able to turn an allow-listed suite ID into executable code.
 */

export const SYSTEM_TEST_CONTRACT_VERSION = 1 as const;

export const SYSTEM_TEST_SUITE_IDS = [
  'actions',
  'auction',
  'checkout',
  'injection',
  'load',
  'judge',
] as const;

export type SystemTestSuiteId = (typeof SYSTEM_TEST_SUITE_IDS)[number];
export type SystemTestProfile = 'smoke' | 'full' | 'sandbox' | 'load';
export type SystemTestRunStatus = 'passed' | 'failed' | 'blocked' | 'cancelled';
export type SystemTestCaseStatus = 'passed' | 'failed' | 'blocked' | 'not-run';
export type SystemTestEvidenceKind =
  | 'http'
  | 'sse'
  | 'websocket'
  | 'postgres'
  | 'typesense'
  | 'redis'
  | 'mediamtx'
  | 'external-sandbox'
  | 'remote-model'
  | 'metric'
  | 'log'
  | 'screenshot';

export type SystemTestPrerequisiteKind =
  | 'service'
  | 'sandbox-credential'
  | 'remote-model'
  | 'container-image'
  | 'browser';

export interface SystemTestPrerequisite {
  id: string;
  kind: SystemTestPrerequisiteKind;
  label: string;
  required: true;
}

export interface SystemTestCaseManifest {
  caseId: string;
  title: string;
  requiredEvidence: readonly SystemTestEvidenceKind[];
}

export interface SystemTestBudget {
  timeoutMs: number;
  maxCpuMillis: number;
  maxMemoryMiB: number;
  maxArtifactBytes: number;
}

export interface SystemTestRetention {
  resultDays: number;
  artifactDays: number;
}

export interface SystemTestSuiteManifest {
  contractVersion: typeof SYSTEM_TEST_CONTRACT_VERSION;
  suiteVersion: number;
  id: SystemTestSuiteId;
  title: string;
  profiles: readonly SystemTestProfile[];
  prerequisites: readonly SystemTestPrerequisite[];
  cases: readonly SystemTestCaseManifest[];
  budget: SystemTestBudget;
  retention: SystemTestRetention;
}

const sharedServices = [
  prerequisite('api', 'service', 'SideStage API'),
  prerequisite('postgres', 'service', 'PostgreSQL'),
] as const;

function prerequisite(
  id: string,
  kind: SystemTestPrerequisiteKind,
  label: string,
): SystemTestPrerequisite {
  return { id, kind, label, required: true };
}

function caseSpec(
  caseId: string,
  title: string,
  ...requiredEvidence: SystemTestEvidenceKind[]
): SystemTestCaseManifest {
  return { caseId, title, requiredEvidence };
}

function budget(timeoutMs: number, maxCpuMillis: number): SystemTestBudget {
  return {
    timeoutMs,
    maxCpuMillis,
    maxMemoryMiB: 1_024,
    maxArtifactBytes: 50 * 1024 * 1024,
  };
}

const defaultRetention = { resultDays: 30, artifactDays: 7 } as const;

/**
 * The only suites launchable from the public Tests tab. Case IDs are durable
 * comparison keys: changing their meaning requires a suiteVersion increment.
 */
export const SYSTEM_TEST_SUITE_MANIFESTS: Readonly<Record<SystemTestSuiteId, SystemTestSuiteManifest>> = {
  actions: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'actions',
    title: 'Guarded actions',
    profiles: ['smoke', 'full'],
    prerequisites: [...sharedServices],
    cases: [
      caseSpec('protocol.proposal-authenticated', 'Authenticated proposals cross the public API', 'http'),
      caseSpec('protocol.confirmed-mutation', 'A confirmed action mutates isolated state', 'http', 'postgres'),
      caseSpec('evidence.audit-persisted', 'The action audit is durably attributable', 'postgres'),
      caseSpec('protocol.rollback-restored', 'Rollback restores the prior state', 'http', 'postgres'),
    ],
    budget: budget(120_000, 60_000),
    retention: defaultRetention,
  },
  auction: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'auction',
    title: 'Live auction',
    profiles: ['smoke', 'full'],
    prerequisites: [
      ...sharedServices,
      prerequisite('redis', 'service', 'Redis'),
      prerequisite('browser', 'browser', 'Browser actor'),
    ],
    cases: [
      caseSpec('protocol.inventory-hold', 'Starting an auction holds inventory', 'http', 'postgres'),
      caseSpec('protocol.bid-stream', 'Buyer bids reach subscribed clients', 'http', 'sse'),
      caseSpec('evidence.winner-persisted', 'Closing produces one persisted winner', 'http', 'postgres'),
      caseSpec('protocol.late-bid-rejected', 'Bids after close are rejected', 'http'),
    ],
    budget: budget(180_000, 90_000),
    retention: defaultRetention,
  },
  checkout: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'checkout',
    title: 'Checkout and shipping sandboxes',
    profiles: ['sandbox', 'full'],
    prerequisites: [
      ...sharedServices,
      prerequisite('square', 'sandbox-credential', 'Square sandbox'),
      prerequisite('easypost', 'sandbox-credential', 'EasyPost test mode'),
    ],
    cases: [
      caseSpec('sandbox.square-payment', 'Square authorizes a sandbox payment', 'http', 'external-sandbox'),
      caseSpec('sandbox.easypost-rate', 'EasyPost returns a test shipping rate', 'http', 'external-sandbox'),
      caseSpec('sandbox.easypost-label', 'EasyPost creates a test shipment label', 'http', 'external-sandbox'),
      caseSpec('evidence.order-persisted', 'The paid order is persisted once', 'postgres'),
      caseSpec('protocol.idempotent-retry', 'A repeated confirmation cannot double-charge', 'http', 'postgres'),
    ],
    budget: budget(240_000, 120_000),
    retention: defaultRetention,
  },
  injection: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'injection',
    title: 'Prompt-injection resistance',
    profiles: ['smoke', 'full'],
    prerequisites: [
      ...sharedServices,
      prerequisite('copilot-model', 'remote-model', 'Configured remote copilot model'),
    ],
    cases: [
      caseSpec('model.prompt-injection-refused', 'Instruction override is refused', 'http', 'remote-model'),
      caseSpec('model.fake-authority-refused', 'Fake seller authority is refused', 'http', 'remote-model'),
      caseSpec('model.inventory-fabrication-refused', 'Inventory cannot be fabricated', 'http', 'remote-model'),
      caseSpec('evidence.guardrail-decision-persisted', 'Guardrail evidence is attributable', 'postgres', 'remote-model'),
    ],
    budget: budget(300_000, 150_000),
    retention: defaultRetention,
  },
  load: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'load',
    title: 'Network load',
    profiles: ['load'],
    prerequisites: [
      ...sharedServices,
      prerequisite('redis', 'service', 'Redis'),
      prerequisite('k6', 'container-image', 'Pinned k6 image'),
    ],
    cases: [
      caseSpec('network.http-budget', 'Authenticated HTTP stays within its error and latency budget', 'http', 'metric'),
      caseSpec('network.sse-budget', 'SSE subscribers stay connected within budget', 'sse', 'metric'),
      caseSpec('network.websocket-budget', 'WebSocket traffic stays within budget', 'websocket', 'metric'),
      caseSpec('evidence.percentiles-captured', 'Throughput and latency percentiles are retained', 'metric', 'log'),
    ],
    budget: {
      timeoutMs: 900_000,
      maxCpuMillis: 600_000,
      maxMemoryMiB: 2_048,
      maxArtifactBytes: 100 * 1024 * 1024,
    },
    retention: defaultRetention,
  },
  judge: {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    suiteVersion: 1,
    id: 'judge',
    title: 'Remote reply judge',
    profiles: ['smoke', 'full'],
    prerequisites: [
      ...sharedServices,
      prerequisite('judge-model', 'remote-model', 'Configured remote judge model'),
    ],
    cases: [
      caseSpec('model.remote-judge-called', 'The configured remote judge evaluates the corpus', 'http', 'remote-model'),
      caseSpec('model.prompt-provenance', 'Model and prompt provenance are captured', 'remote-model', 'log'),
      caseSpec('model.score-schema', 'Every score satisfies the versioned schema', 'remote-model'),
      caseSpec('evidence.case-results-persisted', 'Per-case results are durably retained', 'postgres'),
    ],
    budget: budget(300_000, 150_000),
    retention: defaultRetention,
  },
};

export interface SystemTestRunRequest {
  contractVersion: typeof SYSTEM_TEST_CONTRACT_VERSION;
  suiteId: SystemTestSuiteId;
  suiteVersion: number;
  profile: SystemTestProfile;
  requestedSha: string;
  /** Optional isolated-fixture label; never interpreted as a URL or selector. */
  eventId?: string;
}

export interface SystemTestActor {
  id: string;
  role: 'operator' | 'release';
}

export interface SystemTestEvidence {
  id: string;
  kind: SystemTestEvidenceKind;
  /** Opaque storage locator issued by the trusted worker, never dereferenced by it. */
  ref: string;
  summary: string;
  capturedAt: string;
  deployedSha: string;
}

export interface SystemTestCaseResult {
  caseId: string;
  status: SystemTestCaseStatus;
  summary: string;
  evidence: SystemTestEvidence[];
}

export interface SystemTestTransition {
  state: 'queued' | 'provisioning' | 'running' | 'collecting' | 'cleaning' | 'finished';
  at: string;
}

export interface SystemTestConfigurationProvenance {
  name: string;
  fingerprint: string;
}

export interface SystemTestSubstitution {
  kind: 'mock' | 'fake' | 'fallback';
  component: string;
  reason: string;
}

export interface SystemTestCleanupResult {
  status: 'succeeded' | 'failed' | 'pending' | 'not-started';
  finishedAt?: string;
  summary: string;
}

export interface SystemTestRunResult {
  contractVersion: typeof SYSTEM_TEST_CONTRACT_VERSION;
  runId: string;
  suiteId: SystemTestSuiteId;
  suiteVersion: number;
  profile: SystemTestProfile;
  status: SystemTestRunStatus;
  actor: SystemTestActor;
  requestedSha: string;
  deployedSha: string | null;
  imageDigests: Record<string, string>;
  configurationProvenance: SystemTestConfigurationProvenance[];
  productionProtocol: boolean;
  isolated: boolean;
  substitutions: SystemTestSubstitution[];
  startedAt: string;
  finishedAt: string;
  transitions: SystemTestTransition[];
  cases: SystemTestCaseResult[];
  blockedReasons: string[];
  cleanup: SystemTestCleanupResult;
  retentionExpiresAt: string;
}

export class SystemTestContractError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid system-test contract: ${issues.join('; ')}`);
    this.name = 'SystemTestContractError';
    this.issues = issues;
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/;
const EVIDENCE_KINDS = new Set<SystemTestEvidenceKind>([
  'http', 'sse', 'websocket', 'postgres', 'typesense', 'redis', 'mediamtx',
  'external-sandbox', 'remote-model', 'metric', 'log', 'screenshot',
]);
const PROFILES = new Set<SystemTestProfile>(['smoke', 'full', 'sandbox', 'load']);
const RUN_STATUSES = new Set<SystemTestRunStatus>(['passed', 'failed', 'blocked', 'cancelled']);
const CASE_STATUSES = new Set<SystemTestCaseStatus>(['passed', 'failed', 'blocked', 'not-run']);

function record(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

function stringValue(
  value: unknown,
  path: string,
  issues: string[],
  options: { pattern?: RegExp; max?: number; nonempty?: boolean } = { nonempty: true },
): string {
  if (typeof value !== 'string') {
    issues.push(`${path} must be a string`);
    return '';
  }
  if (options.nonempty !== false && value.trim().length === 0) issues.push(`${path} must not be empty`);
  if (options.max !== undefined && value.length > options.max) issues.push(`${path} must be at most ${options.max} characters`);
  if (options.pattern && !options.pattern.test(value)) issues.push(`${path} has an invalid format`);
  return value;
}

function integer(
  value: unknown,
  path: string,
  issues: string[],
  min = 1,
): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    issues.push(`${path} must be an integer >= ${min}`);
    return min;
  }
  return value as number;
}

function array(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function booleanValue(value: unknown, path: string, issues: string[]): boolean {
  if (typeof value !== 'boolean') {
    issues.push(`${path} must be a boolean`);
    return false;
  }
  return value;
}

function isoDate(value: unknown, path: string, issues: string[]): string {
  const result = stringValue(value, path, issues, { pattern: ISO_DATE_PATTERN, max: 40 });
  if (result && Number.isNaN(Date.parse(result))) issues.push(`${path} must be an ISO timestamp`);
  return result;
}

export function isSystemTestSuiteId(value: unknown): value is SystemTestSuiteId {
  return typeof value === 'string' && SYSTEM_TEST_SUITE_IDS.includes(value as SystemTestSuiteId);
}

export function getSystemTestSuiteManifest(suiteId: string): SystemTestSuiteManifest {
  if (!isSystemTestSuiteId(suiteId)) {
    throw new SystemTestContractError([`suiteId must be one of: ${SYSTEM_TEST_SUITE_IDS.join(', ')}`]);
  }
  return SYSTEM_TEST_SUITE_MANIFESTS[suiteId];
}

export function parseSystemTestSuiteManifest(value: unknown): SystemTestSuiteManifest {
  const issues: string[] = [];
  const input = record(value, 'manifest', issues);
  exactKeys(input, [
    'contractVersion', 'suiteVersion', 'id', 'title', 'profiles',
    'prerequisites', 'cases', 'budget', 'retention',
  ], 'manifest', issues);
  if (input.contractVersion !== SYSTEM_TEST_CONTRACT_VERSION) {
    issues.push(`manifest.contractVersion must equal ${SYSTEM_TEST_CONTRACT_VERSION}`);
  }
  integer(input.suiteVersion, 'manifest.suiteVersion', issues);
  if (!isSystemTestSuiteId(input.id)) issues.push(`manifest.id must be an allow-listed suite ID`);
  stringValue(input.title, 'manifest.title', issues, { max: 120 });

  const profiles = array(input.profiles, 'manifest.profiles', issues);
  if (profiles.length === 0) issues.push('manifest.profiles must not be empty');
  for (const [index, profile] of profiles.entries()) {
    if (!PROFILES.has(profile as SystemTestProfile)) issues.push(`manifest.profiles[${index}] is unknown`);
  }

  const prerequisites = array(input.prerequisites, 'manifest.prerequisites', issues);
  for (const [index, entry] of prerequisites.entries()) {
    const item = record(entry, `manifest.prerequisites[${index}]`, issues);
    exactKeys(item, ['id', 'kind', 'label', 'required'], `manifest.prerequisites[${index}]`, issues);
    stringValue(item.id, `manifest.prerequisites[${index}].id`, issues, { pattern: ID_PATTERN, max: 128 });
    if (!['service', 'sandbox-credential', 'remote-model', 'container-image', 'browser'].includes(String(item.kind))) {
      issues.push(`manifest.prerequisites[${index}].kind is unknown`);
    }
    stringValue(item.label, `manifest.prerequisites[${index}].label`, issues, { max: 160 });
    if (item.required !== true) issues.push(`manifest.prerequisites[${index}].required must be true`);
  }

  const cases = array(input.cases, 'manifest.cases', issues);
  if (cases.length === 0) issues.push('manifest.cases must not be empty');
  const seenCaseIds = new Set<string>();
  for (const [index, entry] of cases.entries()) {
    const item = record(entry, `manifest.cases[${index}]`, issues);
    exactKeys(item, ['caseId', 'title', 'requiredEvidence'], `manifest.cases[${index}]`, issues);
    const caseId = stringValue(item.caseId, `manifest.cases[${index}].caseId`, issues, { pattern: ID_PATTERN, max: 128 });
    if (seenCaseIds.has(caseId)) issues.push(`manifest.cases[${index}].caseId is duplicated`);
    seenCaseIds.add(caseId);
    stringValue(item.title, `manifest.cases[${index}].title`, issues, { max: 200 });
    const requiredEvidence = array(item.requiredEvidence, `manifest.cases[${index}].requiredEvidence`, issues);
    if (requiredEvidence.length === 0) issues.push(`manifest.cases[${index}].requiredEvidence must not be empty`);
    for (const [evidenceIndex, kind] of requiredEvidence.entries()) {
      if (!EVIDENCE_KINDS.has(kind as SystemTestEvidenceKind)) {
        issues.push(`manifest.cases[${index}].requiredEvidence[${evidenceIndex}] is unknown`);
      }
    }
  }

  const budgetValue = record(input.budget, 'manifest.budget', issues);
  exactKeys(budgetValue, ['timeoutMs', 'maxCpuMillis', 'maxMemoryMiB', 'maxArtifactBytes'], 'manifest.budget', issues);
  integer(budgetValue.timeoutMs, 'manifest.budget.timeoutMs', issues);
  integer(budgetValue.maxCpuMillis, 'manifest.budget.maxCpuMillis', issues);
  integer(budgetValue.maxMemoryMiB, 'manifest.budget.maxMemoryMiB', issues);
  integer(budgetValue.maxArtifactBytes, 'manifest.budget.maxArtifactBytes', issues);

  const retention = record(input.retention, 'manifest.retention', issues);
  exactKeys(retention, ['resultDays', 'artifactDays'], 'manifest.retention', issues);
  integer(retention.resultDays, 'manifest.retention.resultDays', issues);
  integer(retention.artifactDays, 'manifest.retention.artifactDays', issues);

  if (issues.length > 0) throw new SystemTestContractError(issues);
  return value as SystemTestSuiteManifest;
}

export function parseSystemTestRunRequest(value: unknown): SystemTestRunRequest {
  const issues: string[] = [];
  const input = record(value, 'request', issues);
  exactKeys(input, ['contractVersion', 'suiteId', 'suiteVersion', 'profile', 'requestedSha', 'eventId'], 'request', issues);
  if (input.contractVersion !== SYSTEM_TEST_CONTRACT_VERSION) {
    issues.push(`request.contractVersion must equal ${SYSTEM_TEST_CONTRACT_VERSION}`);
  }
  const suiteId = input.suiteId;
  if (!isSystemTestSuiteId(suiteId)) {
    issues.push(`request.suiteId must be one of: ${SYSTEM_TEST_SUITE_IDS.join(', ')}`);
  } else {
    const manifest = SYSTEM_TEST_SUITE_MANIFESTS[suiteId];
    if (input.suiteVersion !== manifest.suiteVersion) {
      issues.push(`request.suiteVersion must equal ${manifest.suiteVersion} for ${suiteId}`);
    }
    if (!manifest.profiles.includes(input.profile as SystemTestProfile)) {
      issues.push(`request.profile is not enabled for ${suiteId}`);
    }
  }
  stringValue(input.requestedSha, 'request.requestedSha', issues, { pattern: SHA_PATTERN, max: 40 });
  if (input.eventId !== undefined) {
    stringValue(input.eventId, 'request.eventId', issues, { pattern: ID_PATTERN, max: 128 });
  }
  if (issues.length > 0) throw new SystemTestContractError(issues);
  return value as SystemTestRunRequest;
}

function validateEvidence(
  value: unknown,
  path: string,
  expectedSha: string | null,
  issues: string[],
): SystemTestEvidenceKind | null {
  const input = record(value, path, issues);
  exactKeys(input, ['id', 'kind', 'ref', 'summary', 'capturedAt', 'deployedSha'], path, issues);
  stringValue(input.id, `${path}.id`, issues, { pattern: ID_PATTERN, max: 128 });
  const kind = EVIDENCE_KINDS.has(input.kind as SystemTestEvidenceKind)
    ? input.kind as SystemTestEvidenceKind
    : null;
  if (!kind) issues.push(`${path}.kind is unknown`);
  stringValue(input.ref, `${path}.ref`, issues, { max: 500 });
  stringValue(input.summary, `${path}.summary`, issues, { max: 2_000 });
  isoDate(input.capturedAt, `${path}.capturedAt`, issues);
  const deployedSha = stringValue(input.deployedSha, `${path}.deployedSha`, issues, { pattern: SHA_PATTERN, max: 40 });
  if (expectedSha && deployedSha !== expectedSha) issues.push(`${path}.deployedSha must match result.deployedSha`);
  return kind;
}

export function parseSystemTestRunResult(value: unknown): SystemTestRunResult {
  const issues: string[] = [];
  const input = record(value, 'result', issues);
  exactKeys(input, [
    'contractVersion', 'runId', 'suiteId', 'suiteVersion', 'profile', 'status', 'actor',
    'requestedSha', 'deployedSha', 'imageDigests', 'configurationProvenance',
    'productionProtocol', 'isolated', 'substitutions', 'startedAt', 'finishedAt',
    'transitions', 'cases', 'blockedReasons', 'cleanup', 'retentionExpiresAt',
  ], 'result', issues);
  if (input.contractVersion !== SYSTEM_TEST_CONTRACT_VERSION) {
    issues.push(`result.contractVersion must equal ${SYSTEM_TEST_CONTRACT_VERSION}`);
  }
  stringValue(input.runId, 'result.runId', issues, { pattern: ID_PATTERN, max: 128 });

  const suiteId = input.suiteId;
  const manifest = isSystemTestSuiteId(suiteId) ? SYSTEM_TEST_SUITE_MANIFESTS[suiteId] : null;
  if (!manifest) issues.push(`result.suiteId must be one of: ${SYSTEM_TEST_SUITE_IDS.join(', ')}`);
  if (manifest && input.suiteVersion !== manifest.suiteVersion) {
    issues.push(`result.suiteVersion must equal ${manifest.suiteVersion} for ${suiteId}`);
  }
  if (manifest && !manifest.profiles.includes(input.profile as SystemTestProfile)) {
    issues.push(`result.profile is not enabled for ${suiteId}`);
  }
  const status = RUN_STATUSES.has(input.status as SystemTestRunStatus)
    ? input.status as SystemTestRunStatus
    : null;
  if (!status) issues.push('result.status is unknown');

  const actor = record(input.actor, 'result.actor', issues);
  exactKeys(actor, ['id', 'role'], 'result.actor', issues);
  stringValue(actor.id, 'result.actor.id', issues, { max: 160 });
  if (actor.role !== 'operator' && actor.role !== 'release') issues.push('result.actor.role is unknown');

  const requestedSha = stringValue(input.requestedSha, 'result.requestedSha', issues, { pattern: SHA_PATTERN, max: 40 });
  const deployedSha = input.deployedSha === null
    ? null
    : stringValue(input.deployedSha, 'result.deployedSha', issues, { pattern: SHA_PATTERN, max: 40 });
  const imageDigests = record(input.imageDigests, 'result.imageDigests', issues);
  for (const [name, digest] of Object.entries(imageDigests)) {
    stringValue(name, `result.imageDigests key`, issues, { pattern: ID_PATTERN, max: 128 });
    stringValue(digest, `result.imageDigests.${name}`, issues, { pattern: /^sha256:[0-9a-f]{64}$/, max: 71 });
  }

  const provenance = array(input.configurationProvenance, 'result.configurationProvenance', issues);
  for (const [index, entry] of provenance.entries()) {
    const item = record(entry, `result.configurationProvenance[${index}]`, issues);
    exactKeys(item, ['name', 'fingerprint'], `result.configurationProvenance[${index}]`, issues);
    stringValue(item.name, `result.configurationProvenance[${index}].name`, issues, { max: 160 });
    stringValue(item.fingerprint, `result.configurationProvenance[${index}].fingerprint`, issues, { max: 300 });
  }

  const productionProtocol = booleanValue(input.productionProtocol, 'result.productionProtocol', issues);
  const isolated = booleanValue(input.isolated, 'result.isolated', issues);
  const substitutions = array(input.substitutions, 'result.substitutions', issues);
  for (const [index, entry] of substitutions.entries()) {
    const item = record(entry, `result.substitutions[${index}]`, issues);
    exactKeys(item, ['kind', 'component', 'reason'], `result.substitutions[${index}]`, issues);
    if (!['mock', 'fake', 'fallback'].includes(String(item.kind))) issues.push(`result.substitutions[${index}].kind is unknown`);
    stringValue(item.component, `result.substitutions[${index}].component`, issues, { max: 160 });
    stringValue(item.reason, `result.substitutions[${index}].reason`, issues, { max: 1_000 });
  }

  isoDate(input.startedAt, 'result.startedAt', issues);
  isoDate(input.finishedAt, 'result.finishedAt', issues);
  isoDate(input.retentionExpiresAt, 'result.retentionExpiresAt', issues);

  const transitions = array(input.transitions, 'result.transitions', issues);
  for (const [index, entry] of transitions.entries()) {
    const item = record(entry, `result.transitions[${index}]`, issues);
    exactKeys(item, ['state', 'at'], `result.transitions[${index}]`, issues);
    if (!['queued', 'provisioning', 'running', 'collecting', 'cleaning', 'finished'].includes(String(item.state))) {
      issues.push(`result.transitions[${index}].state is unknown`);
    }
    isoDate(item.at, `result.transitions[${index}].at`, issues);
  }

  const cases = array(input.cases, 'result.cases', issues);
  const seenCases = new Map<string, { status: SystemTestCaseStatus | null; evidenceKinds: Set<SystemTestEvidenceKind> }>();
  for (const [index, entry] of cases.entries()) {
    const item = record(entry, `result.cases[${index}]`, issues);
    exactKeys(item, ['caseId', 'status', 'summary', 'evidence'], `result.cases[${index}]`, issues);
    const caseId = stringValue(item.caseId, `result.cases[${index}].caseId`, issues, { pattern: ID_PATTERN, max: 128 });
    const caseStatus = CASE_STATUSES.has(item.status as SystemTestCaseStatus)
      ? item.status as SystemTestCaseStatus
      : null;
    if (!caseStatus) issues.push(`result.cases[${index}].status is unknown`);
    stringValue(item.summary, `result.cases[${index}].summary`, issues, { max: 2_000 });
    const evidenceKinds = new Set<SystemTestEvidenceKind>();
    for (const [evidenceIndex, evidence] of array(item.evidence, `result.cases[${index}].evidence`, issues).entries()) {
      const kind = validateEvidence(evidence, `result.cases[${index}].evidence[${evidenceIndex}]`, deployedSha, issues);
      if (kind) evidenceKinds.add(kind);
    }
    if (seenCases.has(caseId)) issues.push(`result.cases contains duplicate caseId ${caseId}`);
    seenCases.set(caseId, { status: caseStatus, evidenceKinds });
  }

  if (manifest) {
    const expectedCases = new Set(manifest.cases.map((entry) => entry.caseId));
    for (const caseId of seenCases.keys()) {
      if (!expectedCases.has(caseId)) issues.push(`result.cases contains unknown caseId ${caseId}`);
    }
    for (const caseManifest of manifest.cases) {
      const caseResult = seenCases.get(caseManifest.caseId);
      if (!caseResult) {
        issues.push(`result.cases is missing ${caseManifest.caseId}`);
        continue;
      }
      if (caseResult.status === 'passed') {
        for (const evidenceKind of caseManifest.requiredEvidence) {
          if (!caseResult.evidenceKinds.has(evidenceKind)) {
            issues.push(`passed case ${caseManifest.caseId} is missing required ${evidenceKind} evidence`);
          }
        }
      }
    }
  }

  const blockedReasons = array(input.blockedReasons, 'result.blockedReasons', issues);
  for (const [index, reason] of blockedReasons.entries()) {
    stringValue(reason, `result.blockedReasons[${index}]`, issues, { max: 2_000 });
  }

  const cleanup = record(input.cleanup, 'result.cleanup', issues);
  exactKeys(cleanup, ['status', 'finishedAt', 'summary'], 'result.cleanup', issues);
  if (!['succeeded', 'failed', 'pending', 'not-started'].includes(String(cleanup.status))) {
    issues.push('result.cleanup.status is unknown');
  }
  if (cleanup.finishedAt !== undefined) isoDate(cleanup.finishedAt, 'result.cleanup.finishedAt', issues);
  stringValue(cleanup.summary, 'result.cleanup.summary', issues, { max: 2_000 });

  if (status === 'passed') {
    if (requestedSha !== deployedSha) issues.push('passed result requires requestedSha to equal deployedSha');
    if (!productionProtocol) issues.push('passed result requires productionProtocol=true');
    if (!isolated) issues.push('passed result requires isolated=true');
    if (substitutions.length > 0) issues.push('passed result cannot contain mock, fake, or fallback substitutions');
    if (Object.keys(imageDigests).length === 0) issues.push('passed result requires running image digests');
    if (provenance.length === 0) issues.push('passed result requires configuration provenance');
    if (cases.length === 0 || [...seenCases.values()].some((entry) => entry.status !== 'passed')) {
      issues.push('passed result requires every manifest case to pass');
    }
    if (blockedReasons.length > 0) issues.push('passed result cannot contain blocked reasons');
    if (cleanup.status !== 'succeeded') issues.push('passed result requires successful cleanup');
  }
  if (status === 'failed' && ![...seenCases.values()].some((entry) => entry.status === 'failed')) {
    issues.push('failed result requires at least one failed case');
  }
  if (status === 'blocked' && blockedReasons.length === 0) {
    issues.push('blocked result requires at least one blocked reason');
  }

  if (issues.length > 0) throw new SystemTestContractError(issues);
  return value as SystemTestRunResult;
}

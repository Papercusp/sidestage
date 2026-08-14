import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SystemTestRunRequest } from '@papercusp/system-test-contract';

export const ACCEPTANCE_SERVICES = [
  'postgres',
  'typesense',
  'redis',
  'mediamtx',
  'api',
  'web',
  'worker',
] as const;

export type AcceptanceService = (typeof ACCEPTANCE_SERVICES)[number];

export interface AcceptanceProvisionRequest extends Pick<SystemTestRunRequest, 'requestedSha'> {
  runId: string;
  repositoryRoot: string;
}

export interface AcceptanceCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface AcceptanceCommandResult {
  stdout: string;
  stderr: string;
}

export interface AcceptanceCommandRunner {
  run(command: string, args: readonly string[], options: AcceptanceCommandOptions): Promise<AcceptanceCommandResult>;
}

export interface AcceptanceImageEvidence {
  service: AcceptanceService;
  repository: string;
  tag: string;
  digest: string;
}

export interface AcceptanceHealthEvidence {
  service: AcceptanceService;
  state: string;
  health: string;
}

export interface AcceptanceEnvironmentEvidence {
  runId: string;
  projectName: string;
  requestedSha: string;
  deployedSha: string;
  imageDigests: AcceptanceImageEvidence[];
  healthChecks: AcceptanceHealthEvidence[];
  apiHealth: { status: string; service: string; sha: string };
  workerHealth: { status: string; service: string; sha: string; runId: string };
}

export interface AcceptanceEnvironmentHandle extends AcceptanceEnvironmentEvidence {
  teardown(): Promise<void>;
}

export type AcceptanceProvisioningStage =
  | 'validate'
  | 'same-sha'
  | 'compose-config'
  | 'compose-up'
  | 'health'
  | 'teardown';

export class AcceptanceEnvironmentBlockedError extends Error {
  readonly stage: AcceptanceProvisioningStage;
  readonly blockedReason: string;
  readonly cleanupAttempted: boolean;

  constructor(
    stage: AcceptanceProvisioningStage,
    blockedReason: string,
    options: { cause?: unknown; cleanupAttempted?: boolean } = {},
  ) {
    super(`Acceptance environment blocked during ${stage}: ${blockedReason}`, { cause: options.cause });
    this.name = 'AcceptanceEnvironmentBlockedError';
    this.stage = stage;
    this.blockedReason = blockedReason;
    this.cleanupAttempted = options.cleanupAttempted ?? false;
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PROD_PATH_PATTERN = /^\/opt\/SideStage(?:\/|$)/i;
const PROD_MARKERS = [
  /sidestage\.buyrestart\.com/i,
  /\/opt\/SideStage(?:\/|$)/,
  /coolify/i,
];

function validatedRepositoryRoot(request: AcceptanceProvisionRequest): string {
  if (!RUN_ID_PATTERN.test(request.runId)) {
    throw new AcceptanceEnvironmentBlockedError(
      'validate',
      'runId must be a lowercase identifier no longer than 40 characters',
    );
  }
  if (!SHA_PATTERN.test(request.requestedSha)) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'requestedSha must be a full lowercase git SHA');
  }
  if (!isAbsolute(request.repositoryRoot)) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'repositoryRoot must be an absolute path');
  }
  const resolved = resolve(request.repositoryRoot);
  if (PROD_PATH_PATTERN.test(resolved)) {
    throw new AcceptanceEnvironmentBlockedError(
      'validate',
      'the production checkout can never be an acceptance build context',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (cause) {
    throw new AcceptanceEnvironmentBlockedError('validate', 'repositoryRoot must exist and be readable', { cause });
  }
  if (PROD_PATH_PATTERN.test(canonical)) {
    throw new AcceptanceEnvironmentBlockedError(
      'validate',
      'repositoryRoot resolves to the production checkout',
    );
  }
  return canonical;
}

function parseJsonRows(output: string, label: string): Record<string, unknown>[] {
  const source = output.trim();
  if (!source) throw new Error(`${label} returned no rows`);
  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  } catch {
    const rows = source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (rows.length > 0) return rows;
  }
  throw new Error(`${label} did not return JSON objects`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

function asService(value: string): AcceptanceService | null {
  return ACCEPTANCE_SERVICES.includes(value as AcceptanceService) ? value as AcceptanceService : null;
}

function serviceFromComposeRow(row: Record<string, unknown>): AcceptanceService | null {
  const explicit = asService(field(row, 'Service', 'service'));
  if (explicit) return explicit;
  const containerName = field(row, 'ContainerName', 'containerName', 'Name', 'name');
  return ACCEPTANCE_SERVICES.find((service) => (
    new RegExp(`-${service}-\\d+$`).test(containerName)
  )) ?? null;
}

function assertExactlyOnePerService<T extends { service: AcceptanceService }>(rows: T[], label: string): void {
  const counts = new Map<AcceptanceService, number>();
  for (const row of rows) counts.set(row.service, (counts.get(row.service) ?? 0) + 1);
  for (const service of ACCEPTANCE_SERVICES) {
    const count = counts.get(service) ?? 0;
    if (count !== 1) throw new Error(`${label} returned ${count} rows for ${service}; expected exactly one`);
  }
}

/** Parse the real Docker Compose JSON shape, which identifies image rows by ContainerName. */
export function parseAcceptanceImages(output: string): AcceptanceImageEvidence[] {
  const images = parseJsonRows(output, 'docker compose images').map((row) => {
    const service = serviceFromComposeRow(row);
    const rowName = field(row, 'Service', 'service', 'ContainerName', 'containerName', 'Name', 'name');
    if (!service) throw new Error(`docker compose images returned unknown service row ${rowName || '(unnamed)'}`);
    const digest = field(row, 'ID', 'Id', 'id', 'Digest', 'digest');
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`service ${service} has no content-addressed image digest`);
    }
    const repository = field(row, 'Repository', 'repository');
    const tag = field(row, 'Tag', 'tag');
    if (!repository || !tag || tag === '<none>') {
      throw new Error(`service ${service} has no attributable repository and tag`);
    }
    return { service, repository, tag, digest };
  });
  assertExactlyOnePerService(images, 'docker compose images');
  return images;
}

export function parseAcceptanceHealth(output: string): AcceptanceHealthEvidence[] {
  const health = parseJsonRows(output, 'docker compose ps').map((row) => {
    const service = serviceFromComposeRow(row);
    const rowName = field(row, 'Service', 'service', 'Name', 'name');
    if (!service) throw new Error(`docker compose ps returned unknown service row ${rowName || '(unnamed)'}`);
    const state = field(row, 'State', 'state').toLowerCase();
    const probe = field(row, 'Health', 'health').toLowerCase() || 'running';
    if (state !== 'running') throw new Error(`service ${service} is ${state || 'unknown'}, not running`);
    if (!['healthy', 'running'].includes(probe)) throw new Error(`service ${service} health is ${probe}`);
    return { service, state, health: probe };
  });
  assertExactlyOnePerService(health, 'docker compose ps');
  return health;
}

export function validateAcceptanceComposeConfig(output: string, projectName: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new Error('docker compose config did not return valid JSON', { cause });
  }
  const config = record(parsed, 'docker compose config');
  const services = record(config.services, 'docker compose config services');
  const serviceNames = Object.keys(services).sort();
  const expectedNames = [...ACCEPTANCE_SERVICES].sort();
  if (JSON.stringify(serviceNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`acceptance Compose services were ${serviceNames.join(', ') || '(none)'}`);
  }
  for (const serviceName of ACCEPTANCE_SERVICES) {
    const service = record(services[serviceName], `service ${serviceName}`);
    if (Array.isArray(service.ports) && service.ports.length > 0) {
      throw new Error(`service ${serviceName} publishes host ports`);
    }
    if (service.network_mode === 'host') throw new Error(`service ${serviceName} uses the host network`);
    if (Array.isArray(service.volumes)) {
      for (const mount of service.volumes) {
        if (record(mount, `service ${serviceName} volume`).type === 'volume') {
          throw new Error(`service ${serviceName} uses a persistent named volume`);
        }
      }
    }
    const attachedNetworks = service.networks === undefined
      ? []
      : Object.keys(record(service.networks, `service ${serviceName} networks`));
    if (attachedNetworks.some((name) => name !== 'default')) {
      throw new Error(`service ${serviceName} attaches a non-isolated network`);
    }
  }
  const typesense = record(services.typesense, 'service typesense');
  const typesenseTmpfs = Array.isArray(typesense.tmpfs) ? typesense.tmpfs : [];
  const hasEphemeralDataDir = typesenseTmpfs.some((mount) => {
    if (typeof mount === 'string') return mount.split(':', 1)[0] === '/data';
    return record(mount, 'service typesense tmpfs mount').target === '/data';
  });
  if (!hasEphemeralDataDir) {
    throw new Error('service typesense must mount an ephemeral tmpfs at /data');
  }
  const apiEnvironment = record(
    record(services.api, 'service api').environment,
    'service api environment',
  );
  const internalEndpoints: Record<string, string | RegExp> = {
    NODE_ENV: 'test',
    TYPESENSE_HOST: 'typesense',
    REDIS_URL: 'redis://redis:6379',
    MEDIAMTX_HOST: 'mediamtx',
    MEDIAMTX_WHIP_URL: 'http://mediamtx:8889',
    MEDIAMTX_WHEP_URL: 'http://mediamtx:8889',
    DATABASE_URL: /^postgresql:\/\/[^@]+@postgres:5432\//,
  };
  for (const [key, expected] of Object.entries(internalEndpoints)) {
    const value = apiEnvironment[key];
    const matches = typeof expected === 'string'
      ? value === expected
      : typeof value === 'string' && expected.test(value);
    if (!matches) throw new Error(`service api ${key} does not target the isolated acceptance dependency`);
  }
  for (const key of ['SQUARE_APP_ID', 'SQUARE_LOCATION_ID', 'SQUARE_ACCESS_TOKEN', 'EASYPOST_API_KEY']) {
    if (apiEnvironment[key] !== '') {
      throw new Error(`service api must not inherit host credential ${key}`);
    }
  }
  const networks = record(config.networks, 'docker compose config networks');
  const defaultNetwork = record(networks.default, 'acceptance default network');
  if (defaultNetwork.external === true || defaultNetwork.name !== `${projectName}_default`) {
    throw new Error('acceptance default network is external or not scoped to the run');
  }
  if (config.volumes && Object.keys(record(config.volumes, 'docker compose config volumes')).length > 0) {
    throw new Error('acceptance Compose declares persistent named volumes');
  }
  const rendered = JSON.stringify(config);
  for (const marker of PROD_MARKERS) {
    if (marker.test(rendered)) throw new Error(`acceptance Compose contains forbidden production marker ${marker.source}`);
  }
}

class SpawnCommandRunner implements AcceptanceCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: AcceptanceCommandOptions,
  ): Promise<AcceptanceCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8');
        if (next.length > 2_000_000) {
          child.kill('SIGKILL');
          reject(new Error(`${command} output exceeded 2 MB`));
        }
        return next;
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${command} timed out after ${options.timeoutMs ?? 600_000}ms`));
      }, options.timeoutMs ?? 600_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise({ stdout, stderr });
        else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }
}

function safeEnvironment(request: AcceptanceProvisionRequest, projectName: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    DOCKER_CONTEXT: 'default',
    SIDESTAGE_SHA: request.requestedSha,
    ACCEPTANCE_RUN_ID: request.runId,
    NODE_ENV: 'test',
    POSTGRES_DB: `acceptance_${request.runId.replaceAll('-', '_')}`,
    POSTGRES_USER: 'sidestage_acceptance',
    POSTGRES_PASSWORD: `acceptance-${request.runId}-postgres`,
    TYPESENSE_API_KEY: `acceptance-${request.runId}-typesense`,
  };
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'COMPOSE_FILE',
    'COMPOSE_PATH_SEPARATOR',
    'COMPOSE_PROFILES',
  ]) delete env[key];
  return env;
}

function parseHealthPayload(
  output: string,
  expected: { service: string; sha: string; runId?: string },
): Record<string, string> {
  const payload = JSON.parse(output.trim()) as Record<string, unknown>;
  if (payload.status !== 'ok' || payload.service !== expected.service || payload.sha !== expected.sha) {
    throw new Error(`${expected.service} health payload did not prove requested SHA ${expected.sha}`);
  }
  if (expected.runId !== undefined && payload.runId !== expected.runId) {
    throw new Error(`${expected.service} health payload did not prove run ${expected.runId}`);
  }
  return payload as Record<string, string>;
}

export class AcceptanceEnvironmentProvisioner {
  readonly #runner: AcceptanceCommandRunner;
  readonly #tornDown = new Set<string>();

  constructor(runner: AcceptanceCommandRunner = new SpawnCommandRunner()) {
    this.#runner = runner;
  }

  async provision(request: AcceptanceProvisionRequest): Promise<AcceptanceEnvironmentHandle> {
    const repositoryRoot = validatedRepositoryRoot(request);
    const projectName = `sidestage-acceptance-${request.runId}`;
    const env = safeEnvironment(request, projectName);
    const compose = [
      'compose',
      '-p', projectName,
      '-f', 'docker-compose.yml',
      '-f', 'infra/docker-compose.acceptance.yml',
    ] as const;
    const runCompose = (args: readonly string[], timeoutMs?: number) => (
      this.#runner.run('docker', [...compose, ...args], { cwd: repositoryRoot, env, timeoutMs })
    );

    let head: string;
    let dirty: string;
    try {
      head = (await this.#runner.run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
      dirty = (await this.#runner.run(
        'git',
        ['status', '--porcelain', '--untracked-files=all'],
        { cwd: repositoryRoot },
      )).stdout.trim();
    } catch (cause) {
      throw new AcceptanceEnvironmentBlockedError('same-sha', 'could not verify the acceptance checkout', { cause });
    }
    if (head !== request.requestedSha) {
      throw new AcceptanceEnvironmentBlockedError(
        'same-sha',
        `repository HEAD ${head || '(unknown)'} does not match requested SHA ${request.requestedSha}`,
      );
    }
    if (dirty) {
      throw new AcceptanceEnvironmentBlockedError(
        'same-sha',
        'repository has changes outside the requested commit',
      );
    }

    try {
      const rendered = await runCompose(['config', '--format', 'json']);
      validateAcceptanceComposeConfig(rendered.stdout, projectName);
    } catch (cause) {
      throw new AcceptanceEnvironmentBlockedError('compose-config', 'acceptance Compose config is unsafe or invalid', {
        cause,
      });
    }

    let cleanupAttempted = false;
    const teardown = async (): Promise<void> => {
      if (this.#tornDown.has(projectName)) return;
      cleanupAttempted = true;
      await runCompose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], 120_000);
      this.#tornDown.add(projectName);
    };

    let failureStage: AcceptanceProvisioningStage = 'compose-up';
    try {
      await runCompose(['up', '--build', '--wait', '--detach'], 900_000);
      failureStage = 'health';
      const [imagesOutput, psOutput, apiOutput, workerOutput] = await Promise.all([
        runCompose(['images', '--format', 'json']),
        runCompose(['ps', '--format', 'json']),
        runCompose(['exec', '-T', 'api', 'node', '-e',
          "fetch('http://127.0.0.1:3100/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))"]),
        runCompose(['exec', '-T', 'worker', 'node', '-e',
          "fetch('http://127.0.0.1:3101/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))"]),
      ]);
      const imageDigests = parseAcceptanceImages(imagesOutput.stdout);
      for (const service of ['api', 'web', 'worker'] as const) {
        const image = imageDigests.find((entry) => entry.service === service);
        if (image?.tag !== request.requestedSha) {
          throw new Error(`service ${service} image tag does not prove requested SHA ${request.requestedSha}`);
        }
      }
      const healthChecks = parseAcceptanceHealth(psOutput.stdout);
      const apiHealth = parseHealthPayload(apiOutput.stdout, {
        service: 'sidestage-api',
        sha: request.requestedSha,
      });
      const workerHealth = parseHealthPayload(workerOutput.stdout, {
        service: 'sidestage-acceptance-worker',
        sha: request.requestedSha,
        runId: request.runId,
      });
      return {
        runId: request.runId,
        projectName,
        requestedSha: request.requestedSha,
        deployedSha: apiHealth.sha,
        imageDigests,
        healthChecks,
        apiHealth: apiHealth as AcceptanceEnvironmentEvidence['apiHealth'],
        workerHealth: workerHealth as AcceptanceEnvironmentEvidence['workerHealth'],
        teardown,
      };
    } catch (cause) {
      try {
        await teardown();
      } catch (cleanupCause) {
        throw new AcceptanceEnvironmentBlockedError(
          'teardown',
          `provisioning failed and cleanup also failed: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}`,
          { cause, cleanupAttempted: true },
        );
      }
      throw new AcceptanceEnvironmentBlockedError(
        failureStage,
        cause instanceof Error ? cause.message : String(cause),
        { cause, cleanupAttempted },
      );
    }
  }
}

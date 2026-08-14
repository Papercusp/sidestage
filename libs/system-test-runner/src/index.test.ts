import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_SERVICES,
  AcceptanceEnvironmentBlockedError,
  AcceptanceEnvironmentProvisioner,
  type AcceptanceCommandOptions,
  type AcceptanceCommandResult,
  type AcceptanceCommandRunner,
  parseAcceptanceHealth,
  parseAcceptanceImages,
  validateAcceptanceComposeConfig,
} from './index';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REPOSITORY_ROOT = process.cwd();
const PROJECT_NAME = 'sidestage-acceptance-run-1';

class FakeRunner implements AcceptanceCommandRunner {
  readonly calls: { command: string; args: readonly string[]; options: AcceptanceCommandOptions }[] = [];
  head = SHA;
  dirty = '';
  failUp = false;
  apiSha = SHA;
  config = configJson();

  async run(
    command: string,
    args: readonly string[],
    options: AcceptanceCommandOptions,
  ): Promise<AcceptanceCommandResult> {
    this.calls.push({ command, args, options });
    const joined = [command, ...args].join(' ');
    if (joined === 'git rev-parse HEAD') return { stdout: `${this.head}\n`, stderr: '' };
    if (joined === 'git status --porcelain --untracked-files=all') return { stdout: this.dirty, stderr: '' };
    if (joined.endsWith(' config --format json')) return { stdout: this.config, stderr: '' };
    if (joined.includes(' up --build --wait --detach')) {
      if (this.failUp) throw new Error('typesense failed its health check');
      return { stdout: 'started', stderr: '' };
    }
    if (joined.includes(' images --format json')) return { stdout: imageRows(), stderr: '' };
    if (joined.includes(' ps --format json')) return { stdout: healthRows(), stderr: '' };
    if (joined.includes('exec -T api node -e')) {
      return {
        stdout: JSON.stringify({ status: 'ok', service: 'sidestage-api', sha: this.apiSha }),
        stderr: '',
      };
    }
    if (joined.includes('exec -T worker node -e')) {
      return {
        stdout: JSON.stringify({ status: 'ok', service: 'sidestage-acceptance-worker', sha: SHA, runId: 'run-1' }),
        stderr: '',
      };
    }
    if (joined.includes(' down --volumes --remove-orphans --timeout 10')) {
      return { stdout: 'removed', stderr: '' };
    }
    throw new Error(`unexpected command: ${joined}`);
  }
}

function imageRows(): string {
  return ACCEPTANCE_SERVICES.map((service, index) => JSON.stringify({
    ContainerName: `${PROJECT_NAME}-${service}-1`,
    Repository: service === 'worker' ? 'sidestage-acceptance-api' : `sidestage-${service}`,
    Tag: ['api', 'web', 'worker'].includes(service) ? SHA : 'stable',
    ID: `sha256:${String(index + 1).repeat(64)}`,
    Size: '100MB',
  })).join('\n');
}

function healthRows(): string {
  return ACCEPTANCE_SERVICES.map((service) => JSON.stringify({
    Name: `${PROJECT_NAME}-${service}-1`,
    Service: service,
    State: 'running',
    Health: ['api', 'web', 'worker', 'postgres'].includes(service) ? 'healthy' : '',
  })).join('\n');
}

function configObject(): Record<string, unknown> {
  return {
    services: Object.fromEntries(ACCEPTANCE_SERVICES.map((service) => [service, {
      image: `sidestage-${service}:stable`,
      networks: { default: null },
    }])),
    networks: { default: { name: `${PROJECT_NAME}_default`, ipam: {} } },
    volumes: null,
  };
}

function configJson(): string {
  return JSON.stringify(configObject());
}

describe('acceptance environment evidence parsers', () => {
  it('accepts Docker Compose image rows that identify services by ContainerName', () => {
    const images = parseAcceptanceImages(imageRows());
    expect(images).toHaveLength(ACCEPTANCE_SERVICES.length);
    expect(images.find((image) => image.service === 'worker')).toMatchObject({
      repository: 'sidestage-acceptance-api',
      tag: SHA,
    });
  });

  it('requires one content-addressed image for every service', () => {
    expect(() => parseAcceptanceImages(JSON.stringify({
      ContainerName: `${PROJECT_NAME}-api-1`,
      Repository: 'sidestage-acceptance-api',
      Tag: SHA,
      ID: 'short-id',
    }))).toThrow(/content-addressed image digest/);
    expect(() => parseAcceptanceImages(`${imageRows()}\n${imageRows().split('\n')[0]}`)).toThrow(
      /returned 2 rows for postgres/,
    );
  });

  it('requires every service to be running and healthy when it declares a health check', () => {
    expect(parseAcceptanceHealth(healthRows())).toHaveLength(ACCEPTANCE_SERVICES.length);
    expect(() => parseAcceptanceHealth(healthRows().replace('"State":"running"', '"State":"exited"'))).toThrow(
      /not running/,
    );
  });
});

describe('acceptance Compose isolation', () => {
  it('accepts exactly the per-run service and network topology', () => {
    expect(() => validateAcceptanceComposeConfig(configJson(), PROJECT_NAME)).not.toThrow();
  });

  it('rejects published ports, external networks, named volumes, and production markers', () => {
    const withPort = configObject();
    (withPort.services as Record<string, Record<string, unknown>>).api.ports = [{ published: '3100' }];
    expect(() => validateAcceptanceComposeConfig(JSON.stringify(withPort), PROJECT_NAME)).toThrow(/publishes host ports/);

    const external = configObject();
    (external.networks as Record<string, Record<string, unknown>>).default.external = true;
    expect(() => validateAcceptanceComposeConfig(JSON.stringify(external), PROJECT_NAME)).toThrow(/external/);

    const namedVolume = configObject();
    namedVolume.volumes = { postgres: { name: 'sidestage-postgres' } };
    expect(() => validateAcceptanceComposeConfig(JSON.stringify(namedVolume), PROJECT_NAME)).toThrow(/named volumes/);

    const production = configObject();
    (production.services as Record<string, Record<string, unknown>>).api.environment = {
      URL: 'https://sidestage.buyrestart.com',
    };
    expect(() => validateAcceptanceComposeConfig(JSON.stringify(production), PROJECT_NAME)).toThrow(
      /forbidden production marker/,
    );
  });
});

describe('AcceptanceEnvironmentProvisioner', () => {
  it('boots a clean checkout at the exact requested SHA and records image plus health evidence', async () => {
    const runner = new FakeRunner();
    const provisioner = new AcceptanceEnvironmentProvisioner(runner);
    const environment = await provisioner.provision({
      runId: 'run-1',
      requestedSha: SHA,
      repositoryRoot: REPOSITORY_ROOT,
    });

    expect(environment).toMatchObject({
      projectName: PROJECT_NAME,
      requestedSha: SHA,
      deployedSha: SHA,
    });
    expect(environment.imageDigests).toHaveLength(7);
    expect(environment.healthChecks).toHaveLength(7);
    expect(runner.calls.find((call) => call.args.includes('up'))?.options.env).toMatchObject({
      COMPOSE_PROJECT_NAME: PROJECT_NAME,
      DOCKER_CONTEXT: 'default',
      SIDESTAGE_SHA: SHA,
      NODE_ENV: 'test',
    });
    expect(runner.calls.find((call) => call.args.includes('up'))?.options.env?.DOCKER_HOST).toBeUndefined();

    await environment.teardown();
    await environment.teardown();
    expect(runner.calls.filter((call) => call.args.includes('down'))).toHaveLength(1);
  });

  it('blocks a different or dirty checkout before Docker is touched', async () => {
    const wrongHead = new FakeRunner();
    wrongHead.head = OTHER_SHA;
    await expect(new AcceptanceEnvironmentProvisioner(wrongHead).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: REPOSITORY_ROOT,
    })).rejects.toMatchObject({ stage: 'same-sha', cleanupAttempted: false });
    expect(wrongHead.calls.every((call) => call.command === 'git')).toBe(true);

    const dirty = new FakeRunner();
    dirty.dirty = ' M apps/api/src/main.ts\n';
    await expect(new AcceptanceEnvironmentProvisioner(dirty).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: REPOSITORY_ROOT,
    })).rejects.toMatchObject({ stage: 'same-sha', cleanupAttempted: false });
    expect(dirty.calls.every((call) => call.command === 'git')).toBe(true);
  });

  it('rejects unsafe paths and identifiers before running commands', async () => {
    const runner = new FakeRunner();
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: '/opt/SideStage',
    })).rejects.toMatchObject({ stage: 'validate' });
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'RUN WITH SPACES', requestedSha: SHA, repositoryRoot: REPOSITORY_ROOT,
    })).rejects.toMatchObject({ stage: 'validate' });
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: 'relative/path',
    })).rejects.toMatchObject({ stage: 'validate' });
    expect(runner.calls).toHaveLength(0);
  });

  it('turns a dependency startup failure into blocked evidence only after teardown', async () => {
    const runner = new FakeRunner();
    runner.failUp = true;
    let error: unknown;
    try {
      await new AcceptanceEnvironmentProvisioner(runner).provision({
        runId: 'run-1', requestedSha: SHA, repositoryRoot: REPOSITORY_ROOT,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AcceptanceEnvironmentBlockedError);
    expect(error).toMatchObject({ stage: 'compose-up', cleanupAttempted: true });
    expect(runner.calls.some((call) => call.args.includes('down'))).toBe(true);
  });

  it('classifies invalid runtime evidence as a health failure and tears down', async () => {
    const runner = new FakeRunner();
    runner.apiSha = OTHER_SHA;
    await expect(new AcceptanceEnvironmentProvisioner(runner).provision({
      runId: 'run-1', requestedSha: SHA, repositoryRoot: REPOSITORY_ROOT,
    })).rejects.toMatchObject({ stage: 'health', cleanupAttempted: true });
    expect(runner.calls.some((call) => call.args.includes('down'))).toBe(true);
  });
});

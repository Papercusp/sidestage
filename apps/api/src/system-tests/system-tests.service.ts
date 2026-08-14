import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  parseSystemTestRunRequest,
  type SystemTestActor,
  type SystemTestRunRequest,
} from '@papercusp/system-test-contract';
import {
  SystemTestRunConflictError,
  type StoredSystemTestRunSnapshot,
  type SystemTestRunQueueStore,
} from '@papercusp/system-test-runner';

const TERMINAL_STATES = new Set([
  'passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed',
]);

export const SYSTEM_TEST_RUN_STORE = Symbol('SYSTEM_TEST_RUN_STORE');

@Injectable()
export class SystemTestsService {
  constructor(
    private readonly store: SystemTestRunQueueStore | null,
    private readonly createRunId: () => string = () => `run-${randomUUID()}`,
  ) {}

  catalog() {
    // The browser imports the same contract, but serving the catalog makes the
    // API authoritative for installed versions and prerequisites at launch time.
    return import('@papercusp/system-test-contract').then(({ SYSTEM_TEST_SUITE_MANIFESTS }) => ({
      suites: Object.values(SYSTEM_TEST_SUITE_MANIFESTS),
    }));
  }

  async launch(value: unknown, actor: SystemTestActor, idempotencyKey: string) {
    const request = parseSystemTestRunRequest(value);
    return this.requireStore().createRun({
      runId: this.createRunId(),
      idempotencyKey,
      request,
      actor,
    });
  }

  list(actor: SystemTestActor, limit = 25) {
    return this.requireStore().listRuns({ actor, limit });
  }

  async get(runId: string, actor: SystemTestActor): Promise<StoredSystemTestRunSnapshot> {
    const run = await this.requireStore().getRun(runId);
    if (!run || (actor.role !== 'release' && run.run.actor.id !== actor.id)) {
      throw new NotFoundException({ code: 'SYSTEM_TEST_RUN_NOT_FOUND', message: 'System-test run not found.' });
    }
    return run;
  }

  async cancel(runId: string, actor: SystemTestActor, reason: string) {
    const run = await this.get(runId, actor);
    if (TERMINAL_STATES.has(run.run.state)) {
      throw new ConflictException({
        code: 'SYSTEM_TEST_RUN_TERMINAL',
        message: `System-test run ${runId} is already ${run.run.state}.`,
      });
    }
    return this.requireStore().requestCancellation(runId, { requestedBy: actor, reason });
  }

  async retry(runId: string, actor: SystemTestActor, idempotencyKey: string) {
    const previous = await this.get(runId, actor);
    if (!TERMINAL_STATES.has(previous.run.state)) {
      throw new ConflictException({
        code: 'SYSTEM_TEST_RUN_NOT_TERMINAL',
        message: 'Only a terminal system-test run can be retried.',
      });
    }
    if (previous.cleanup.status === 'pending' || previous.cleanup.status === 'running') {
      throw new ConflictException({
        code: 'SYSTEM_TEST_CLEANUP_INCOMPLETE',
        message: 'Cleanup must finish before this system-test run can be retried.',
      });
    }
    const request: SystemTestRunRequest = parseSystemTestRunRequest({
      contractVersion: previous.run.contractVersion,
      suiteId: previous.run.suiteId,
      suiteVersion: previous.run.suiteVersion,
      profile: previous.run.profile,
      requestedSha: previous.run.requestedSha,
      ...(previous.run.eventId ? { eventId: previous.run.eventId } : {}),
    });
    try {
      return await this.requireStore().createRun({
        runId: this.createRunId(),
        idempotencyKey,
        request,
        actor,
      });
    } catch (error) {
      if (error instanceof SystemTestRunConflictError) throw error;
      throw error;
    }
  }

  private requireStore(): SystemTestRunQueueStore {
    if (!this.store) {
      throw new ServiceUnavailableException({
        code: 'SYSTEM_TEST_STORE_UNAVAILABLE',
        message: 'The durable system-test store is unavailable; no run was queued.',
      });
    }
    return this.store;
  }
}

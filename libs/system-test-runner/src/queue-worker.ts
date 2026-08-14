import {
  getSystemTestSuiteManifest,
  type SystemTestBudget,
  type SystemTestRunState,
  type SystemTestSuiteId,
  type SystemTestSuiteManifest,
} from '@papercusp/system-test-contract';

import {
  type StoredSystemTestRunSnapshot,
  type SystemTestRunQueueStore,
  type SystemTestRunReporter,
} from './postgres-run-store';

const TERMINAL_STATES = new Set<SystemTestRunState>([
  'passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed',
]);

export class SystemTestRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SystemTestRetryableError';
  }
}

export class SystemTestExecutionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemTestExecutionBudgetError';
  }
}

class SystemTestCancelledError extends Error {}
class SystemTestTimedOutError extends Error {}

/**
 * Mutable budget meter handed only to trusted, server-owned executors. The
 * caller cannot raise these limits: they come from the versioned suite
 * manifest captured with the run.
 */
export class SystemTestExecutionBudget {
  readonly limits: Readonly<SystemTestBudget>;
  readonly #cpuStart = process.cpuUsage();
  #artifactBytes = 0;

  constructor(limits: SystemTestBudget) {
    this.limits = Object.freeze({ ...limits });
  }

  chargeArtifact(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new SystemTestExecutionBudgetError('artifact bytes must be a non-negative safe integer');
    }
    this.#artifactBytes += bytes;
    if (this.#artifactBytes > this.limits.maxArtifactBytes) {
      throw new SystemTestExecutionBudgetError('suite exceeded its artifact-byte budget');
    }
  }

  assertProcessLimits(): void {
    const cpu = process.cpuUsage(this.#cpuStart);
    const cpuMillis = (cpu.user + cpu.system) / 1_000;
    if (cpuMillis > this.limits.maxCpuMillis) {
      throw new SystemTestExecutionBudgetError('suite exceeded its CPU-time budget');
    }
    const rssMiB = process.memoryUsage().rss / 1024 / 1024;
    if (rssMiB > this.limits.maxMemoryMiB) {
      throw new SystemTestExecutionBudgetError('suite exceeded its resident-memory budget');
    }
  }
}

export interface SystemTestSuiteExecutionContext {
  run: StoredSystemTestRunSnapshot;
  manifest: SystemTestSuiteManifest;
  reporter: SystemTestRunReporter;
  signal: AbortSignal;
  attempt: number;
  budget: SystemTestExecutionBudget;
}

export type SystemTestSuiteExecutor = (context: SystemTestSuiteExecutionContext) => Promise<void>;
export type SystemTestSuiteExecutorRegistry = Partial<Record<SystemTestSuiteId, SystemTestSuiteExecutor>>;

export interface SystemTestQueueWorkerOptions {
  maxConcurrentRuns?: number;
  maxAttempts?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SystemTestQueueWorker {
  readonly #store: SystemTestRunQueueStore;
  readonly #executors: SystemTestSuiteExecutorRegistry;
  readonly #maxConcurrentRuns: number;
  readonly #maxAttempts: number;
  readonly #heartbeatIntervalMs: number;
  readonly #now: () => Date;

  constructor(
    store: SystemTestRunQueueStore,
    executors: SystemTestSuiteExecutorRegistry,
    options: SystemTestQueueWorkerOptions = {},
  ) {
    this.#store = store;
    this.#executors = Object.freeze({ ...executors });
    this.#maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
    this.#maxAttempts = options.maxAttempts ?? 2;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.#maxConcurrentRuns) || this.#maxConcurrentRuns < 1 || this.#maxConcurrentRuns > 16) {
      throw new RangeError('maxConcurrentRuns must be an integer between 1 and 16');
    }
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 3) {
      throw new RangeError('maxAttempts must be an integer between 1 and 3');
    }
    if (!Number.isInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 5) {
      throw new RangeError('heartbeatIntervalMs must be at least 5');
    }
  }

  /** Claim and execute at most one run. Null means the queue/cap had no slot. */
  async runNext(): Promise<StoredSystemTestRunSnapshot | null> {
    const claimed = await this.#store.claimNextRun({
      maxConcurrentRuns: this.#maxConcurrentRuns,
      now: this.#now(),
    });
    if (!claimed) return null;
    if (claimed.cancellation && !claimed.cancellation.acknowledgedAt) {
      return this.#store.acknowledgeCancellation(claimed.run.id, this.#now());
    }

    const suiteId = claimed.run.suiteId as SystemTestSuiteId;
    const manifest = getSystemTestSuiteManifest(suiteId);
    if (claimed.run.suiteVersion !== manifest.suiteVersion || claimed.run.contractVersion !== manifest.contractVersion) {
      return this.#store.advanceRun(claimed.run.id, 'blocked', {
        reason: 'The requested suite version is not installed in this worker.',
        at: this.#now(),
      });
    }
    const executor = this.#executors[suiteId];
    if (!executor) {
      return this.#store.advanceRun(claimed.run.id, 'blocked', {
        reason: `No trusted executor is installed for allow-listed suite ${suiteId}.`,
        at: this.#now(),
      });
    }

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const budget = new SystemTestExecutionBudget(manifest.budget);
      try {
        await this.#runAttempt(executor, {
          run: claimed,
          manifest,
          reporter: this.#store,
          signal: controller.signal,
          attempt,
          budget,
        }, controller);
        const current = await this.#store.getRun(claimed.run.id);
        if (!current) throw new Error(`system-test run ${claimed.run.id} disappeared during execution`);
        if (current.cancellation && !current.cancellation.acknowledgedAt) {
          return this.#store.acknowledgeCancellation(claimed.run.id, this.#now());
        }
        if (!TERMINAL_STATES.has(current.run.state)) {
          return this.#store.advanceRun(claimed.run.id, 'failed', {
            reason: 'Trusted executor returned without recording a terminal outcome.',
            at: this.#now(),
          });
        }
        return current;
      } catch (error) {
        controller.abort(error);
        if (error instanceof SystemTestCancelledError) {
          return this.#store.acknowledgeCancellation(claimed.run.id, this.#now());
        }
        if (error instanceof SystemTestTimedOutError) {
          return this.#store.advanceRun(claimed.run.id, 'timed-out', {
            reason: `Suite exceeded its ${manifest.budget.timeoutMs}ms wall-clock budget.`,
            at: this.#now(),
          });
        }
        if (error instanceof SystemTestRetryableError && attempt < this.#maxAttempts) {
          await this.#store.heartbeat(claimed.run.id, this.#now());
          continue;
        }
        return this.#store.advanceRun(claimed.run.id, 'failed', {
          reason: `Trusted executor failed on attempt ${attempt}/${this.#maxAttempts}: ${message(error)}`,
          at: this.#now(),
        });
      }
    }
    throw new Error('unreachable system-test retry state');
  }

  async #runAttempt(
    executor: SystemTestSuiteExecutor,
    context: SystemTestSuiteExecutionContext,
    controller: AbortController,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(heartbeat);
        error === undefined ? resolve() : reject(error);
      };
      const timeout = setTimeout(() => {
        const error = new SystemTestTimedOutError('system-test wall-clock budget exceeded');
        controller.abort(error);
        finish(error);
      }, context.manifest.budget.timeoutMs);
      const heartbeat = setInterval(() => {
        void (async () => {
          try {
            context.budget.assertProcessLimits();
            await this.#store.heartbeat(context.run.run.id, this.#now());
            const current = await this.#store.getRun(context.run.run.id);
            if (current?.cancellation && !current.cancellation.acknowledgedAt) {
              const error = new SystemTestCancelledError('system-test cancellation requested');
              controller.abort(error);
              finish(error);
            }
          } catch (error) {
            controller.abort(error);
            finish(error);
          }
        })();
      }, this.#heartbeatIntervalMs);

      void executor(context).then(
        () => {
          try {
            context.budget.assertProcessLimits();
            finish();
          } catch (error) {
            finish(error);
          }
        },
        (error) => finish(error),
      );
    });
  }
}

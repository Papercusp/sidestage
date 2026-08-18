// SPDX-License-Identifier: MIT
/**
 * Production-like real-provider latency benchmark for the grounded copilot.
 *
 * WHY THIS IS A SCRIPT AND NOT A SUITE: every sample is a real, paid provider
 * call. No vitest project matches apps/api/scripts/**, so this cannot be swept
 * into CI by accident. The logic worth asserting lives in
 * src/copilot/benchmark.ts and is unit-tested there without credentials.
 *
 * RUN:
 *   cd apps/api && npm run benchmark:copilot-latency
 *   # options: --samples=5 --out=<path> --budget-ms=2000
 *
 * REQUIRES: GOOGLE_CLOUD_PROJECT (createVertexAdapter returns undefined
 * without it). The script FAILS LOUDLY rather than quietly benchmarking the
 * deterministic engine, because a fast number from the wrong engine is worse
 * than no number at all.
 */
import { hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  buildReport,
  DEFAULT_COMPLETE_P95_BUDGET_MS,
  summarizeScenario,
  type BenchmarkScenarioName,
  type ScenarioResult,
} from '../src/copilot/benchmark';
import { ConfiguredCopilotReplyModel } from '../src/copilot/copilot.model';
import { GroundedCopilotPipeline } from '../src/copilot/copilot.pipeline';
import { VertexCopilotReplyModel } from '../src/copilot/copilot-vertex.model';
import { CopilotLatencyBudget, createFileLatencyPersistence } from '../src/copilot/latency';
import { ParallelResearchFallback, type CatalogResearchSource, type WebResearchSource } from '../src/copilot/research';
import { UnconfiguredWebResearchSource } from '../src/copilot/research.providers';
import { createVertexAdapter, DEFAULT_VERTEX_MODEL } from '../src/llm/vertex-adapter';
import type { CopilotPolicy, GroundingContext } from '../src/copilot/copilot.types';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SAMPLES = Math.max(1, Number.parseInt(arg('samples', '3'), 10) || 3);
const BUDGET_MS = Number.parseInt(arg('budget-ms', String(DEFAULT_COMPLETE_P95_BUDGET_MS)), 10)
  || DEFAULT_COMPLETE_P95_BUDGET_MS;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(arg('out', `${process.env.HOME}/.papercusp/artifacts/sidestage/copilot-latency-benchmark-${STAMP}.json`));

const policy: CopilotPolicy = {
  automationLevel: 'suggest',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'p-1': 1000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const context: GroundingContext = {
  eventItems: [{
    eventItemId: 'ei-1',
    productId: 'p-1',
    title: 'Blue ceramic mug',
    priceCents: 1500,
    availableQty: 4,
    attributes: { color: 'blue', material: 'ceramic' },
  }],
  catalogProducts: [{
    productId: 'p-1',
    title: 'Blue ceramic mug',
    priceCents: 1800,
    attributes: { material: 'ceramic', dishwasherSafe: 'yes' },
  }],
  policy,
  sources: [
    { id: 'event-item:ei-1', kind: 'event-item', label: 'Blue mug event item' },
    { id: 'catalog-product:p-1', kind: 'catalog-product', label: 'Blue mug catalog record' },
    { id: 'policy:event-1', kind: 'policy', label: 'Seller event policy' },
  ],
};

/** Only knows the properties the fixture catalog actually carries. */
const catalogSource: CatalogResearchSource = {
  supportsProperties: (required) => required.every((p) => ['material', 'dishwasherSafe'].includes(p)),
  search: async () => ({ products: context.catalogProducts }),
};

/** Never resolves in time — used to force the deadline path deterministically. */
const stallingWeb: WebResearchSource = {
  search: () => new Promise(() => {}),
};

function currentCommit(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function makePipeline(budget: CopilotLatencyBudget, researchFallback?: ParallelResearchFallback) {
  const adapter = createVertexAdapter();
  if (!adapter) {
    throw new Error(
      'GOOGLE_CLOUD_PROJECT is not set — createVertexAdapter returned undefined. '
      + 'Refusing to run: a benchmark of the deterministic engine is not a real-provider benchmark.',
    );
  }
  return new GroundedCopilotPipeline({
    retriever: { retrieve: async () => context },
    model: new VertexCopilotReplyModel(adapter, new ConfiguredCopilotReplyModel()),
    latencyBudget: budget,
    ...(researchFallback ? { researchFallback } : {}),
  });
}

interface ScenarioSpec {
  name: BenchmarkScenarioName;
  requiredProperties?: readonly string[];
  message: string;
  researchFallback?: () => ParallelResearchFallback;
  concurrent?: boolean;
  notes: string;
}

const SPECS: ScenarioSpec[] = [
  {
    name: 'catalog-only',
    message: 'Is the blue mug still in stock?',
    notes: 'Straight grounded turn: retrieval + model, no research fallback engaged.',
  },
  {
    name: 'fallback',
    message: 'Is this mug oven safe?',
    requiredProperties: ['ovenSafe'],
    researchFallback: () => new ParallelResearchFallback(catalogSource, new UnconfiguredWebResearchSource()),
    notes:
      'requiredProperties the fixture catalog cannot satisfy, so the web leg engages. '
      + 'UnconfiguredWebResearchSource rejects by design in this codebase, so a DEGRADED/incomplete '
      + 'result here is the documented true behaviour, not a defect to fix.',
  },
  {
    name: 'timeout',
    message: 'Is this mug oven safe?',
    requiredProperties: ['ovenSafe'],
    researchFallback: () => new ParallelResearchFallback(catalogSource, stallingWeb, { deadlineMs: 1 }),
    notes: 'A 1ms research deadline against a never-resolving web source forces deadline-exceeded.',
  },
  {
    name: 'concurrent',
    message: 'Is the blue mug still in stock?',
    concurrent: true,
    notes: 'N turns issued in parallel against one pipeline instance, to expose contention.',
  },
];

async function runScenario(spec: ScenarioSpec): Promise<ScenarioResult> {
  const budget = new CopilotLatencyBudget(
    2_000,
    createFileLatencyPersistence(`${dirname(OUT)}/samples/${spec.name}-${STAMP}.jsonl`),
  );
  const pipeline = makePipeline(budget, spec.researchFallback?.());
  const degradedReasons: string[] = [];
  let answered = 0;

  const once = async (index: number) => {
    const response = await pipeline.respond({
      eventId: 'event-1',
      message: spec.message,
      ...(spec.requiredProperties ? { requiredProperties: spec.requiredProperties } : {}),
    });
    answered += 1;
    for (const entry of response.researchIncomplete?.degraded ?? []) degradedReasons.push(entry.reason);
    process.stdout.write(
      `  ${spec.name}[${index + 1}/${SAMPLES}] ${response.latency.completeMs}ms `
      + `grounding=${response.grounding} provider=${response.latency.provider}\n`,
    );
  };

  try {
    if (spec.concurrent) {
      await Promise.all(Array.from({ length: SAMPLES }, (_, i) => once(i)));
    } else {
      for (let i = 0; i < SAMPLES; i += 1) await once(i);
    }
  } catch (error) {
    // A THROW is the unsafe outcome the acceptance clause cares about, so it is
    // recorded rather than swallowed — allTurnsAnswered goes false below.
    process.stdout.write(`  ${spec.name} THREW: ${(error as Error).message}\n`);
  }

  return summarizeScenario(spec.name, budget, {
    allTurnsAnswered: answered === SAMPLES,
    degradedReasons,
    notes: spec.notes,
  });
}

async function main() {
  // The timeout scenario awaits a race between a never-resolving promise (no
  // handle) and settle()'s UNREF'D deadline timer; between provider calls the
  // event loop can hold zero ref'd handles, and node then exits 0 mid-run with
  // no error and no report. Hold one ref'd handle so the loop cannot drain.
  const keepalive = setInterval(() => {}, 60_000);
  try {
  process.stdout.write(`copilot latency benchmark — ${SAMPLES} real samples/scenario, budget ${BUDGET_MS}ms\n`);
  const scenarios: ScenarioResult[] = [];
  for (const spec of SPECS) {
    process.stdout.write(`\n[${spec.name}]\n`);
    scenarios.push(await runScenario(spec));
  }

  const report = buildReport(scenarios, {
    provider: 'vertex',
    model: process.env.SIDESTAGE_COPILOT_VERTEX_MODEL?.trim() || DEFAULT_VERTEX_MODEL,
    host: hostname(),
    samplesPerScenario: SAMPLES,
    ...(currentCommit() ? { commit: currentCommit() } : {}),
  }, { budgetMs: BUDGET_MS });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(`\n=== ACCEPTANCE ===\n${report.acceptance.verdict}\ngate=${report.acceptance.gate}\n`);
  process.stdout.write(`${report.acceptance.reason}\n\nartifact: ${OUT}\n`);
  // A red gate is a legitimate documented outcome of this benchmark, so only a
  // genuinely unsafe run exits non-zero.
  process.exitCode = report.acceptance.verdict === 'reject-unsafe-over-budget' ? 1 : 0;
  } finally {
    clearInterval(keepalive);
  }
}

void main();

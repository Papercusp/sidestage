import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { JUDGE_STORE, type JudgeStore } from './judge.store';
import { PolicyReplyGuard } from '../copilot/guardrail';
import type { CopilotPolicy } from '../copilot/copilot.types';
import {
  JUDGE_DIMENSIONS,
  JUDGE_MODEL,
  type JudgeCase,
  type JudgeCaseResult,
  type JudgeDimension,
  type JudgeDimensionScore,
  type JudgeModelResult,
  type JudgeReport,
  type JudgeRunRequest,
  type ReplyJudgeModel,
} from './judge.types';

const DEFAULT_PASS_THRESHOLD = 0.75;
const MAX_CASES = 20;

/**
 * Ownership stamped on a run when the caller supplies no principal.
 *
 * judge_run.actor_id is NOT NULL and rejects blanks, so the column always
 * answers "who ran this" — an explicit shared operator identity is honest
 * about an unattributed run, where an empty string would just look like data
 * corruption to whoever reads the table later.
 */
export const DEFAULT_JUDGE_ACTOR = 'operator';

function boundedScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function sentenceCount(reply: string): number {
  return reply.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}

function claimedPrices(reply: string): number[] {
  const matches = reply.match(/\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?/g) ?? [];
  return matches.map((match) => {
    const dollars = Number(match.replace(/[$,\s]/g, ''));
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : NaN;
  }).filter((value) => Number.isSafeInteger(value));
}

function scoreGrounding(testCase: JudgeCase): JudgeDimensionScore {
  const known = new Set(testCase.context.sources.map((source) => source.id));
  const citations = [...new Set(testCase.citations)];
  const valid = citations.filter((citation) => known.has(citation));
  if (valid.length === 0) {
    return { score: 0, rationale: 'The reply has no citation that belongs to the verified event context.' };
  }
  if (valid.length !== citations.length) {
    return {
      score: valid.length / Math.max(1, citations.length),
      rationale: `${valid.length} of ${citations.length} cited source(s) are verified; remove unsupported citations.`,
    };
  }
  return { score: 1, rationale: 'Every cited source is present in the retrieved event context.' };
}

function scorePriceCorrectness(testCase: JudgeCase): JudgeDimensionScore {
  const prices = claimedPrices(testCase.reply);
  if (prices.length === 0) {
    return { score: 1, rationale: 'The reply makes no price claim to verify.' };
  }

  const knownPrices = new Set<number>([
    ...testCase.context.eventItems.map((item) => item.priceCents),
    ...testCase.context.catalogProducts.map((product) => product.priceCents),
    ...Object.values(testCase.context.policy.priceFloorCentsByProduct),
  ]);
  const expected = testCase.expectedPriceCents;
  const matches = prices.filter((price) => expected !== undefined ? price === expected : knownPrices.has(price));
  if (matches.length === prices.length) {
    return { score: 1, rationale: 'Every price claim matches the expected or verified catalog price.' };
  }
  return {
    score: 0,
    rationale: expected !== undefined
      ? `The reply claims ${prices.join(', ')} cents; the expected event price is ${expected} cents.`
      : 'At least one price claim is absent from the verified catalog and event context.',
  };
}

function scoreTone(testCase: JudgeCase): JudgeDimensionScore {
  const reply = testCase.reply.trim();
  const target = testCase.context.policy.tone;
  if (testCase.declaredTone && testCase.declaredTone !== target) {
    return { score: 0, rationale: `The provider declared ${testCase.declaredTone}, but the event requires ${target}.` };
  }

  if (!reply) return { score: 0, rationale: 'The reply is empty.' };
  if (target === 'concise') {
    return sentenceCount(reply) <= 2 && reply.length <= 240
      ? { score: 1, rationale: 'The reply stays short enough for the concise event tone.' }
      : { score: 0.5, rationale: 'The reply is longer than the concise event tone allows.' };
  }
  if (target === 'playful') {
    return /[!]|[\p{Extended_Pictographic}]|\b(great|nice|fun|pick|ready)\b/iu.test(reply)
      ? { score: 1, rationale: 'The reply uses light, upbeat energy for the playful event tone.' }
      : { score: 0.5, rationale: 'The reply is restrained; add light energy for the playful event tone.' };
  }
  if (target === 'professional') {
    return !(/[\p{Extended_Pictographic}]|!!/u.test(reply))
      ? { score: 1, rationale: 'The reply uses a restrained professional presentation.' }
      : { score: 0.5, rationale: 'The reply contains expressive marks that do not fit the professional tone.' };
  }
  return /\b(you|happy|glad|welcome|thanks|thank)\b/i.test(reply)
    ? { score: 1, rationale: 'The reply uses a direct, welcoming cue for the warm event tone.' }
    : { score: 0.75, rationale: 'The reply is neutral; add a welcoming cue for a warmer experience.' };
}

async function scorePolicy(testCase: JudgeCase): Promise<JudgeDimensionScore> {
  const decision = await new PolicyReplyGuard().evaluate(
    { reply: testCase.reply, declaredTone: testCase.declaredTone },
    testCase.context,
  );
  return decision.allowed
    ? { score: 1, rationale: 'The reply satisfies the non-empty and declared-tone policy gate.' }
    : { score: 0, rationale: decision.explanation ?? 'The reply was rejected by the event policy gate.' };
}

/**
 * Deterministic fallback for the provider seam used by the contest rehearsal.
 * A hosted LLM judge can implement ReplyJudgeModel later without changing the
 * report shape or the Test-tab contract.
 */
@Injectable()
export class DeterministicReplyJudgeModel implements ReplyJudgeModel {
  async grade({ testCase }: { testCase: JudgeCase }): Promise<JudgeModelResult> {
    return {
      dimensions: {
        grounding: scoreGrounding(testCase),
        policy: await scorePolicy(testCase),
        'price-correctness': scorePriceCorrectness(testCase),
        tone: scoreTone(testCase),
      },
    };
  }
}

function thresholdFor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PASS_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function emptyDimension(dimension: JudgeDimension): JudgeDimensionScore {
  return { score: 0, rationale: `The judge did not return a ${dimension} score.` };
}

/**
 * Stable identity for a judge submission.
 *
 * Two requests grading the same cases at the same threshold are the SAME run,
 * so a retry must resolve to the stored run instead of grading again. The key
 * covers everything that can change a verdict — threshold plus each case's
 * graded inputs — and deliberately excludes wall-clock time, which would make
 * every replay look unique and defeat the idempotency it is meant to provide.
 */
export function judgeIdempotencyKey(input: JudgeRunRequest, actorId: string): string {
  const cases = (Array.isArray(input?.cases) ? input.cases : []).map((testCase) => ({
    id: testCase.id,
    question: testCase.question,
    reply: testCase.reply,
    citations: [...testCase.citations],
    declaredTone: testCase.declaredTone ?? null,
    expectedPriceCents: testCase.expectedPriceCents ?? null,
  }));
  const canonical = JSON.stringify({
    actorId,
    passThreshold: thresholdFor(input?.passThreshold),
    cases,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

@Injectable()
export class AutoResponderJudgeService {
  constructor(
    @Inject(JUDGE_MODEL) private readonly model: ReplyJudgeModel,
    @Inject(JUDGE_STORE) private readonly store: JudgeStore,
  ) {}

  /**
   * Postgres is the sole authority. This used to read a process field, so the
   * newest report died with the process and two replicas disagreed about which
   * run was "latest" (WS cutover P-001c).
   */
  latest(): Promise<JudgeReport | null> {
    return this.store.latest();
  }

  async run(input: JudgeRunRequest, actorId = DEFAULT_JUDGE_ACTOR): Promise<JudgeReport> {
    const cases = Array.isArray(input?.cases) ? input.cases : [];
    if (cases.length === 0) throw new Error('at least one judge case is required');
    if (cases.length > MAX_CASES) throw new Error(`at most ${MAX_CASES} judge cases may run at once`);

    // Resolve the idempotency key BEFORE grading: a replayed submission must
    // not pay for a second model call, which for the Vertex judge is a real
    // billed request, not just wasted latency.
    const idempotencyKey = judgeIdempotencyKey(input, actorId);

    const passThreshold = thresholdFor(input.passThreshold);
    const started = Date.now();
    const results = await Promise.all(cases.map(async (testCase): Promise<JudgeCaseResult> => {
      const modelResult = await this.model.grade({ testCase });
      const dimensions = Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
        const raw = modelResult.dimensions[dimension] ?? emptyDimension(dimension);
        const score = boundedScore(raw.score);
        return [dimension, {
          dimension,
          score,
          rationale: raw.rationale?.trim() || 'No rationale was returned.',
          passed: score >= passThreshold,
        }];
      })) as Record<JudgeDimension, JudgeCaseResult['dimensions'][JudgeDimension]>;
      const overallScore = JUDGE_DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension].score, 0) / JUDGE_DIMENSIONS.length;
      return {
        caseId: testCase.id,
        question: testCase.question,
        reply: testCase.reply,
        overallScore,
        passed: overallScore >= passThreshold && JUDGE_DIMENSIONS.every((dimension) => dimensions[dimension].passed),
        dimensions,
      };
    }));

    const dimensions = Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
      const score = results.reduce((sum, result) => sum + result.dimensions[dimension].score, 0) / results.length;
      return [dimension, { score, passed: score >= passThreshold }];
    })) as JudgeReport['dimensions'];
    const passedCases = results.filter((result) => result.passed).length;
    const overallScore = results.reduce((sum, result) => sum + result.overallScore, 0) / results.length;

    const report: JudgeReport = {
      runId: randomUUID(),
      totalCases: results.length,
      passedCases,
      overallScore,
      passed: passedCases === results.length,
      passThreshold,
      dimensions,
      cases: results,
      latencyMs: Math.max(0, Date.now() - started),
    };
    // Postgres decides what the canonical run is. On a replay the store
    // returns the run already recorded under this key, so the caller sees the
    // ORIGINAL verdict rather than this freshly graded duplicate — the report
    // above is discarded in that case, by design.
    return this.store.save(report, { idempotencyKey, actorId });
  }
}

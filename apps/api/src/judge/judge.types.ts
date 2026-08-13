import type { CopilotPolicy, GroundingContext } from '../copilot/copilot.types';

export const JUDGE_DIMENSIONS = [
  'grounding',
  'policy',
  'price-correctness',
  'tone',
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

export interface JudgeCase {
  id: string;
  question: string;
  reply: string;
  citations: readonly string[];
  context: GroundingContext;
  /** Optional provider assertion used by the tone and policy dimensions. */
  declaredTone?: CopilotPolicy['tone'];
  /** When supplied, price claims must match this expected event price exactly. */
  expectedPriceCents?: number;
}

export interface JudgeDimensionScore {
  score: number;
  rationale: string;
}

export interface JudgeModelResult {
  dimensions: Partial<Record<JudgeDimension, JudgeDimensionScore>>;
}

export interface ReplyJudgeModel {
  grade(request: { testCase: JudgeCase }): Promise<JudgeModelResult>;
}

export interface JudgeDimensionResult extends JudgeDimensionScore {
  dimension: JudgeDimension;
  passed: boolean;
}

export interface JudgeCaseResult {
  caseId: string;
  question: string;
  reply: string;
  overallScore: number;
  passed: boolean;
  dimensions: Record<JudgeDimension, JudgeDimensionResult>;
}

export interface JudgeAggregateDimension {
  score: number;
  passed: boolean;
}

export interface JudgeRunRequest {
  cases: readonly JudgeCase[];
  /** Minimum score required for every dimension and the overall case. */
  passThreshold?: number;
}

export interface JudgeReport {
  runId: string;
  totalCases: number;
  passedCases: number;
  overallScore: number;
  passed: boolean;
  passThreshold: number;
  dimensions: Record<JudgeDimension, JudgeAggregateDimension>;
  cases: readonly JudgeCaseResult[];
  latencyMs: number;
}

export const JUDGE_MODEL = Symbol('JUDGE_MODEL');

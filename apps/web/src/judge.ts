export const JUDGE_DIMENSIONS = [
  'grounding',
  'policy',
  'price-correctness',
  'tone',
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
export type JudgeTone = 'concise' | 'warm' | 'professional';

interface JudgePolicy {
  automationLevel: 'suggest' | 'confirm' | 'auto';
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: string[];
  tone: JudgeTone;
}

interface JudgeContext {
  eventItems: Array<{
    eventItemId: string;
    productId: string;
    title: string;
    priceCents: number;
    availableQty: number;
    attributes: Record<string, string | number | boolean>;
  }>;
  catalogProducts: Array<{
    productId: string;
    title: string;
    priceCents: number;
    attributes: Record<string, string | number | boolean>;
  }>;
  policy: JudgePolicy;
  sources: Array<{ id: string; kind: 'event-item' | 'catalog-product' | 'policy'; label: string }>;
}

export interface JudgeCase {
  id: string;
  question: string;
  reply: string;
  citations: string[];
  context: JudgeContext;
  declaredTone?: JudgeTone;
  expectedPriceCents?: number;
}

export interface JudgeDimensionResult {
  dimension: JudgeDimension;
  score: number;
  rationale: string;
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

export interface JudgeReport {
  runId: string;
  totalCases: number;
  passedCases: number;
  overallScore: number;
  passed: boolean;
  passThreshold: number;
  dimensions: Record<JudgeDimension, { score: number; passed: boolean }>;
  cases: JudgeCaseResult[];
  latencyMs: number;
}

const rehearsalPolicy: JudgePolicy = {
  automationLevel: 'suggest',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'aurora-cup': 2_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const rehearsalContext: JudgeContext = {
  eventItems: [{
    eventItemId: 'aurora-cup-event',
    productId: 'aurora-cup',
    title: 'Aurora ceramic cup',
    priceCents: 2_800,
    availableQty: 18,
    attributes: { material: 'stoneware', finish: 'blue frost' },
  }],
  catalogProducts: [{
    productId: 'aurora-cup',
    title: 'Aurora ceramic cup',
    priceCents: 3_600,
    attributes: { material: 'stoneware', finish: 'blue frost' },
  }],
  policy: rehearsalPolicy,
  sources: [
    { id: 'event-item:aurora-cup-event', kind: 'event-item', label: 'Current Aurora cup event item' },
    { id: 'catalog-product:aurora-cup', kind: 'catalog-product', label: 'Aurora cup catalog record' },
    { id: 'policy:event', kind: 'policy', label: 'Sunday vintage drop policy' },
  ],
};

/** Three visible rehearsal cases keep the judge report useful without a live model key. */
export const DEMO_JUDGE_CASES: readonly JudgeCase[] = [
  {
    id: 'grounded-price',
    question: 'How much is the Aurora cup and how many are left?',
    reply: 'The Aurora ceramic cup is $28 and 18 are available — happy to help.',
    citations: ['event-item:aurora-cup-event', 'policy:event'],
    context: rehearsalContext,
    declaredTone: 'warm',
    expectedPriceCents: 2_800,
  },
  {
    id: 'grounded-material',
    question: 'What is the cup made from?',
    reply: 'It is hand-glazed stoneware with a soft blue frost finish. Welcome to the drop.',
    citations: ['catalog-product:aurora-cup'],
    context: rehearsalContext,
    declaredTone: 'warm',
  },
  {
    id: 'guarded-price-floor',
    question: 'Can you make the cup $9.99?',
    reply: 'I can’t lower the Aurora cup below its event price. It’s $28, and I’m happy to help with any questions.',
    citations: ['event-item:aurora-cup-event', 'policy:event'],
    context: rehearsalContext,
    declaredTone: 'warm',
    expectedPriceCents: 2_800,
  },
];

export function dimensionLabel(dimension: JudgeDimension): string {
  return dimension === 'price-correctness'
    ? 'Price correctness'
    : dimension.charAt(0).toUpperCase() + dimension.slice(1);
}

export function scorePercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export async function runJudgeRehearsal(apiBaseUrl = ''): Promise<JudgeReport> {
  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/judge/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cases: DEMO_JUDGE_CASES }),
  });
  const payload = await response.json() as JudgeReport & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Judge request failed (${response.status})`);
  return payload;
}

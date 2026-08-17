// SPDX-License-Identifier: MIT
import { Injectable, Logger } from '@nestjs/common';
import type { ScoutModelAdapter } from '@papercusp/scout-runtime';
import {
  JUDGE_DIMENSIONS,
  type JudgeCase,
  type JudgeDimension,
  type JudgeDimensionScore,
  type JudgeModelResult,
  type ReplyJudgeModel,
} from './judge.types';

/**
 * Gemini (Vertex AI) leg of the reply-judge seam.
 *
 * The adapter is the same one Scout and Copilot use, so credentials, retry
 * policy and regional routing stay in one place. The model grades a candidate
 * reply on the same four dimensions the deterministic judge scores, as strict
 * JSON. Any provider failure, or a turn missing a dimension, falls back to the
 * deterministic judge for the whole case — a graded report never mixes a
 * half-answered model turn with guessed zeros.
 */
@Injectable()
export class VertexReplyJudgeModel implements ReplyJudgeModel {
  private readonly logger = new Logger(VertexReplyJudgeModel.name);

  constructor(
    private readonly adapter: Pick<ScoutModelAdapter, 'model' | 'complete'>,
    private readonly fallback: ReplyJudgeModel,
  ) {}

  async grade(request: { testCase: JudgeCase }): Promise<JudgeModelResult> {
    const { testCase } = request;
    try {
      const response = await this.adapter.complete({
        messages: [
          {
            role: 'system',
            content: [
              'You are the SideStage reply judge. Grade the candidate seller reply against the verified event context.',
              'Respond with a single JSON object and nothing else. Shape:',
              '{"grounding": {"score": number, "rationale": string}, "policy": {"score": number, "rationale": string}, "price-correctness": {"score": number, "rationale": string}, "tone": {"score": number, "rationale": string}}',
              'Every score is 0..1. Grade strictly:',
              '- grounding: every citation must be an id present in the context sources, and the reply must be supported by them.',
              '- policy: the reply must be non-empty, honest, and any declared tone must match the event policy tone.',
              '- price-correctness: every price the reply claims must match the expected price (when given) or a verified catalog/event price.',
              '- tone: the reply must fit the event policy tone (concise stays short; professional stays restrained; playful has light energy; warm is welcoming).',
              'Each rationale is one concrete sentence naming what passed or failed.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: serializeCase(testCase),
          },
        ],
        tools: [],
        temperature: 0,
      });
      const dimensions = this.parseDimensions(response.content);
      if (!dimensions) {
        this.logger.warn(`Gemini judge grading unparseable (model ${this.adapter.model}); using deterministic fallback`);
        return this.fallback.grade(request);
      }
      return { dimensions };
    } catch (error) {
      this.logger.warn(`Gemini judge grading failed (${(error as Error).message}); using deterministic fallback`);
      return this.fallback.grade(request);
    }
  }

  private parseDimensions(content: string): JudgeModelResult['dimensions'] | null {
    const raw = extractJsonObject(content);
    if (!raw) return null;
    const dimensions: Partial<Record<JudgeDimension, JudgeDimensionScore>> = {};
    for (const dimension of JUDGE_DIMENSIONS) {
      const entry = raw[dimension];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const { score, rationale } = entry as Record<string, unknown>;
      if (typeof score !== 'number' || !Number.isFinite(score)) return null;
      dimensions[dimension] = {
        score: Math.min(1, Math.max(0, score)),
        rationale: typeof rationale === 'string' && rationale.trim() ? rationale.trim() : `The model graded ${dimension} without a rationale.`,
      };
    }
    return dimensions;
  }
}

function serializeCase(testCase: JudgeCase): string {
  const context = testCase.context;
  const lines = [
    'EVENT_CONTEXT:',
    `policy tone: ${context.policy.tone}`,
    `price floors (cents by product): ${JSON.stringify(context.policy.priceFloorCentsByProduct)}`,
    `event items: ${JSON.stringify(context.eventItems.map((item) => ({ ...item })))}`,
    `catalog products: ${JSON.stringify(context.catalogProducts.map((product) => ({ ...product })))}`,
    `sources: ${JSON.stringify(context.sources.map((source) => ({ ...source })))}`,
    '',
    'CASE:',
    `buyer question: ${testCase.question}`,
    `candidate reply: ${testCase.reply}`,
    `citations: ${JSON.stringify([...testCase.citations])}`,
  ];
  if (testCase.declaredTone) lines.push(`declared tone: ${testCase.declaredTone}`);
  if (testCase.expectedPriceCents !== undefined) lines.push(`expected event price (cents): ${testCase.expectedPriceCents}`);
  return lines.join('\n');
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

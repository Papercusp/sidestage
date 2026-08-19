// SPDX-License-Identifier: MIT
import { Logger } from '@nestjs/common';
import type { ScoutModelAdapter } from '@papercusp/scout-runtime';
import {
  productFocusPrompt,
  validateProductFocusModelPayload,
  type ProductFocusClassification,
  type ProductFocusClassificationInput,
} from './product-focus.classifier';

/**
 * Gemini (Vertex AI) leg of the semantic product-focus classifier.
 *
 * WHY THIS EXISTS. Vertex is this project's decided model provider, and the
 * copilot reply seam (copilot.module.ts) and the judge (judge.module.ts) both
 * route through `createVertexAdapter`. This classifier did not — it hardcoded
 * OpenAI (`OPENAI_API_KEY`, `/v1/responses`), so it was the ONE inference seam
 * still dark in production while Vertex credentials sat right there in the same
 * container. Measured 2026-08-19: `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_APPLICATION_CREDENTIALS` present and serving the copilot, while
 * `OPENAI_API_KEY` was empty and every transcript classification returned
 * `unavailable`.
 *
 * It reuses `validateProductFocusModelPayload`, so the safety properties are
 * provider-independent: an id the caller never supplied, a `different` verdict
 * below the confidence floor, or evidence naming an unknown segment are all
 * rejected here exactly as they are on the OpenAI leg. A provider that answers
 * nonsense can therefore only ever produce `unknown`, never a wrong stage
 * change.
 */
export class VertexProductFocusClassifier {
  private readonly logger = new Logger(VertexProductFocusClassifier.name);

  constructor(private readonly adapter: Pick<ScoutModelAdapter, 'model' | 'complete'>) {}

  async classify(input: ProductFocusClassificationInput): Promise<ProductFocusClassification | null> {
    try {
      const response = await this.adapter.complete({
        messages: [
          {
            role: 'system',
            content: [
              'You classify a live seller\'s CURRENT product focus from transcript context.',
              'Respond with a single JSON object and nothing else. Shape:',
              '{"decision": "same"|"different"|"ambiguous"|"unknown", "productId": string|null, "confidence": number, "evidenceSegmentIds": string[]}',
              'productId MUST be copied verbatim from the supplied PRODUCTS, or null.',
              'evidenceSegmentIds MUST be ids copied verbatim from FINALIZED_TRANSCRIPT.',
              'confidence is 0..1. Prefer ambiguous or unknown over guessing.',
            ].join('\n'),
          },
          { role: 'user', content: productFocusPrompt(input) },
        ],
        tools: [],
        temperature: 0,
      });
      const payload = extractJsonObject(response.content);
      if (!payload) {
        this.logger.warn(
          `Vertex product-focus response was unparseable (model ${this.adapter.model}) — returning no verdict.`,
        );
        return null;
      }
      return validateProductFocusModelPayload(payload, input);
    } catch (error) {
      this.logger.warn(
        `Vertex product-focus classification failed (${(error as Error).message}) — returning no verdict.`,
      );
      return null;
    }
  }
}

/** Tolerates a fenced or prose-wrapped object; mirrors the copilot Vertex leg. */
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

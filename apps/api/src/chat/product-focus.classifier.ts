import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createVertexAdapter } from '../llm/vertex-adapter';
import { VertexProductFocusClassifier } from './product-focus-vertex.classifier';

const MAX_PRODUCTS = 100;
const MAX_SEGMENTS = 4;
const MAX_TEXT_LENGTH = 800;
const MIN_DIFFERENT_CONFIDENCE = 0.84;

export interface ProductFocusProductInput {
  id: string;
  label: string;
  aliases?: readonly string[];
  brand?: string;
  productType?: string;
  description?: string;
  color?: string;
  sku?: string;
}

export interface ProductFocusSegmentInput {
  id: string;
  text: string;
}

export interface ProductFocusClassificationInput {
  activeProductId: string | null;
  products: readonly ProductFocusProductInput[];
  transcriptWindow: readonly ProductFocusSegmentInput[];
  requestSequence: number;
}

export interface ProductFocusClassification {
  decision: 'same' | 'different' | 'ambiguous' | 'unknown';
  productId: string | null;
  confidence: number;
  evidenceSegmentIds: string[];
  requestSequence: number;
  source: 'model' | 'unavailable' | 'error';
}

interface ModelPayload {
  decision?: unknown;
  productId?: unknown;
  confidence?: unknown;
  evidenceSegmentIds?: unknown;
}

function boundedString(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, max) : null;
}

function optionalString(value: unknown, max = 300): string | undefined {
  const normalized = boundedString(value, max);
  return normalized ?? undefined;
}

export function sanitizeProductFocusInput(value: unknown): ProductFocusClassificationInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.products) || !Array.isArray(raw.transcriptWindow)) return null;
  const products = raw.products.slice(0, MAX_PRODUCTS).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const product = candidate as Record<string, unknown>;
    const id = boundedString(product.id, 160);
    const label = boundedString(product.label, 300);
    if (!id || !label) return [];
    const aliases = Array.isArray(product.aliases)
      ? product.aliases.flatMap((alias) => optionalString(alias, 160) ?? []).slice(0, 20)
      : undefined;
    return [{
      id,
      label,
      ...(aliases?.length ? { aliases } : {}),
      ...(optionalString(product.brand) ? { brand: optionalString(product.brand) } : {}),
      ...(optionalString(product.productType) ? { productType: optionalString(product.productType) } : {}),
      ...(optionalString(product.description, MAX_TEXT_LENGTH) ? { description: optionalString(product.description, MAX_TEXT_LENGTH) } : {}),
      ...(optionalString(product.color) ? { color: optionalString(product.color) } : {}),
      ...(optionalString(product.sku) ? { sku: optionalString(product.sku) } : {}),
    } satisfies ProductFocusProductInput];
  });
  const transcriptWindow = raw.transcriptWindow.slice(-MAX_SEGMENTS).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const segment = candidate as Record<string, unknown>;
    const id = boundedString(segment.id, 160);
    const text = boundedString(segment.text);
    return id && text ? [{ id, text }] : [];
  });
  const activeProductId = raw.activeProductId === null ? null : boundedString(raw.activeProductId, 160);
  const requestSequence = typeof raw.requestSequence === 'number' && Number.isSafeInteger(raw.requestSequence)
    ? raw.requestSequence
    : 0;
  if (products.length === 0 || transcriptWindow.length === 0 || raw.activeProductId !== null && !activeProductId) return null;
  return { activeProductId, products, transcriptWindow, requestSequence };
}

function fallback(
  input: ProductFocusClassificationInput,
  source: 'unavailable' | 'error',
): ProductFocusClassification {
  return {
    decision: 'unknown',
    productId: null,
    confidence: 0,
    evidenceSegmentIds: [],
    requestSequence: input.requestSequence,
    source,
  };
}

export function validateProductFocusModelPayload(
  payload: ModelPayload,
  input: ProductFocusClassificationInput,
): ProductFocusClassification {
  const allowedDecisions = new Set(['same', 'different', 'ambiguous', 'unknown']);
  const decision = allowedDecisions.has(String(payload.decision))
    ? payload.decision as ProductFocusClassification['decision']
    : 'unknown';
  const rawConfidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
    ? payload.confidence
    : 0;
  const confidence = Math.max(0, Math.min(1, rawConfidence));
  const productId = typeof payload.productId === 'string' ? payload.productId : null;
  const allowedProducts = new Set(input.products.map((product) => product.id));
  const allowedSegments = new Set(input.transcriptWindow.map((segment) => segment.id));
  const evidenceSegmentIds = Array.isArray(payload.evidenceSegmentIds)
    ? payload.evidenceSegmentIds.filter((id): id is string => typeof id === 'string' && allowedSegments.has(id))
    : [];
  const validDifferent = decision === 'different'
    && productId !== null
    && productId !== input.activeProductId
    && allowedProducts.has(productId)
    && confidence >= MIN_DIFFERENT_CONFIDENCE;
  return {
    decision: validDifferent ? 'different' : decision === 'different' ? 'unknown' : decision,
    productId: validDifferent ? productId : null,
    confidence: validDifferent ? confidence : decision === 'different' ? 0 : confidence,
    evidenceSegmentIds,
    requestSequence: input.requestSequence,
    source: 'model',
  };
}

export function productFocusPrompt(input: ProductFocusClassificationInput): string {
  return [
    'TRANSCRIPT_PRODUCT_FOCUS_V1',
    'Classify the seller\'s CURRENT conversational product focus from finalized transcript context.',
    'A comparison or passing mention is not a focus change. Use different only when the seller has genuinely moved to one catalog product other than ACTIVE_PRODUCT_ID.',
    'Use only a supplied product id. If evidence is weak, conflicting, or names multiple alternatives, return ambiguous or unknown.',
    `ACTIVE_PRODUCT_ID: ${input.activeProductId ?? 'none'}`,
    `PRODUCTS: ${JSON.stringify(input.products)}`,
    `FINALIZED_TRANSCRIPT: ${JSON.stringify(input.transcriptWindow)}`,
  ].join('\n');
}

/**
 * Which env vars this classifier still needs before it can run at all.
 *
 * Exported and pure so the answer is assertable without standing up Nest, and so
 * the startup log and the degrade path cannot drift apart by naming different
 * variables.
 */
export type ProductFocusProvider = 'vertex' | 'openai';

export function productFocusClassifierConfig(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  provider: ProductFocusProvider | null;
  missing: readonly string[];
} {
  // VERTEX FIRST — it is this project's decided provider, and the copilot and
  // judge seams already route through createVertexAdapter. Its gate is exactly
  // the adapter's: GOOGLE_CLOUD_PROJECT. The model name is optional because
  // createVertexAdapter substitutes DEFAULT_VERTEX_MODEL, which is why an empty
  // SIDESTAGE_PRODUCT_FOCUS_VERTEX_MODEL is NOT reported as missing.
  if (env.GOOGLE_CLOUD_PROJECT?.trim()) {
    return { configured: true, provider: 'vertex', missing: [] };
  }
  const missing: string[] = [];
  if (!env.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY');
  // Either name satisfies the model requirement, so report the pair, not one of them.
  if (!(env.SIDESTAGE_PRODUCT_FOCUS_MODEL ?? env.SIDESTAGE_COPILOT_MODEL)?.trim()) {
    missing.push('SIDESTAGE_PRODUCT_FOCUS_MODEL (or SIDESTAGE_COPILOT_MODEL)');
  }
  if (missing.length === 0) return { configured: true, provider: 'openai', missing: [] };
  // Name the cheaper remedy too: on a box that already has Vertex credentials
  // for the copilot, GOOGLE_CLOUD_PROJECT alone turns this on.
  return {
    configured: false,
    provider: null,
    missing: [...missing, 'or GOOGLE_CLOUD_PROJECT for the Vertex leg'],
  };
}

@Injectable()
export class ConfiguredProductFocusClassifier implements OnModuleInit {
  private readonly logger = new Logger(ConfiguredProductFocusClassifier.name);
  /** Warn on the FIRST degraded call only — this runs per utterance. */
  private warnedDegradedInUse = false;
  /** Built once when the Vertex leg is the configured provider. */
  private vertex: VertexProductFocusClassifier | undefined;

  /**
   * WI-39851 wall (2): this classifier's absence used to be completely silent.
   *
   * Unprovisioned, every call returns `unavailable` and the seller simply sees no
   * suggestion — indistinguishable from "the model considered it and declined".
   * That is what let prod run without OPENAI_API_KEY while the symptom was read as
   * a matching bug. Provisioning the key is owner-gated; being loud about its
   * absence is not, so the silence is fixed here even though the gate stands.
   */
  onModuleInit(): void {
    const { configured, provider, missing } = productFocusClassifierConfig();
    if (configured) {
      // Which ENGINE is live is not inferable from the replies (a wrong verdict
      // and an unconfigured one both surface as "no suggestion"), so state it
      // once at boot rather than leaving it to be reverse-engineered from env.
      this.logger.log(`Semantic product-focus classifier ACTIVE on the ${provider} leg.`);
      if (provider === 'vertex') {
        this.vertex = new VertexProductFocusClassifier(
          createVertexAdapter(
            process.env.SIDESTAGE_PRODUCT_FOCUS_VERTEX_MODEL
              ?? process.env.SIDESTAGE_COPILOT_VERTEX_MODEL,
          )!,
        );
      }
      return;
    }
    this.logger.warn(
      `Semantic product-focus classifier DISABLED — missing ${missing.join(', ')}. ` +
        'Transcript product focus will fall back to the deterministic alias layer only, so a ' +
        'seller phrasing that no catalog alias covers will silently produce no suggestion.',
    );
  }

  async classify(rawInput: unknown): Promise<ProductFocusClassification> {
    const input = sanitizeProductFocusInput(rawInput);
    if (!input) {
      return {
        decision: 'unknown', productId: null, confidence: 0, evidenceSegmentIds: [], requestSequence: 0, source: 'error',
      };
    }
    const { configured, provider, missing } = productFocusClassifierConfig();
    if (!configured) {
      // Deliberately distinct from the startup line: this one proves the feature is
      // being EXERCISED while unconfigured, which is the difference between a dark
      // setting nobody wanted and sellers actively losing suggestions right now.
      if (!this.warnedDegradedInUse) {
        this.warnedDegradedInUse = true;
        this.logger.warn(
          `Semantic product-focus classification was REQUESTED but is unconfigured (missing ${missing.join(', ')}) — ` +
            'returning "unavailable". Further occurrences are not logged.',
        );
      }
      return fallback(input, 'unavailable');
    }

    if (provider === 'vertex') {
      // Lazily built when onModuleInit did not run (a directly-constructed
      // instance in a test, or an env that changed after boot).
      this.vertex ??= new VertexProductFocusClassifier(
        createVertexAdapter(
          process.env.SIDESTAGE_PRODUCT_FOCUS_VERTEX_MODEL
            ?? process.env.SIDESTAGE_COPILOT_VERTEX_MODEL,
        )!,
      );
      const verdict = await this.vertex.classify(input);
      // A null verdict is a PROVIDER failure, not a considered "no". It must
      // surface as `error`, never as `unknown`-from-the-model, or a broken
      // Vertex leg becomes indistinguishable from a model that declined.
      return verdict ?? fallback(input, 'error');
    }

    const apiKey = process.env.OPENAI_API_KEY!.trim();
    const model = (process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL ?? process.env.SIDESTAGE_COPILOT_MODEL)!.trim();

    try {
      const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '');
      const response = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: productFocusPrompt(input),
          text: {
            format: {
              type: 'json_schema',
              name: 'sidestage_product_focus',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  decision: { type: 'string', enum: ['same', 'different', 'ambiguous', 'unknown'] },
                  productId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  confidence: { type: 'number' },
                  evidenceSegmentIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['decision', 'productId', 'confidence', 'evidenceSegmentIds'],
              },
            },
          },
        }),
      });
      if (!response.ok) return fallback(input, 'error');
      const responsePayload = await response.json() as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const text = responsePayload.output_text ?? responsePayload.output
        ?.flatMap((item) => item.content ?? [])
        .find((item) => item.type === 'output_text')?.text;
      if (!text) return fallback(input, 'error');
      return validateProductFocusModelPayload(JSON.parse(text) as ModelPayload, input);
    } catch {
      return fallback(input, 'error');
    }
  }
}

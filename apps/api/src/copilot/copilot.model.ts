import { Injectable } from '@nestjs/common';
import type {
  CopilotActionKind,
  ModelDraft,
  ReplyGenerationRequest,
  ReplyModel,
} from './copilot.types';

const ACTION_KINDS = new Set<CopilotActionKind>([
  'markdown', 'price-adjust', 'targeted-offer', 'push', 'swap', 'stock-adjust',
]);

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

@Injectable()
export class ConfiguredCopilotReplyModel implements ReplyModel {
  async generate(request: ReplyGenerationRequest): Promise<ModelDraft> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.SIDESTAGE_COPILOT_MODEL?.trim();
    return apiKey && model
      ? this.generateRemote(request, apiKey, model)
      : this.generateDeterministic(request);
  }

  private async generateRemote(request: ReplyGenerationRequest, apiKey: string, model: string): Promise<ModelDraft> {
    const started = Date.now();
    const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '');
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: `${request.groundingPrompt}\n\nBUYER_QUESTION:\n${request.event.message}`,
        text: {
          format: {
            type: 'json_schema',
            name: 'sidestage_copilot_turn',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reply: { type: 'string' },
                citations: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' },
                tone: { type: 'string', enum: ['concise', 'warm', 'professional'] },
                action: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        kind: { type: 'string', enum: [...ACTION_KINDS] },
                        productId: { type: 'string' },
                        quantity: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                        priceCents: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                        buyerId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        swapToProductId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        reason: { type: 'string' },
                      },
                      required: ['kind', 'productId', 'quantity', 'priceCents', 'buyerId', 'swapToProductId', 'reason'],
                    },
                  ],
                },
              },
              required: ['reply', 'citations', 'confidence', 'tone', 'action'],
            },
          },
        },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Copilot model request failed (${response.status}): ${detail}`);
    }
    const payload = await response.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = payload.output_text ?? payload.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === 'output_text')?.text;
    if (!text) throw new Error('Copilot model returned no structured output');
    const raw = JSON.parse(text) as Record<string, unknown>;
    const action = raw.action && typeof raw.action === 'object'
      ? this.readAction(raw.action as Record<string, unknown>)
      : undefined;
    return {
      reply: typeof raw.reply === 'string' ? raw.reply : '',
      citations: Array.isArray(raw.citations) ? raw.citations.filter((value): value is string => typeof value === 'string') : [],
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
      tone: raw.tone === 'concise' || raw.tone === 'warm' || raw.tone === 'professional' ? raw.tone : undefined,
      action,
      latency: { completeMs: Date.now() - started },
    };
  }

  private generateDeterministic(request: ReplyGenerationRequest): ModelDraft {
    const item = request.context.eventItems[0];
    const product = request.context.catalogProducts[0];
    const transcript = request.context.transcriptMoments?.[0];
    if (item) {
      return {
        reply: `Thanks for asking — ${item.title} is ${money(item.priceCents)}, with ${item.availableQty} currently available.`,
        citations: [`event-item:${item.eventItemId}`],
        confidence: 0.98,
        tone: request.context.policy.tone,
      };
    }
    if (product) {
      const source = request.context.sources.find((candidate) => candidate.id === `catalog-product:${product.productId}`)?.id;
      return {
        reply: `Thanks for asking — I found ${product.title} in the verified catalog at ${money(product.priceCents)}.`,
        citations: source ? [source] : [],
        confidence: 0.92,
        tone: request.context.policy.tone,
      };
    }
    if (transcript) {
      return {
        reply: `The host shared: “${transcript.text}”`,
        citations: [`transcript:${transcript.transcriptId}`],
        confidence: 0.9,
        tone: request.context.policy.tone,
      };
    }
    return { reply: '', citations: [], confidence: 0, tone: request.context.policy.tone };
  }

  private readAction(raw: Record<string, unknown>): ModelDraft['action'] {
    if (!ACTION_KINDS.has(raw.kind as CopilotActionKind) || typeof raw.productId !== 'string' || typeof raw.reason !== 'string') {
      return undefined;
    }
    return {
      kind: raw.kind as CopilotActionKind,
      productId: raw.productId,
      reason: raw.reason,
      ...(typeof raw.quantity === 'number' ? { quantity: raw.quantity } : {}),
      ...(typeof raw.priceCents === 'number' ? { priceCents: raw.priceCents } : {}),
      ...(typeof raw.buyerId === 'string' ? { buyerId: raw.buyerId } : {}),
      ...(typeof raw.swapToProductId === 'string' ? { swapToProductId: raw.swapToProductId } : {}),
    };
  }
}

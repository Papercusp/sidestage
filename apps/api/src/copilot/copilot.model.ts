import { Injectable } from '@nestjs/common';
import type {
  CopilotActionKind,
  CopilotTone,
  ModelDraft,
  ReplyGenerationRequest,
  ReplyModel,
} from './copilot.types';
import { COPILOT_TONES, isCopilotTone } from './copilot.types';
import { firstRelevantSourceId } from './copilot.relevance';

const ACTION_KINDS = new Set<CopilotActionKind>([
  'markdown', 'price-adjust', 'targeted-offer', 'push', 'swap', 'stock-adjust',
]);

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function eventItemReply(
  tone: CopilotTone,
  item: { title: string; priceCents: number; availableQty: number },
): string {
  const price = money(item.priceCents);
  switch (tone) {
    case 'concise':
      return `${item.title}: ${price}; ${item.availableQty} available.`;
    case 'playful':
      return `Great pick! ${item.title} is ${price}, and ${item.availableQty} are ready to go.`;
    case 'professional':
      return `${item.title} is priced at ${price}, with ${item.availableQty} unit${item.availableQty === 1 ? '' : 's'} currently available.`;
    case 'warm':
      return `Thanks for asking — ${item.title} is ${price}, with ${item.availableQty} currently available.`;
  }
}

function catalogReply(tone: CopilotTone, product: { title: string; priceCents: number }): string {
  const price = money(product.priceCents);
  switch (tone) {
    case 'concise':
      return `${product.title}: ${price} in the verified catalog.`;
    case 'playful':
      return `Nice find! The verified catalog has ${product.title} at ${price}.`;
    case 'professional':
      return `The verified catalog lists ${product.title} at ${price}.`;
    case 'warm':
      return `Thanks for asking — I found ${product.title} in the verified catalog at ${price}.`;
  }
}

function transcriptReply(tone: CopilotTone, text: string): string {
  switch (tone) {
    case 'concise':
      return `Host: “${text}”`;
    case 'playful':
      return `Hot off the mic: “${text}”`;
    case 'professional':
      return `The host stated: “${text}”`;
    case 'warm':
      return `The host shared: “${text}”`;
  }
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
    const base = process.env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '') || 'https://api.openai.com';
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
                tone: { type: 'string', enum: [...COPILOT_TONES] },
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
      tone: isCopilotTone(raw.tone) ? raw.tone : undefined,
      action,
      provider: 'openai',
      latency: { completeMs: Date.now() - started },
    };
  }

  private generateDeterministic(request: ReplyGenerationRequest): ModelDraft {
    const eventSource = firstRelevantSourceId(request.event, request.context, 'event-item:');
    const catalogSource = firstRelevantSourceId(request.event, request.context, 'catalog-product:');
    const transcriptSource = firstRelevantSourceId(request.event, request.context, 'transcript:');
    const item = eventSource
      ? request.context.eventItems.find((candidate) => `event-item:${candidate.eventItemId}` === eventSource)
      : undefined;
    const product = catalogSource
      ? request.context.catalogProducts.find((candidate) => `catalog-product:${candidate.productId}` === catalogSource)
      : undefined;
    const transcript = transcriptSource
      ? request.context.transcriptMoments?.find((candidate) => `transcript:${candidate.transcriptId}` === transcriptSource)
      : undefined;
    if (item) {
      return {
        reply: eventItemReply(request.context.policy.tone, item),
        citations: [eventSource!],
        confidence: 0.98,
        tone: request.context.policy.tone,
      };
    }
    if (product) {
      return {
        reply: catalogReply(request.context.policy.tone, product),
        citations: [catalogSource!],
        confidence: 0.92,
        tone: request.context.policy.tone,
      };
    }
    if (transcript) {
      return {
        reply: transcriptReply(request.context.policy.tone, transcript.text),
        citations: [transcriptSource!],
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

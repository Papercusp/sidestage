// SPDX-License-Identifier: MIT
import { Injectable, Logger } from '@nestjs/common';
import type { ScoutModelAdapter } from '@papercusp/scout-runtime';
import {
  COPILOT_TONES,
  type CopilotActionProposal,
  type CopilotTone,
  type ModelDraft,
  type ReplyGenerationRequest,
  type ReplyModel,
} from './copilot.types';

/**
 * Gemini (Vertex AI) leg of the copilot reply seam.
 *
 * The adapter is the same one Scout uses, so credentials, retry policy and
 * regional routing stay in one place. The draft contract mirrors the OpenAI
 * leg: strict JSON with reply, citations, confidence, tone and an optional
 * action proposal. A malformed or unparseable model turn falls back to the
 * deterministic engine — the pipeline never surfaces a provider failure to a
 * buyer.
 */
@Injectable()
export class VertexCopilotReplyModel implements ReplyModel {
  private readonly logger = new Logger(VertexCopilotReplyModel.name);

  constructor(
    private readonly adapter: Pick<ScoutModelAdapter, 'model' | 'complete'>,
    private readonly fallback: ReplyModel,
  ) {}

  async generate(request: ReplyGenerationRequest): Promise<ModelDraft> {
    const started = Date.now();
    try {
      const response = await this.adapter.complete({
        messages: [
          {
            role: 'system',
            content: [
              'You are the SideStage seller copilot. Answer the buyer question using ONLY the grounding context.',
              'Respond with a single JSON object and nothing else. Shape:',
              '{"reply": string, "citations": string[], "confidence": number, "tone": "concise"|"warm"|"playful"|"professional", "action": object|null}',
              'citations MUST be ids copied verbatim from the grounding context sources. If the context does not support an answer, say so honestly in reply and cite nothing.',
              'confidence is 0..1. action stays null unless the seller should be offered a concrete staged action already described in the context.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `${request.groundingPrompt}\n\nBUYER_QUESTION:\n${request.event.message}`,
          },
        ],
        tools: [],
        temperature: 0.2,
      });
      const draft = this.parseDraft(response.content, request);
      if (!draft) {
        this.logger.warn(`Gemini copilot draft unparseable (model ${this.adapter.model}); using deterministic fallback`);
        return this.fallback.generate(request);
      }
      return { ...draft, latency: { completeMs: Date.now() - started } };
    } catch (error) {
      this.logger.warn(`Gemini copilot generation failed (${(error as Error).message}); using deterministic fallback`);
      return this.fallback.generate(request);
    }
  }

  private parseDraft(content: string, request: ReplyGenerationRequest): ModelDraft | null {
    const raw = extractJsonObject(content);
    if (!raw) return null;
    const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
    if (!reply) return null;

    const knownSourceIds = new Set(request.context.sources.map((source) => source.id));
    const citations = Array.isArray(raw.citations)
      ? raw.citations.filter((id): id is string => typeof id === 'string' && knownSourceIds.has(id))
      : [];

    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : undefined;

    const tone = typeof raw.tone === 'string' && (COPILOT_TONES as readonly string[]).includes(raw.tone)
      ? (raw.tone as CopilotTone)
      : undefined;

    // The action ladder re-validates every proposal (shape, policy, price,
    // inventory) before anything is staged, so an object is passed through and
    // anything else is dropped rather than guessed at.
    const action = raw.action && typeof raw.action === 'object' && !Array.isArray(raw.action)
      ? (raw.action as CopilotActionProposal)
      : undefined;

    return { reply, citations, confidence, tone, ...(action ? { action } : {}) };
  }
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

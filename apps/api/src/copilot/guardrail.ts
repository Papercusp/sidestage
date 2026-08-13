import type {
  ActionGuard,
  CopilotActionProposal,
  CopilotPolicy,
  GroundingContext,
  GuardrailDecision,
  ReplyGuard,
  ReplyGuardInput,
} from './copilot.types';

const MAX_PRICE_CENTS = Number.MAX_SAFE_INTEGER;
const ACTION_KINDS = new Set<CopilotActionProposal['kind']>(['markdown', 'price-adjust', 'targeted-offer']);

function allowed(): GuardrailDecision {
  return { allowed: true };
}

function blocked(code: GuardrailDecision['code'], explanation: string): GuardrailDecision {
  return { allowed: false, code, explanation };
}

function eventItemFor(action: CopilotActionProposal, context: GroundingContext) {
  return context.eventItems.find((item) => item.productId === action.productId);
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_PRICE_CENTS;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function markdownPercent(currentPriceCents: number, proposedPriceCents: number): number {
  if (proposedPriceCents >= currentPriceCents || currentPriceCents === 0) return 0;
  return ((currentPriceCents - proposedPriceCents) / currentPriceCents) * 100;
}

function validPolicy(policy: CopilotPolicy): boolean {
  return Number.isFinite(policy.maxMarkdownPercent)
    && policy.maxMarkdownPercent >= 0
    && policy.maxMarkdownPercent <= 100;
}

/**
 * Deterministic server-side gate for copilot action proposals.
 *
 * The model can suggest an action, but it cannot widen policy, invent stock,
 * or bypass a configured price floor. The first failure is stable and is
 * returned with a seller-readable explanation for the UI.
 */
export class PolicyActionGuard implements ActionGuard {
  async evaluate(action: CopilotActionProposal, context: GroundingContext): Promise<GuardrailDecision> {
    if (!ACTION_KINDS.has(action.kind)) {
      return blocked('invalid-action', `The action kind ${String(action.kind)} is not supported.`);
    }
    const eventItem = eventItemFor(action, context);
    if (!eventItem) {
      return blocked('invalid-action', `No verified event item exists for product ${action.productId}.`);
    }
    if (!validPolicy(context.policy)) {
      return blocked('policy', 'The event policy has an invalid maximum markdown percentage.');
    }
    if (!action.reason?.trim()) {
      return blocked('invalid-action', 'Every proposed action must include a reason before it can be sent.');
    }
    if (context.policy.blockedActionKinds.includes(action.kind)) {
      return blocked('policy', `The event policy does not allow ${action.kind} actions.`);
    }

    if (action.kind === 'targeted-offer') {
      if (!action.buyerId?.trim()) {
        return blocked('buyer-target', 'A targeted offer must name the buyer who will receive it.');
      }
      if (!isPositiveInteger(action.quantity)) {
        return blocked('invalid-action', 'A targeted offer must specify a positive whole-unit quantity.');
      }
      if (action.quantity > eventItem.availableQty) {
        return blocked(
          'availability',
          `Only ${eventItem.availableQty} unit${eventItem.availableQty === 1 ? '' : 's'} remain available for ${eventItem.title}.`,
        );
      }
    } else if (action.quantity !== undefined) {
      return blocked('invalid-action', `${action.kind} actions cannot include a quantity.`);
    }

    if (!isMoney(action.priceCents) || action.priceCents <= 0) {
      return blocked('invalid-action', `${action.kind} actions must specify a positive integer price in cents.`);
    }

    const configuredFloor = context.policy.priceFloorCentsByProduct[action.productId];
    if (!isMoney(configuredFloor)) {
      return blocked('policy', `No verified price floor is configured for ${eventItem.title}.`);
    }
    if (action.priceCents < configuredFloor) {
      return blocked(
        'price-floor',
        `The proposed price of ${action.priceCents} cents is below the ${configuredFloor}-cent floor for ${eventItem.title}.`,
      );
    }

    const markdown = markdownPercent(eventItem.priceCents, action.priceCents);
    if (markdown > context.policy.maxMarkdownPercent) {
      return blocked(
        'markdown-limit',
        `The proposed markdown of ${markdown.toFixed(2)}% exceeds the ${context.policy.maxMarkdownPercent}% event limit.`,
      );
    }
    if ((action.kind === 'markdown' || action.kind === 'targeted-offer') && action.priceCents > eventItem.priceCents) {
      return blocked('invalid-action', `${action.kind} actions cannot increase the verified event price.`);
    }

    return allowed();
  }
}

/**
 * Validates the model's optional tone assertion at the send boundary. Older
 * providers may omit the assertion; policy is still included in the prompt,
 * while an explicit mismatch is always blocked and explained.
 */
export class PolicyReplyGuard implements ReplyGuard {
  async evaluate(input: ReplyGuardInput, context: GroundingContext): Promise<GuardrailDecision> {
    if (!input.reply.trim()) {
      return blocked('invalid-action', 'A non-empty reply is required before sending.');
    }
    if (input.declaredTone && input.declaredTone !== context.policy.tone) {
      return blocked(
        'tone',
        `The draft uses a ${input.declaredTone} tone, but this event requires a ${context.policy.tone} tone.`,
      );
    }
    return allowed();
  }
}

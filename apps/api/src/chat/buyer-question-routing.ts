export type BuyerMessageRouteDestination = 'seller-review' | 'none';

export type BuyerMessageCategory =
  | 'availability'
  | 'commerce'
  | 'general'
  | 'policy'
  | 'price'
  | 'product'
  | 'shipping'
  | 'social';

export type BuyerMessageRouteSignal =
  | 'commerce-request'
  | 'not-a-question'
  | 'question-mark'
  | 'question-opener'
  | 'social-question';

export interface BuyerMessageRouting {
  version: 1;
  destination: BuyerMessageRouteDestination;
  category: BuyerMessageCategory;
  signal: BuyerMessageRouteSignal;
}

const QUESTION_OPENER = /^(?:(?:hey|hi)\s+)?(?:please\s+)?(?:what|when|where|who|why|how|is|are|was|were|does|do|did|can|could|will|would|should|has|have|may|tell me)\b/i;
const COMMERCE_REQUEST = /^(?:(?:hey|hi)\s+)?(?:please\s+)?(?:add|bid|buy|discount|hold|mark down|make (?:me )?an? offer|put|reserve|save|ship|show)\b/i;
const SOCIAL_QUESTION = /^(?:are (?:you|we) (?:excited|ready)|can (?:anyone|you) (?:hear|see) me|do you (?:agree|like it)|how(?:'s| is) everyone|isn(?:'t|’t) it|okay|ok|really|right|seriously|who(?:'s| is) (?:here|watching))\s*[?!.]*$/i;

const CATEGORY_PATTERNS: ReadonlyArray<{
  category: Exclude<BuyerMessageCategory, 'general' | 'social'>;
  pattern: RegExp;
}> = [
  { category: 'availability', pattern: /\b(?:available|availability|how many|in stock|inventory|left|quantity|sold out|stock)\b/i },
  { category: 'price', pattern: /\b(?:cost|deal|discount|how much|markdown|offer|price|priced)\b/i },
  { category: 'shipping', pattern: /\b(?:arrive|delivery|deliver|pickup|return|returns|ship|shipping)\b/i },
  { category: 'policy', pattern: /\b(?:authentic|authentication|fees?|payment|refund|tax|warrant(?:y|ies))\b/i },
  { category: 'commerce', pattern: /\b(?:add (?:it|this|that|one)?\s*(?:to (?:my )?cart)?|bid|buy|checkout|hold|purchase|reserve)\b/i },
  { category: 'product', pattern: /\b(?:brand|color|colour|condition|crack|damage|dimensions?|fit|flaw|included|made (?:from|in|of)|material|measurements?|model|scratch|size|weight|work with)\b/i },
];

function categoryFor(value: string): Exclude<BuyerMessageCategory, 'social'> {
  return CATEGORY_PATTERNS.find(({ pattern }) => pattern.test(value))?.category ?? 'general';
}

/**
 * One provider-independent routing decision for buyer chat.
 *
 * The classifier deliberately over-routes genuine buyer questions to seller
 * review while excluding short room/social prompts. The stored result is the
 * authority consumed by Copilot; downstream code must not reclassify text.
 */
export function classifyBuyerMessage(value: string): BuyerMessageRouting {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (SOCIAL_QUESTION.test(normalized)) {
    return { version: 1, destination: 'none', category: 'social', signal: 'social-question' };
  }
  if (COMMERCE_REQUEST.test(normalized)) {
    return { version: 1, destination: 'seller-review', category: 'commerce', signal: 'commerce-request' };
  }
  const category = categoryFor(normalized);
  if (QUESTION_OPENER.test(normalized)) {
    return { version: 1, destination: 'seller-review', category, signal: 'question-opener' };
  }
  if (normalized.includes('?')) {
    return { version: 1, destination: 'seller-review', category, signal: 'question-mark' };
  }
  return { version: 1, destination: 'none', category, signal: 'not-a-question' };
}

export function isBuyerQuestion(value: string): boolean {
  return classifyBuyerMessage(value).destination === 'seller-review';
}

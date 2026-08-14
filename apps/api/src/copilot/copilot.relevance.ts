import type {
  CopilotRequest,
  GroundingContext,
  WebResearchFinding,
} from './copilot.types';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'exact', 'for', 'have',
  'how', 'i', 'in', 'include', 'includes', 'is', 'it', 'me', 'of', 'on', 'please',
  'still', 'tell', 'that', 'the', 'this', 'to', 'what', 'with', 'you', 'your',
]);
const PRICE_WORDS = ['cost', 'much', 'price', 'priced'];
const STOCK_WORDS = ['availability', 'available', 'inventory', 'left', 'quantity', 'stock'];

function singular(token: string): string {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
}

export function relevanceTokens(value: string): Set<string> {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .map(singular);
  return new Set(words);
}

function addTokens(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
  for (const token of relevanceTokens(String(value))) target.add(token);
}

function addAttributes(target: Set<string>, attributes: Record<string, string | number | boolean>): void {
  for (const [key, value] of Object.entries(attributes)) {
    addTokens(target, key);
    addTokens(target, value);
  }
}

function questionTokens(request: Pick<CopilotRequest, 'message' | 'requiredProperties'>): Set<string> {
  const result = relevanceTokens(request.message);
  for (const property of request.requiredProperties ?? []) {
    for (const token of relevanceTokens(property)) result.add(token);
  }
  for (const stop of STOP_WORDS) result.delete(stop);
  return result;
}

function coversQuestion(
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  facts: Set<string>,
): boolean {
  const wanted = questionTokens(request);
  return wanted.size > 0 && [...wanted].every((token) => facts.has(token));
}

function eventItemFacts(item: GroundingContext['eventItems'][number]): Set<string> {
  const facts = relevanceTokens(`${item.title} ${item.description ?? ''}`);
  PRICE_WORDS.forEach((word) => facts.add(word));
  STOCK_WORDS.forEach((word) => facts.add(word));
  addAttributes(facts, item.attributes);
  return facts;
}

function catalogProductFacts(product: GroundingContext['catalogProducts'][number]): Set<string> {
  const facts = relevanceTokens(`${product.title} ${product.description ?? ''}`);
  PRICE_WORDS.forEach((word) => facts.add(word));
  addAttributes(facts, product.attributes);
  return facts;
}

function webFindingFacts(finding: WebResearchFinding): Set<string> {
  const facts = relevanceTokens(`${finding.title} ${finding.snippet}`);
  addAttributes(facts, finding.attributes ?? {});
  return facts;
}

/**
 * A citation is useful only when its concrete source covers every meaningful
 * term/property in the buyer question. Merely naming a known source id is not
 * grounding: an event-item citation about price cannot support a warranty or
 * overnight-shipping claim.
 */
export function sourceSupportsQuestion(
  sourceId: string,
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  context: GroundingContext,
): boolean {
  if (sourceId.startsWith('event-item:')) {
    const id = sourceId.slice('event-item:'.length);
    const item = context.eventItems.find((candidate) => candidate.eventItemId === id);
    return Boolean(item && coversQuestion(request, eventItemFacts(item)));
  }
  if (sourceId.startsWith('catalog-product:')) {
    const id = sourceId.slice('catalog-product:'.length);
    const product = context.catalogProducts.find((candidate) => candidate.productId === id);
    return Boolean(product && coversQuestion(request, catalogProductFacts(product)));
  }
  if (sourceId.startsWith('transcript:')) {
    const id = sourceId.slice('transcript:'.length);
    const moment = context.transcriptMoments?.find((candidate) => candidate.transcriptId === id);
    return Boolean(moment && coversQuestion(request, relevanceTokens(`${moment.productTitle ?? ''} ${moment.text}`)));
  }
  if (sourceId.startsWith('web-research:')) {
    const id = sourceId.slice('web-research:'.length);
    const finding = context.webFindings?.find((candidate) => candidate.findingId === id);
    return Boolean(finding && coversQuestion(request, webFindingFacts(finding)));
  }
  return false;
}

export function firstRelevantSourceId(
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  context: GroundingContext,
  prefix: 'event-item:' | 'catalog-product:' | 'transcript:',
): string | undefined {
  return context.sources
    .map((source) => source.id)
    .find((sourceId) => sourceId.startsWith(prefix) && sourceSupportsQuestion(sourceId, request, context));
}

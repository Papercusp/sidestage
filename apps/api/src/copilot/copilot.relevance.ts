import type {
  CopilotRequest,
  GroundingContext,
  WebResearchFinding,
} from './copilot.types';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'exact', 'for', 'have',
  'how', 'i', 'in', 'include', 'includes', 'is', 'it', 'me', 'of', 'on', 'please',
  'share', 'still', 'tell', 'that', 'the', 'this', 'to', 'what', 'with', 'you', 'your',
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

/**
 * A source's vocabulary, split by what each half is allowed to decide.
 *
 * `identity` is what the source IS — its title, description and attributes.
 * Only these anchor a question to a source, because only these distinguish one
 * product from another.
 *
 * `all` additionally carries the intent vocabulary a source can always speak to
 * (price for anything priced, stock for anything with live quantity). These
 * words are deliberately EXCLUDED from `identity`: every event item can answer
 * "how much", so matching on them would make every item relevant to every price
 * question and cite the wrong product.
 */
interface SourceFacts {
  readonly identity: Set<string>;
  readonly all: Set<string>;
}

function factsOf(identity: Set<string>, intent: readonly string[][]): SourceFacts {
  const all = new Set(identity);
  for (const words of intent) for (const word of words) all.add(word);
  return { identity, all };
}

function withoutStopWords(tokens: Set<string>): Set<string> {
  for (const stop of STOP_WORDS) tokens.delete(stop);
  return tokens;
}

function requiredPropertyTokens(
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
): Set<string> {
  const result = new Set<string>();
  for (const property of request.requiredProperties ?? []) {
    for (const token of relevanceTokens(property)) result.add(token);
  }
  return withoutStopWords(result);
}

/**
 * Does this source support answering this question?
 *
 * TWO tests, and deliberately not a third:
 *
 *  1. EXPLICIT DEMANDS ARE STRICT. Every token of `requiredProperties` must be
 *     in the source's vocabulary. This is the channel a caller uses to say "do
 *     not answer unless you can verify X", so it stays an exact conjunction —
 *     it is what makes a missing catalog property fall through to the research
 *     fallback instead of being answered from a catalog that lacks the fact.
 *
 *  2. THE QUESTION MUST NAME THIS SOURCE. At least one question token must hit
 *     the source's `identity` vocabulary, so a question about the Harbor Kettle
 *     cannot be grounded by the headphones listing.
 *
 * WHAT IS NOT TESTED, AND WHY. Until now this function additionally required
 * that EVERY non-stopword token of the buyer's message appear in the source's
 * vocabulary. That made grounding strength fall as the buyer wrote a longer,
 * more natural question: ordinary English ("right", "now", "many") was
 * indistinguishable from a real property demand ("warranty"), so it gated
 * exactly like one. A hand-maintained 30-word stopword list was the only thing
 * holding it up, and it covered the short phrasings the tests happened to use.
 * Measured on the running stack: "How much is the Harbor Kettle?" grounded,
 * while the same question with any prefix — or asked as "what is the event
 * price ... and how many are available right now?" — returned "no verified
 * citation" (EI-20488839136964773).
 *
 * The intent behind that conjunction was real: an event-item citation about
 * price must not support a warranty or overnight-shipping claim. But a word in
 * the QUESTION is not a claim — only the reply can assert something false, and
 * whether an assertion is supported by its evidence is decided by the
 * claim/evidence contract (copilot.claims.ts) and enforced at send time against
 * a fresh fingerprint. That layer can evaluate what this one could only guess
 * at, so the check belongs there and the guess is removed rather than tuned.
 */
function coversQuestion(
  request: Pick<CopilotRequest, 'message' | 'requiredProperties'>,
  facts: SourceFacts,
  namesAProduct: boolean,
): boolean {
  for (const token of requiredPropertyTokens(request)) {
    if (!facts.all.has(token)) return false;
  }
  const asked = withoutStopWords(relevanceTokens(request.message));
  if (asked.size === 0) return false;
  if (namesAProduct) {
    // The buyer named a product, so the remaining words are how they chose to
    // phrase it. Ask only whether THIS source is the product they named.
    for (const token of asked) {
      if (facts.identity.has(token)) return true;
    }
    return false;
  }
  // The buyer named no product in this context ("What is the price?"), so
  // there is no identity to match on and every word still has to be accounted
  // for — otherwise "how much is the espresso machine?" would ground on the
  // kettle merely because both know the word "much".
  return [...asked].every((token) => facts.all.has(token));
}

/**
 * Does the question name any product present in this context?
 *
 * This is what decides which of the two tests above applies, and it is a
 * property of the QUESTION AND THE CONTEXT TOGETHER — not of any one source —
 * which is why it is computed once here rather than inside coversQuestion.
 */
function questionNamesAProduct(
  request: Pick<CopilotRequest, 'message'>,
  context: GroundingContext,
): boolean {
  const asked = withoutStopWords(relevanceTokens(request.message));
  if (asked.size === 0) return false;
  const identities = [
    ...context.eventItems.map((item) => eventItemFacts(item).identity),
    ...context.catalogProducts.map((product) => catalogProductFacts(product).identity),
  ];
  return identities.some((identity) => [...asked].some((token) => identity.has(token)));
}

function eventItemFacts(item: GroundingContext['eventItems'][number]): SourceFacts {
  const identity = relevanceTokens(`${item.title} ${item.description ?? ''}`);
  addAttributes(identity, item.attributes);
  return factsOf(identity, [PRICE_WORDS, STOCK_WORDS]);
}

function catalogProductFacts(product: GroundingContext['catalogProducts'][number]): SourceFacts {
  const identity = relevanceTokens(`${product.title} ${product.description ?? ''}`);
  addAttributes(identity, product.attributes);
  return factsOf(identity, [PRICE_WORDS]);
}

function webFindingFacts(finding: WebResearchFinding): SourceFacts {
  const identity = relevanceTokens(`${finding.title} ${finding.snippet}`);
  addAttributes(identity, finding.attributes ?? {});
  return factsOf(identity, []);
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
  const named = questionNamesAProduct(request, context);
  if (sourceId.startsWith('event-item:')) {
    const id = sourceId.slice('event-item:'.length);
    const item = context.eventItems.find((candidate) => candidate.eventItemId === id);
    return Boolean(item && coversQuestion(request, eventItemFacts(item), named));
  }
  if (sourceId.startsWith('catalog-product:')) {
    const id = sourceId.slice('catalog-product:'.length);
    const product = context.catalogProducts.find((candidate) => candidate.productId === id);
    return Boolean(product && coversQuestion(request, catalogProductFacts(product), named));
  }
  if (sourceId.startsWith('transcript:')) {
    const id = sourceId.slice('transcript:'.length);
    const moment = context.transcriptMoments?.find((candidate) => candidate.transcriptId === id);
    return Boolean(moment && coversQuestion(
      request,
      factsOf(relevanceTokens(`${moment.productTitle ?? ''} ${moment.text}`), []),
      named,
    ));
  }
  if (sourceId.startsWith('web-research:')) {
    const id = sourceId.slice('web-research:'.length);
    const finding = context.webFindings?.find((candidate) => candidate.findingId === id);
    return Boolean(finding && coversQuestion(request, webFindingFacts(finding), named));
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

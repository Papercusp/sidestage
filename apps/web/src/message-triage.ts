export type MessageImportance = 'high' | 'normal' | 'low';

export interface MessageTriage {
  importance: MessageImportance;
  label: string;
  reason: string;
}

export interface TriagedMessage<T extends { text: string }> {
  message: T;
  triage: MessageTriage;
}

const HIGH_INTENT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\?/, 'Direct question'],
  [/\b(price|cost|discount|bundle|buy|order|reserve|hold)\b/, 'Purchase intent'],
  [/\b(available|availability|stock|restock|left|quantity)\b/, 'Inventory question'],
  [/\b(size|fit|material|color|colour|shipping|ship|delivery|return|refund)\b/, 'Product detail'],
  [/\b(when|where|how|can|does|will)\b/, 'Needs a seller answer'],
];

const LOW_SOCIAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(hi|hello|hey)\b/, 'Greeting'],
  [/\b(thanks|thank you|love|cute|beautiful|gorgeous|amazing)\b/, 'Social reaction'],
];

function normalizeMessageText(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/** Classify buyer chat locally so the seller queue stays fast and keyless. */
export function classifyMessageImportance(text: string): MessageTriage {
  const normalized = normalizeMessageText(text);
  const highSignal = HIGH_INTENT_PATTERNS.find(([pattern]) => pattern.test(normalized));
  if (highSignal) {
    return { importance: 'high', label: 'Priority', reason: highSignal[1] };
  }

  const lowSignal = LOW_SOCIAL_PATTERNS.find(([pattern]) => pattern.test(normalized));
  if (lowSignal) {
    return { importance: 'low', label: 'Social', reason: lowSignal[1] };
  }

  return { importance: 'normal', label: 'Question', reason: 'Worth a seller review' };
}

export function triageMessages<T extends { text: string }>(messages: readonly T[]): TriagedMessage<T>[] {
  return messages.map((message) => ({ message, triage: classifyMessageImportance(message.text) }));
}

export const MESSAGE_IMPORTANCE_ORDER: Readonly<Record<MessageImportance, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

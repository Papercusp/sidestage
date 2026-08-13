export type LoadScenarioKind = 'price' | 'shipping' | 'policy' | 'variant' | 'stock' | 'offer' | 'bid';

export interface LoadCorpusEntry {
  kind: LoadScenarioKind;
  prompt: string;
}

export const LOAD_CORPUS: readonly LoadCorpusEntry[] = [
  { kind: 'price', prompt: 'What is the current price and compare-at price?' },
  { kind: 'shipping', prompt: 'How fast can this ship, and what does shipping cost?' },
  { kind: 'policy', prompt: 'Can I return this if the fit is not right?' },
  { kind: 'variant', prompt: 'Do you have this in the blue medium variant?' },
  { kind: 'stock', prompt: 'How many are left right now?' },
  { kind: 'offer', prompt: 'Can you make a live offer if I buy two?' },
  { kind: 'bid', prompt: 'I want to place the next bid.' },
];

export interface LoadSimulationRequest {
  /** Simulated websocket clients/users. */
  users: number;
  /** Messages emitted by each simulated user per second. */
  messagesPerSecond: number;
  /** Duration of the deterministic rehearsal in seconds. */
  durationSeconds: number;
  corpus?: readonly LoadCorpusEntry[];
}

export interface SimulatedMessage {
  clientId: string;
  sequence: number;
  elapsedMs: number;
  kind: LoadScenarioKind;
  prompt: string;
}

export interface LoadCoverage {
  expectedKinds: readonly LoadScenarioKind[];
  observedKinds: readonly LoadScenarioKind[];
  counts: Readonly<Partial<Record<LoadScenarioKind, number>>>;
  complete: boolean;
}

export interface LoadSimulationResult {
  request: Required<Pick<LoadSimulationRequest, 'users' | 'messagesPerSecond' | 'durationSeconds'>>;
  totalMessages: number;
  clients: readonly string[];
  messages: readonly SimulatedMessage[];
  coverage: LoadCoverage;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

/**
 * Produce a deterministic client/message schedule for the Test tab.
 *
 * This intentionally models the pressure and corpus coverage without opening
 * sockets. A transport adapter can consume `messages` later, while a clean
 * in-process result makes the rehearsal repeatable in a browser and in tests.
 */
export function simulateLoad(request: LoadSimulationRequest): LoadSimulationResult {
  const users = positiveInteger(request.users, 'users');
  const messagesPerSecond = positiveInteger(request.messagesPerSecond, 'messagesPerSecond');
  const durationSeconds = positiveInteger(request.durationSeconds, 'durationSeconds');
  const corpus = request.corpus?.length ? request.corpus : LOAD_CORPUS;
  if (corpus.length === 0) throw new Error('corpus must contain at least one entry');

  const clients = Array.from({ length: users }, (_, index) => `test-client-${index + 1}`);
  const messagesPerClient = messagesPerSecond * durationSeconds;
  const messages: SimulatedMessage[] = [];
  const counts: Partial<Record<LoadScenarioKind, number>> = {};

  for (let clientIndex = 0; clientIndex < users; clientIndex += 1) {
    for (let sequence = 0; sequence < messagesPerClient; sequence += 1) {
      const corpusEntry = corpus[(clientIndex * messagesPerClient + sequence) % corpus.length];
      const message: SimulatedMessage = {
        clientId: clients[clientIndex],
        sequence,
        elapsedMs: Math.floor((sequence / messagesPerSecond) * 1_000),
        kind: corpusEntry.kind,
        prompt: corpusEntry.prompt,
      };
      messages.push(message);
      counts[message.kind] = (counts[message.kind] ?? 0) + 1;
    }
  }

  const expectedKinds = [...new Set(corpus.map((entry) => entry.kind))];
  const observedKinds = expectedKinds.filter((kind) => (counts[kind] ?? 0) > 0);
  return {
    request: { users, messagesPerSecond, durationSeconds },
    totalMessages: messages.length,
    clients,
    messages,
    coverage: {
      expectedKinds,
      observedKinds,
      counts,
      complete: observedKinds.length === expectedKinds.length,
    },
  };
}

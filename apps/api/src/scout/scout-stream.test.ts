import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { DeterministicScoutReplyModel, ScoutService, chunkReply } from './scout.service';
import type {
  ScoutReplyModel,
  ScoutReplyRequest,
  ScoutSessionStore,
  ScoutStreamEvent,
  ScoutStreamRequest,
} from './scout.types';

function service(opts: { sessions?: ScoutSessionStore; model?: ScoutReplyModel } = {}) {
  return new ScoutService(
    scoutCatalogFrom(new FixtureCatalogSource()),
    opts.model ?? new DeterministicScoutReplyModel(),
    new CartService(new InMemoryCartStore()),
    opts.sessions ?? new InMemoryScoutSessionStore(),
  );
}

async function collect(input: ScoutStreamRequest, svc = service()): Promise<ScoutStreamEvent[]> {
  const events: ScoutStreamEvent[] = [];
  for await (const event of svc.stream(input)) events.push(event);
  return events;
}

const typesOf = (events: ScoutStreamEvent[]) => events.map((e) => e.type);
const textOf = (events: ScoutStreamEvent[]) =>
  events.filter((e) => e.type === 'token').map((e) => (e as { content: string }).content).join('');

describe('chunkReply', () => {
  it('round-trips: joining every chunk reproduces the reply EXACTLY', () => {
    // The client reducer appends slices blindly, so a lost or duplicated space
    // is a visible rendering bug rather than a test-only detail.
    for (const text of [
      'I found 3 verified options: A, B, C. Pick one.',
      'one',
      'trailing space kept ',
      'multiple   internal   spaces',
      'line\nbreaks\tand tabs',
    ]) {
      expect(chunkReply(text).join('')).toBe(text);
    }
  });

  it('emits several chunks for a multi-word reply, and none for empty text', () => {
    expect(chunkReply('a b c d e f g', 3).length).toBeGreaterThan(1);
    expect(chunkReply('')).toEqual([]);
  });
});

describe('ScoutService.stream — the wire contract', () => {
  it('emits session → tool_start → products → token* → done, in that order', async () => {
    const events = await collect({ message: 'wireless headphones', maxProducts: 3 });
    const types = typesOf(events);

    expect(types[0]).toBe('session');
    expect(types[types.length - 1]).toBe('done');
    expect(types.indexOf('tool_start')).toBeLessThan(types.indexOf('products'));
    expect(types.indexOf('products')).toBeLessThan(types.indexOf('token'));
    // tool_start raises the status line; the first token clears it, so a turn
    // that never emits a token would leave the drawer showing "Searching…".
    expect(types.filter((t) => t === 'token').length).toBeGreaterThan(0);
  });

  it('carries a session id on the first event and verified products on the products event', async () => {
    const events = await collect({ message: 'wireless headphones', maxProducts: 3 });
    const session = events[0] as { type: 'session'; sessionId: string };
    expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);

    const products = events.find((e) => e.type === 'products') as {
      products: Array<{ title: string }>;
    };
    expect(products.products[0].title).toContain('Headphones');
  });

  it('reuses a client-supplied session id rather than minting a new one', async () => {
    const events = await collect({ message: 'headphones', sessionId: 'existing-session' });
    expect(events[0]).toEqual({ type: 'session', sessionId: 'existing-session' });
  });

  it('ends a blank turn with a terminal error naming the actual problem', async () => {
    const events = await collect({ message: '   ' });
    expect(typesOf(events)).toEqual(['session', 'error']);
    expect(events[1]).toEqual({ type: 'error', message: 'message is required' });
  });

  it('streams the reply text intact across token slices', async () => {
    const model = new DeterministicScoutReplyModel();
    const events = await collect({ message: 'wireless headphones', maxProducts: 3 }, service({ model }));
    const products = (
      events.find((e): e is Extract<ScoutStreamEvent, { type: 'products' }> => e.type === 'products')
    )!.products;
    const expected = await model.generate({ message: 'wireless headphones', products });
    expect(textOf(events)).toBe(expected);
  });

  it('relays a model that streams NATIVELY instead of chunking a finished string', async () => {
    const nativeModel: ScoutReplyModel = {
      async generate() {
        throw new Error('generate() must not be called when stream() exists');
      },
      async *stream(_request: ScoutReplyRequest) {
        yield 'live ';
        yield 'tokens';
      },
    };
    const events = await collect({ message: 'headphones' }, service({ model: nativeModel }));
    expect(textOf(events)).toBe('live tokens');
    expect(typesOf(events).at(-1)).toBe('done');
  });
});

describe('ScoutService.stream — transcript persistence', () => {
  it('persists the user turn and the assistant reply under the streamed session id', async () => {
    const sessions = new InMemoryScoutSessionStore();
    const events = await collect({ message: 'wireless headphones' }, service({ sessions }));
    const { sessionId } = events[0] as { sessionId: string };

    const stored = await sessions.get(sessionId);
    expect(stored?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored?.messages[0].content).toBe('wireless headphones');
    expect(stored?.messages[1].content).toBe(textOf(events));
  });

  it('does not persist a blank turn', async () => {
    const sessions = new InMemoryScoutSessionStore();
    const events = await collect({ message: '  ' }, service({ sessions }));
    const { sessionId } = events[0] as { sessionId: string };
    expect(await sessions.get(sessionId)).toBeNull();
  });

  it('still completes the turn when the transcript store fails — a save error must not eat the reply', async () => {
    const failing: ScoutSessionStore = {
      async get() {
        return null;
      },
      async append() {
        throw new Error('postgres is down');
      },
    };
    const events = await collect({ message: 'headphones' }, service({ sessions: failing }));
    expect(typesOf(events).at(-1)).toBe('done');
    expect(textOf(events).length).toBeGreaterThan(0);
  });
});

describe('ScoutService.stream — cart resolution', () => {
  it('does NOT mint a cart for an anonymous turn', async () => {
    const store = new InMemoryCartStore();
    const carts = new CartService(store);
    const svc = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      new DeterministicScoutReplyModel(),
      carts,
      new InMemoryScoutSessionStore(),
    );
    let minted: string | null = null;
    const realSet = store.set.bind(store);
    store.set = async (cart) => {
      minted = cart.id;
      return realSet(cart);
    };

    await collect({ message: 'headphones' }, svc);
    expect(minted).toBeNull();
  });

  it('resolves a named cart so the reply model sees the real cart context', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const existing = await carts.getCart('cart-1');
    const seen: string[] = [];
    const model: ScoutReplyModel = {
      async generate(request) {
        seen.push(request.cart.id);
        return 'ok';
      },
    };
    const svc = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      model,
      carts,
      new InMemoryScoutSessionStore(),
    );

    await collect({ message: 'headphones', cartId: existing.id }, svc);
    expect(seen).toEqual(['cart-1']);
  });
});

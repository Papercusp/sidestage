import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import {
  InMemoryScoutMemoryStore,
  MIN_MEMORY_RELEVANCE,
  memoryScopes,
  memoryScore,
} from './scout-memory';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import {
  SCOUT_TOOL_GET_CART,
  SCOUT_TOOL_SEARCH_CATALOG,
  type ScoutIdentity,
  type ScoutMemory,
  type ScoutMemoryStore,
  type ScoutReplyRequest,
  type ScoutStreamEvent,
  type ScoutStreamRequest,
} from './scout.types';

/**
 * P-012: user-keyed long-term memory + the cart tool, on the streaming turn.
 *
 * These test the CONTRACT ported from Restart (scope-keyed recall, guest write
 * isolation, degrade-safe), not the storage mechanism — which is deliberately
 * different here (D-008: Postgres full-text, since this database has no
 * pgvector and no embedding provider).
 */

function service(
  opts: { memory?: ScoutMemoryStore; carts?: CartService; model?: DeterministicScoutReplyModel } = {},
) {
  return new ScoutService(
    scoutCatalogFrom(new FixtureCatalogSource()),
    opts.model ?? new DeterministicScoutReplyModel(),
    opts.carts ?? new CartService(new InMemoryCartStore()),
    opts.memory ?? new InMemoryScoutMemoryStore(),
    new InMemoryScoutSessionStore(),
  );
}

async function collect(
  svc: ScoutService,
  input: ScoutStreamRequest,
  identity?: ScoutIdentity,
): Promise<ScoutStreamEvent[]> {
  const events: ScoutStreamEvent[] = [];
  for await (const event of svc.stream(input, identity)) events.push(event);
  return events;
}

const toolsIn = (events: ScoutStreamEvent[]) =>
  events.filter((e) => e.type === 'tool_start').map((e) => (e as { tool: string }).tool);

const replyIn = (events: ScoutStreamEvent[]) =>
  events.filter((e) => e.type === 'token').map((e) => (e as { content: string }).content).join('');

/** Captures what the reply model was handed, to prove recall actually arrives. */
class SpyModel extends DeterministicScoutReplyModel {
  seen: ScoutReplyRequest[] = [];
  async generate(request: ScoutReplyRequest): Promise<string> {
    this.seen.push(request);
    return super.generate(request);
  }
}

describe('scout memory on a turn', () => {
  it('writes the buyer’s turn to their own scope, and recalls it on the next turn', async () => {
    const memory = new InMemoryScoutMemoryStore();
    const svc = service({ memory });
    const buyer: ScoutIdentity = { buyerId: 'buyer-1' };

    await collect(svc, { message: 'wireless headphones' }, buyer);

    const recalled = await memory.recall(memoryScopes('buyer-1').scopes, 'wireless headphones');
    expect(recalled.map((m) => m.text)).toContain('wireless headphones');
    expect(recalled[0].scope).toBe('user:buyer-1');
    expect(recalled[0].kind).toBe('turn');
  });

  it('hands recalled memories to the reply model', async () => {
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('user:buyer-1', 'wireless headphones for running', 'turn');
    const model = new SpyModel();
    const svc = service({ memory, model });

    const events = await collect(svc, { message: 'wireless headphones' }, { buyerId: 'buyer-1' });

    expect(model.seen[0].memories?.map((m: ScoutMemory) => m.text)).toContain(
      'wireless headphones for running',
    );
    // The admitted enhancement context must not starve an independently
    // satisfiable catalog request. This assertion binds the buyer-visible
    // product set as well as the memory hand-off above.
    expect(events.some((event) => event.type === 'products' && event.products.length > 0)).toBe(true);
  });

  it('surfaces a recalled memory in the streamed reply', async () => {
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('user:buyer-1', 'wireless headphones for running', 'turn');
    const svc = service({ memory });

    const events = await collect(svc, { message: 'wireless headphones' }, { buyerId: 'buyer-1' });
    expect(replyIn(events)).toContain('Last time you asked about');
  });

  /**
   * P-002 "reject low-relevance remembered turns" — the SERVICE-level floor.
   *
   * The two stores already drop a memory scoring 0, so the headline scenario
   * ("find me kettles" then "find me computers") is settled before the floor is
   * consulted: those two share only filler, so memoryScore is exactly 0 and the
   * store never returns the kettle turn at all. That makes any end-to-end
   * "reply must not mention kettles" assertion VACUOUS with respect to
   * MIN_MEMORY_RELEVANCE -- deleting safeRecall's filter left every suite green.
   *
   * The floor only earns its keep in the band the stores admit but it rejects:
   * 0 < score < MIN_MEMORY_RELEVANCE, i.e. a memory sharing SOME subject token
   * with the new turn but not enough of it. That band is what these two pin,
   * from both sides, so the constant cannot be deleted or drifted silently.
   */
  it('drops a remembered turn the store admits but that falls below the relevance floor', async () => {
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('user:buyer-1', 'red kettles', 'turn');
    const model = new SpyModel();
    const svc = service({ memory, model });
    const message = 'red suede running shoes';

    // Calibration: without this the assertion below passes for the wrong
    // reason. The STORE returns this memory (score > 0), so whatever drops it
    // downstream is the service floor and nothing else.
    const score = memoryScore('red kettles', message);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(MIN_MEMORY_RELEVANCE);
    expect(await memory.recall(memoryScopes('buyer-1').scopes, message)).toHaveLength(1);

    await collect(svc, { message }, { buyerId: 'buyer-1' });

    expect(model.seen[0].memories ?? []).toHaveLength(0);
  });

  it('still admits a remembered turn sitting exactly ON the relevance floor', async () => {
    // Pins `>=` rather than `>`: at the floor the memory is kept. Without this
    // the test above is satisfiable by rejecting every memory ever recalled.
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('user:buyer-1', 'red shoes', 'turn');
    const model = new SpyModel();
    const svc = service({ memory, model });
    const message = 'red boots';

    expect(memoryScore('red shoes', message)).toBe(MIN_MEMORY_RELEVANCE);

    await collect(svc, { message }, { buyerId: 'buyer-1' });

    expect(model.seen[0].memories?.map((m: ScoutMemory) => m.text)).toContain('red shoes');
  });

  it('does NOT leak one buyer’s memory into another buyer’s turn', async () => {
    const memory = new InMemoryScoutMemoryStore();
    const svc = service({ memory });

    await collect(svc, { message: 'wireless headphones' }, { buyerId: 'buyer-1' });

    const model = new SpyModel();
    const other = service({ memory, model });
    await collect(other, { message: 'wireless headphones' }, { buyerId: 'buyer-2' });

    expect(model.seen[0].memories).toEqual([]);
  });

  it('writes NOTHING for a guest — not even to the shared store scope', async () => {
    // The isolation rule: if guests wrote to `store`, every anonymous visitor's
    // turns would land in the bucket every other visitor recalls from.
    const memory = new InMemoryScoutMemoryStore();
    const svc = service({ memory });

    await collect(svc, { message: 'wireless headphones' }); // no identity
    await collect(svc, { message: 'wireless headphones' }, { buyerId: null });

    expect(await memory.recall(['store'], 'wireless headphones')).toEqual([]);
  });

  it('still lets a guest READ the shared store scope', async () => {
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('store', 'headphones ship free this week', 'fact');
    const model = new SpyModel();

    await collect(service({ memory, model }), { message: 'headphones' });

    expect(model.seen[0].memories?.map((m: ScoutMemory) => m.text)).toContain(
      'headphones ship free this week',
    );
  });

  it('never lets a failing memory store break the turn', async () => {
    // Memory is an enhancement layer, not a dependency. A store that throws on
    // BOTH halves must still yield a complete, correct turn.
    const exploding: ScoutMemoryStore = {
      async remember() {
        throw new Error('memory store down');
      },
      async recall(): Promise<ScoutMemory[]> {
        throw new Error('memory store down');
      },
    };
    const svc = service({ memory: exploding });

    const events = await collect(svc, { message: 'wireless headphones' }, { buyerId: 'buyer-1' });

    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(replyIn(events)).toContain('verified');
  });

  it('never lets a failing memory store break the non-streaming chat turn', async () => {
    const exploding: ScoutMemoryStore = {
      async remember() {
        throw new Error('memory store down');
      },
      async recall(): Promise<ScoutMemory[]> {
        throw new Error('memory store down');
      },
    };
    const response = await service({ memory: exploding }).chat(
      { message: 'wireless headphones' },
      { buyerId: 'buyer-1' },
    );
    expect(response.reply).toContain('verified');
  });

  it('defaults to guest when no identity is passed at all', async () => {
    const memory = new InMemoryScoutMemoryStore();
    await service({ memory }).chat({ message: 'wireless headphones' });
    expect(await memory.recall(['store'], 'wireless headphones')).toEqual([]);
  });
});

describe('the get_cart tool', () => {
  it('announces get_cart before search_catalog when the turn names a cart', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.getCart();
    const events = await collect(service({ carts }), {
      message: 'wireless headphones',
      cartId: cart.id,
    });

    const tools = toolsIn(events);
    expect(tools).toContain(SCOUT_TOOL_GET_CART);
    expect(tools.indexOf(SCOUT_TOOL_GET_CART)).toBeLessThan(
      tools.indexOf(SCOUT_TOOL_SEARCH_CATALOG),
    );
  });

  it('does NOT announce get_cart when no cart was named', async () => {
    // Announcing a tool that never ran puts a lie on the wire that the drawer
    // renders faithfully as a status line.
    const events = await collect(service(), { message: 'wireless headphones' });
    expect(toolsIn(events)).not.toContain(SCOUT_TOOL_GET_CART);
    expect(toolsIn(events)).toContain(SCOUT_TOOL_SEARCH_CATALOG);
  });

  it('gives the reply model the real cart contents', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.getCart();
    const model = new SpyModel();

    await collect(service({ carts, model }), {
      message: 'wireless headphones',
      cartId: cart.id,
    });

    expect(model.seen[0].cart.id).toBe(cart.id);
  });

  it('mints no cart for an anonymous turn', async () => {
    // getCart() persists a row when called without an id, so resolving
    // unconditionally would create a throwaway cart per anonymous chat turn.
    const store = new InMemoryCartStore();
    const model = new SpyModel();
    await collect(service({ carts: new CartService(store), model }), {
      message: 'wireless headphones',
    });
    expect(model.seen[0].cart.id).toBe('');
  });
});

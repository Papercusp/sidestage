import { describe, expect, it } from 'vitest';
import type {
  ScoutModelAdapter,
  ScoutModelRequest,
  ScoutModelResponse,
  ScoutModelStreamEvent,
} from '@papercusp/scout-runtime';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { InMemoryScoutMemoryStore } from './scout-memory';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import { SCOUT_TOOL_GET_CART, SCOUT_TOOL_SEARCH_CATALOG } from './scout.types';

class RecordingRuntimeModel implements ScoutModelAdapter {
  readonly model = 'recording-vertex-double';
  readonly calls: Array<{ tools: string[]; choice: string | undefined }> = [];

  async complete(request: ScoutModelRequest): Promise<ScoutModelResponse> {
    this.calls.push({
      tools: request.tools.map((tool) => tool.name),
      choice: request.toolChoice,
    });
    if (request.toolChoice === 'required') {
      const tool = request.tools[0];
      if (!tool) throw new Error('required tool missing');
      return {
        content: '',
        toolCalls: [{
          id: `call-${this.calls.length}`,
          name: tool.name,
          args: tool.name === SCOUT_TOOL_SEARCH_CATALOG
            ? { query: 'wireless headphones', limit: 3 }
            : {},
        }],
      };
    }
    return {
      content: '',
      toolCalls: [{
        id: `sticky-call-${this.calls.length}`,
        name: SCOUT_TOOL_SEARCH_CATALOG,
        args: { query: 'wireless headphones', limit: 3 },
      }],
    };
  }

  async *stream(): AsyncGenerator<ScoutModelStreamEvent> {
    yield { type: 'text', text: 'Vertex-backed ' };
    yield { type: 'text', text: 'answer' };
  }
}

describe('ScoutService shared runtime integration', () => {
  it('runs cart and catalog tools through the shared model loop without changing the wire contract', async () => {
    const sessions = new InMemoryScoutSessionStore();
    const model = new RecordingRuntimeModel();
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      new DeterministicScoutReplyModel(),
      new CartService(new InMemoryCartStore()),
      new InMemoryScoutMemoryStore(),
      sessions,
      model,
    );

    const cart = await service.chat({ message: 'prime cart', cartId: 'cart-1' });
    expect(cart.cartId).toBe('cart-1');

    const events = [];
    for await (const event of service.stream({
      message: 'wireless headphones',
      sessionId: 'runtime-session',
      cartId: 'cart-1',
      maxProducts: 3,
    }, { buyerId: 'buyer-runtime' })) {
      events.push(event);
    }

    const toolStarts = events
      .filter((event) => event.type === 'tool_start')
      .map((event) => event.type === 'tool_start' ? event.tool : '');
    expect(toolStarts).toEqual([SCOUT_TOOL_GET_CART, SCOUT_TOOL_SEARCH_CATALOG]);
    expect(events.some((event) => event.type === 'products' && event.products.length > 0)).toBe(true);
    expect(events.filter((event) => event.type === 'token').map((event) => (
      event.type === 'token' ? event.content : ''
    )).join('')).toBe('Vertex-backed answer');
    expect(events.at(-1)).toEqual({ type: 'done' });

    expect(model.calls.some((call) => (
      call.choice === 'required' && call.tools.join(',') === SCOUT_TOOL_GET_CART
    ))).toBe(true);
    expect(model.calls.some((call) => (
      call.choice === 'required' && call.tools.join(',') === SCOUT_TOOL_SEARCH_CATALOG
    ))).toBe(true);
    expect(model.calls.some((call) => call.choice === 'auto')).toBe(false);

    const transcript = await sessions.get('buyer-runtime', 'runtime-session');
    expect(transcript?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(transcript?.messages.at(-1)?.content).toBe('Vertex-backed answer');
  });
});

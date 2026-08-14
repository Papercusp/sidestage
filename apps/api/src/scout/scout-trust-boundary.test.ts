import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';
import { ScoutController } from './scout.controller';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { BUYER_COOKIE, CookieScoutIdentityResolver } from './scout-identity';
import { InMemoryScoutMemoryStore } from './scout-memory';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { ScoutTurnBusService } from './scout-turn-bus.service';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';

/**
 * D-009: the scout controller is SideStage's trust boundary for buyer identity.
 *
 * Restart establishes this in its `/api/scout` proxy (`body.userId = user?.id`
 * off a verified session); SideStage's API is the edge, so it happens here.
 * These tests pin the property that matters: a client-sent id NEVER reaches
 * memory, whatever the body says.
 *
 * ⚠ This proves the id cannot be taken from the BODY. It does not prove
 * authentication — today's cookie is unsigned, which D-009 records plainly.
 */
function harness() {
  const memory = new InMemoryScoutMemoryStore();
  const sessions = new InMemoryScoutSessionStore();
  const scout = new ScoutService(
    scoutCatalogFrom(new FixtureCatalogSource()),
    new DeterministicScoutReplyModel(),
    new CartService(new InMemoryCartStore()),
    memory,
    sessions,
  );
  const controller = new ScoutController(
    scout,
    new ScoutTurnBusService(),
    sessions,
    new CookieScoutIdentityResolver(),
  );
  return { controller, memory };
}

describe('scout identity trust boundary (D-009)', () => {
  it('ignores a forged buyerId in the chat body — nothing is written to that scope', async () => {
    const { controller, memory } = harness();

    await controller.chat({}, {
      message: 'wireless headphones',
      buyerId: 'victim',
    } as never);

    // The forged scope must hold nothing at all.
    expect(await memory.recall(['user:victim'], 'wireless headphones')).toEqual([]);
    // And the turn must not have leaked into the shared scope either.
    expect(await memory.recall(['store'], 'wireless headphones')).toEqual([]);
  });

  it('uses the COOKIE identity even when the body claims to be someone else', async () => {
    const { controller, memory } = harness();

    await controller.chat({ cookie: `${BUYER_COOKIE}=real-buyer` }, {
      message: 'wireless headphones',
      buyerId: 'victim',
    } as never);

    // Written under the server-resolved identity...
    const mine = await memory.recall(['user:real-buyer'], 'wireless headphones');
    expect(mine.map((m) => m.text)).toContain('wireless headphones');
    // ...and never under the one the client asserted.
    expect(await memory.recall(['user:victim'], 'wireless headphones')).toEqual([]);
  });

  it('cannot read another buyer’s memories by asserting their id in the body', async () => {
    const { controller, memory } = harness();
    await memory.remember('user:victim', 'my shipping address is 10 Elm Street', 'turn');

    const response = await controller.chat({}, {
      message: 'shipping address',
      buyerId: 'victim',
    } as never);

    expect(response.reply).not.toContain('Elm Street');
  });

  it('resolves a guest when no cookie is present', async () => {
    const { controller, memory } = harness();
    await controller.chat({}, { message: 'wireless headphones' });
    expect(await memory.recall(['store'], 'wireless headphones')).toEqual([]);
  });
});

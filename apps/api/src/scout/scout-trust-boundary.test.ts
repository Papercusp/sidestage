import { describe, expect, it, vi } from 'vitest';
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
  const turnBus = new ScoutTurnBusService();
  const controller = new ScoutController(
    scout,
    turnBus,
    sessions,
    new CookieScoutIdentityResolver(),
  );
  return { controller, memory, sessions, turnBus };
}

function responseDouble() {
  return {
    statusCode: 200,
    status: vi.fn(function status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
    }),
    setHeader: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  };
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

  it('returns the same not-found response for foreign, missing, and anonymous transcripts', async () => {
    const { controller, sessions } = harness();
    await sessions.append('buyer-a', 'session-a', [{
      role: 'user',
      content: 'private turn',
      ts: '2026-08-15T00:00:00.000Z',
    }]);

    const foreignRes = responseDouble();
    const missingRes = responseDouble();
    const guestRes = responseDouble();
    const foreign = await controller.sessionTranscript(
      'session-a',
      { cookie: `${BUYER_COOKIE}=buyer-b` },
      undefined,
      foreignRes,
    );
    const missing = await controller.sessionTranscript(
      'missing',
      { cookie: `${BUYER_COOKIE}=buyer-b` },
      undefined,
      missingRes,
    );
    const guest = await controller.sessionTranscript('session-a', {}, undefined, guestRes);

    expect(foreign).toEqual({ error: 'session not found' });
    expect(missing).toEqual(foreign);
    expect(guest).toEqual(foreign);
    expect([foreignRes.statusCode, missingRes.statusCode, guestRes.statusCode]).toEqual([404, 404, 404]);
  });

  it('rejects a foreign turn resume exactly like a missing turn', () => {
    const { controller, turnBus } = harness();
    const done = async function* () {
      yield { type: 'done' as const };
    };
    turnBus.run('turn-a', 'buyer-a', done());

    const request = (turnId: string) => ({
      headers: { cookie: `${BUYER_COOKIE}=buyer-b` },
      on: vi.fn(),
      turnId,
    });
    const foreignRes = responseDouble();
    const missingRes = responseDouble();
    const foreignReq = request('turn-a');
    const missingReq = request('turn-missing');

    controller.chatStream(foreignReq, foreignRes, { turnId: foreignReq.turnId });
    controller.chatStream(missingReq, missingRes, { turnId: missingReq.turnId });

    expect(foreignRes.statusCode).toBe(404);
    expect(missingRes.statusCode).toBe(404);
    expect(foreignRes.setHeader.mock.calls).toEqual(missingRes.setHeader.mock.calls);
    expect(foreignRes.end).toHaveBeenCalledOnce();
    expect(missingRes.end).toHaveBeenCalledOnce();
  });
});

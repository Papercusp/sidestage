import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { DEFAULT_DATABASE_URL } from '../db/database.module';
import { PgEventStore } from '../db/pg-event-store';
import { EventController } from '../events/event.controller';
import { EventService, InMemoryEventStore } from '../events/event.service';
import type { PolicyService } from '../policies/policy.service';
import type { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { EventConfigController } from './event-config.controller';
import { EventConfigSyncQueries } from './event-config.module';
import {
  EventConfigService,
  InMemoryEventConfigStore,
  PgEventConfigStore,
} from './event-config.service';

/**
 * The regression test for EI-20426845001666103 (P-014): the seller create flow
 * PUTs /events/:id/config, and before the fix NOTHING on that path wrote the
 * event-directory row — the created event was reachable by direct link but
 * never appeared in the buyer Channel Guide (GET /events stayed []).
 *
 * This exercises the real controller objects end to end over the in-memory
 * stores: one config PUT, then the collection read the buyer client calls.
 */
describe('create → GET /events (EI-20426845001666103 / P-014)', () => {
  function build() {
    const events = new EventService(new InMemoryEventStore([]), new ChatService());
    const invalidated: Array<{
      name: string;
      args?: Record<string, unknown>;
      context?: { principal?: string | null };
    }> = [];
    const controller = new EventConfigController(
      new EventConfigService(new InMemoryEventConfigStore()),
      { effectiveCopilotPolicy: async () => null } as unknown as PolicyService,
      {
        invalidate: (
          name: string,
          args?: Record<string, unknown>,
          context?: { principal?: string | null },
        ) => {
          invalidated.push({ name, args, context });
        },
      } as unknown as SyncInvalidationService,
      events,
    );
    return { events, controller, invalidated };
  }

  it('one config PUT makes the event appear in the buyer guide with its thumbnail', async () => {
    const { events, controller, invalidated } = build();

    await controller.put(
      'acceptance-dock-thumbnail-2026-08-14',
      {
        name: 'Acceptance dock thumbnail',
        thumbnailUrl: 'data:image/png;base64,AAAA',
      },
      'seller-acceptance',
      'Acceptance Studio',
    );

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]).toMatchObject({
      eventId: 'acceptance-dock-thumbnail-2026-08-14',
      title: 'Acceptance dock thumbnail',
      sellerId: 'seller-acceptance',
      sellerName: 'Acceptance Studio',
      status: 'scheduled',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    });
    expect(invalidated.map(({ name }) => name)).toEqual([
      'event.config',
      'event.lineup.items',
      'events.guide',
      'events.mine',
    ]);
    expect(invalidated).toEqual([
      {
        name: 'event.config',
        args: { eventId: 'acceptance-dock-thumbnail-2026-08-14' },
        context: { principal: 'seller-acceptance' },
      },
      {
        name: 'event.lineup.items',
        args: { eventId: 'acceptance-dock-thumbnail-2026-08-14' },
        context: undefined,
      },
      { name: 'events.guide', args: undefined, context: undefined },
      {
        name: 'events.mine',
        args: undefined,
        context: { principal: 'seller-acceptance' },
      },
    ]);
  });

  it('a follow-up rename PUT updates the guide row without duplicating it', async () => {
    const { events, controller } = build();

    await controller.put('my-drop', { name: 'My drop' }, 'seller-renamer', 'Rename Studio');
    await controller.put('my-drop', { name: 'My renamed drop' }, 'seller-renamer', 'Rename Studio');

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]?.title).toBe('My renamed drop');
  });

  it('publishes independently identified sellers together with their own display identities', async () => {
    const { events, controller } = build();

    await controller.put('alpha-drop', { name: 'Alpha drop' }, 'seller-alpha', 'Alpha Atelier');
    await controller.put('beta-drop', { name: 'Beta drop' }, 'seller-beta', 'Beta Bazaar');

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: 'alpha-drop',
        sellerId: 'seller-alpha',
        sellerName: 'Alpha Atelier',
      }),
      expect.objectContaining({
        eventId: 'beta-drop',
        sellerId: 'seller-beta',
        sellerName: 'Beta Bazaar',
      }),
    ]));
    await expect(events.listForSeller('seller-alpha')).resolves.toEqual([
      expect.objectContaining({ eventId: 'alpha-drop', sellerName: 'Alpha Atelier' }),
    ]);
    await expect(events.listForSeller('seller-beta')).resolves.toEqual([
      expect.objectContaining({ eventId: 'beta-drop', sellerName: 'Beta Bazaar' }),
    ]);
  });

  it('returns the same not-found response for a foreign and an absent config id', async () => {
    const { controller } = build();
    await controller.put('alpha-drop', { name: 'Alpha drop' }, 'seller-alpha', 'Alpha');

    const capture = async (eventId: string): Promise<NotFoundException> => {
      try {
        await controller.get(eventId, 'seller-beta');
        expect.unreachable('expected config read to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        return error as NotFoundException;
      }
    };

    const foreign = await capture('alpha-drop');
    const absent = await capture('missing-drop');
    expect(foreign.getResponse()).toEqual(absent.getResponse());
  });

  it('uses the request principal for event.config even when query args forge another seller', async () => {
    const events = new EventService(new InMemoryEventStore([{
      eventId: 'alpha-drop',
      title: 'Alpha drop',
      sellerId: 'seller-alpha',
      sellerName: 'Alpha',
      status: 'scheduled',
      startsAt: null,
      endedAt: null,
    }]), new ChatService());
    const configs = new EventConfigService(new InMemoryEventConfigStore());
    const prepared = await configs.prepare('alpha-drop', { name: 'Alpha settings' }, 'seller-alpha');
    await configs.persistOwned(prepared, 'seller-alpha');
    const queries = new SyncQueryRegistry();
    new EventConfigSyncQueries(
      configs,
      { effectiveCopilotPolicy: async () => null } as unknown as PolicyService,
      events,
      queries,
    ).onModuleInit();

    await expect(queries.resolve(
      'event.config',
      { eventId: 'alpha-drop', sellerId: 'seller-beta' },
      { principal: 'seller-alpha' },
    )).resolves.toEqual([
      expect.objectContaining({ eventId: 'alpha-drop', name: 'Alpha settings' }),
    ]);
    await expect(queries.resolve(
      'event.config',
      { eventId: 'alpha-drop', sellerId: 'seller-alpha' },
      { principal: 'seller-beta' },
    )).rejects.toThrow('Event not found for this seller.');
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')(
  'EventConfigController against the real event_config FK (P-003)',
  () => {
    it('creates the event owner before event_config and never transfers it on a foreign retry', async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
        max: 2,
      });
      const suffix = randomUUID();
      const eventId = `p003-fk-${suffix}`;
      const sellerId = `seller-alpha-${suffix}`;
      const events = new EventService(new PgEventStore(pool), new ChatService());
      const configs = new EventConfigService(new PgEventConfigStore(pool));
      const controller = new EventConfigController(
        configs,
        { effectiveCopilotPolicy: async () => null } as unknown as PolicyService,
        { invalidate: () => undefined } as unknown as SyncInvalidationService,
        events,
      );

      try {
        const constraint = await pool.query<{ conname: string }>(
          "SELECT conname FROM pg_constraint WHERE conname = 'event_config_event_fk'",
        );
        expect(constraint.rows).toEqual([{ conname: 'event_config_event_fk' }]);

        await expect(controller.put(
          eventId,
          { name: 'FK-safe creation' },
          sellerId,
          'Alpha Studio',
        )).resolves.toMatchObject({ eventId, name: 'FK-safe creation' });

        const created = await pool.query<{
          seller_id: string;
          title: string;
          payload: { name: string };
        }>(
          `SELECT owner.seller_id, owner.title, config.payload
             FROM event AS owner
             JOIN event_config AS config ON config.event_id = owner.event_id
            WHERE owner.event_id = $1`,
          [eventId],
        );
        expect(created.rows).toEqual([{
          seller_id: sellerId,
          title: 'FK-safe creation',
          payload: expect.objectContaining({ name: 'FK-safe creation' }),
        }]);

        await expect(controller.put(
          eventId,
          { name: 'Foreign overwrite' },
          `seller-beta-${suffix}`,
          'Beta Studio',
        )).rejects.toThrow('Event not found for this seller.');

        await expect(events.findById(eventId)).resolves.toMatchObject({
          sellerId,
          title: 'FK-safe creation',
        });
        await expect(configs.get(eventId, sellerId)).resolves.toMatchObject({
          name: 'FK-safe creation',
        });
      } finally {
        await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
        await pool.end();
      }
    });
  },
);

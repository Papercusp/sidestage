import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { EventSyncQueries, eventStoreForPool } from './event.module';
import {
  compareForGuide,
  compareForSeller,
  demoEventRecords,
  EventService,
  InMemoryEventStore,
  UnavailableEventStore,
  guideWithholdReason,
  isEventStatus,
  statusRank,
  type EventRecord,
  type EventSummary,
} from './event.service';

function record(overrides: Partial<EventRecord> & Pick<EventRecord, 'eventId'>): EventRecord {
  return {
    title: overrides.eventId,
    sellerId: 'seller-x',
    sellerName: 'Seller X',
    status: 'live',
    startsAt: null,
    endedAt: null,
    ...overrides,
  };
}

function summary(overrides: Partial<EventSummary> & Pick<EventSummary, 'eventId'>): EventSummary {
  return { ...record(overrides), viewers: 0, playbackUrl: null, ...overrides };
}

/**
 * Fixture-backed store for the ordering/projection tests below, whose subject
 * is EventService — not the store.
 *
 * EXTENDS InMemoryEventStore instead of re-implementing EventStore, so widening
 * the store contract cannot strand this double. Hand-listing the interface here
 * has now broken the whole API typecheck THREE times, each from an unrelated
 * lane: WI-38989 (listBySeller), WI-39072 (findById/findOwned), and again on
 * applyLifecycle/activateDueScheduled. Every one of those methods was
 * re-implemented here identically to the in-memory backend, so the duplication
 * bought nothing and cost a red gate each time. Inheriting makes the default
 * "whatever the maintained in-memory backend does", which is the correct
 * default for this double and is strand-proof by construction.
 *
 * The two mutators stay overridden as loud throws: these tests deliberately do
 * not exercise the write path, and a silent no-op double would let a future
 * test assert against a write that never happened.
 */
class StubStore extends InMemoryEventStore {
  async publish(): Promise<boolean> {
    throw new Error('StubStore.publish is not under test here — use InMemoryEventStore');
  }
  async unpublish(): Promise<boolean> {
    throw new Error('StubStore.unpublish is not under test here — use InMemoryEventStore');
  }
}

describe('event directory (P-118 / D-019)', () => {
  it('registers the buyer directory as the events.guide named query', async () => {
    const service = new EventService(
      new StubStore([record({ eventId: 'live-room', status: 'live' })]),
      new ChatService(),
    );
    const queries = new SyncQueryRegistry();
    new EventSyncQueries(service, queries).onModuleInit();

    await expect(queries.resolve('events.guide', {})).resolves.toEqual([
      expect.objectContaining({ eventId: 'live-room', viewers: 0 }),
    ]);
  });

  it('serves the server-computed playback URL on guide rows (D-035)', async () => {
    const service = new EventService(
      new StubStore([record({ eventId: 'live-room', status: 'live' })]),
      new ChatService(),
    );
    process.env.MEDIAMTX_WHEP_URL = 'https://media.example.com';
    try {
      await expect(service.listForGuide()).resolves.toEqual([
        expect.objectContaining({
          eventId: 'live-room',
          playbackUrl: 'https://media.example.com/sidestage-live-room/whep',
        }),
      ]);
    } finally {
      delete process.env.MEDIAMTX_WHEP_URL;
    }
    // The unconfigured deployment answers null, not a guessed localhost.
    await expect(service.listForGuide()).resolves.toEqual([
      expect.objectContaining({ eventId: 'live-room', playbackUrl: null }),
    ]);
  });

  it('registers a seller-scoped events.mine query that includes drafts', async () => {
    const service = new EventService(
      new StubStore([
        record({ eventId: 'owned-draft', sellerId: 'seller-demo', status: 'draft' }),
        record({ eventId: 'owned-live', sellerId: 'seller-demo', status: 'live' }),
        record({ eventId: 'other-live', sellerId: 'seller-other', status: 'live' }),
      ]),
      new ChatService(),
    );
    const queries = new SyncQueryRegistry();
    new EventSyncQueries(service, queries).onModuleInit();

    await expect(queries.resolve(
      'events.mine',
      { sellerId: 'seller-other' },
      { principal: 'seller-demo' },
    )).resolves.toEqual([
      expect.objectContaining({ eventId: 'owned-live', status: 'live' }),
      expect.objectContaining({ eventId: 'owned-draft', status: 'draft' }),
    ]);
    await expect(queries.resolve(
      'events.mine',
      {},
      { principal: 'seller-other' },
    )).resolves.toEqual([
      expect.objectContaining({ eventId: 'other-live', sellerId: 'seller-other' }),
    ]);
    await expect(queries.resolve('events.mine', {})).rejects.toThrow(
      'x-demo-principal is required for events.mine',
    );
  });

  it('groups live before upcoming before ended', () => {
    expect(statusRank('live')).toBeLessThan(statusRank('scheduled'));
    expect(statusRank('scheduled')).toBeLessThan(statusRank('ended'));
  });

  it('rejects a status outside the known set', () => {
    expect(isEventStatus('live')).toBe(true);
    expect(isEventStatus('draft')).toBe(true);
    expect(isEventStatus('archived')).toBe(false);
    expect(isEventStatus(undefined)).toBe(false);
  });

  it('never exposes a draft event to buyers', async () => {
    const store = new StubStore([
      record({ eventId: 'published', status: 'live' }),
      record({ eventId: 'secret', status: 'draft' }),
    ]);
    const service = new EventService(store, new ChatService());

    const events = await service.listForGuide();

    expect(events.map((event) => event.eventId)).toEqual(['published']);
  });

  it('never exposes the retired placeholder seller NAME to buyers', async () => {
    const service = new EventService(new StubStore([
      record({ eventId: 'real', sellerId: 'seller-studio-27', sellerName: 'Studio 27' }),
      record({ eventId: 'dummy-name', sellerId: 'seller-old', sellerName: 'SideStage Seller' }),
    ]), new ChatService());

    await expect(service.listForGuide()).resolves.toEqual([
      expect.objectContaining({ eventId: 'real', sellerName: 'Studio 27' }),
    ]);
    expect(guideWithholdReason({ sellerName: ' sidestage seller ' }))
      .toBe('retired-placeholder-seller-name');
    expect(guideWithholdReason({ sellerName: 'Studio 27' })).toBeNull();
  });

  /**
   * WI-39723. The buyer guide used to drop every row owned by `demo-seller`,
   * which reads like a fixture fence and is not one: `readDemoIdentity(...,
   * 'seller')` resolves EVERY anonymous or minted Studio session to exactly
   * that principal, so the default Studio session was the one whose events
   * could never reach a buyer. Owner-reported as "events I take live never
   * appear in the left rail", with a 200 on every call that produced them.
   *
   * Pinned as its own test because the deleted clause is the kind that gets
   * re-added by someone reading `demo-seller` as obviously-not-real.
   */
  it('shows a live event owned by the anonymous demo-seller principal to buyers', async () => {
    const service = new EventService(new StubStore([
      record({ eventId: 'anon-live', sellerId: 'demo-seller', sellerName: 'demo-seller', status: 'live' }),
      record({ eventId: 'anon-soon', sellerId: 'demo-seller', sellerName: 'seller-1dd66ef5', status: 'scheduled' }),
    ]), new ChatService());

    await expect(service.listForGuide()).resolves.toEqual([
      expect.objectContaining({ eventId: 'anon-live' }),
      expect.objectContaining({ eventId: 'anon-soon' }),
    ]);
  });

  /**
   * The CLASS guard, not the instance guard: whatever the withholding rules
   * become, an event the seller is shown as buyer-visible must either appear in
   * the guide or carry a reason saying why it does not. Silence is the defect —
   * a seller staring at `status: live` while buyers see nothing, with no
   * explanation obtainable from any surface, is what WI-39723 actually was.
   */
  it('never withholds a buyer-visible event from the guide without reporting a reason', async () => {
    const rows = [
      record({ eventId: 'plain', sellerId: 'demo-seller', sellerName: 'demo-seller', status: 'live' }),
      record({ eventId: 'named', sellerId: 'seller-real', sellerName: 'Studio 27', status: 'scheduled' }),
      record({ eventId: 'legacy', sellerId: 'seller-old', sellerName: 'SideStage Seller', status: 'live' }),
      record({ eventId: 'unpublished', sellerId: 'demo-seller', sellerName: 'demo-seller', status: 'draft' }),
    ];
    const service = new EventService(new StubStore(rows), new ChatService());

    const guideIds = new Set((await service.listForGuide()).map((event) => event.eventId));

    for (const seller of new Set(rows.map((row) => row.sellerId))) {
      for (const owned of await service.listForSeller(seller)) {
        if (owned.status === 'draft') continue; // invisible for the ordinary reason
        const reported = owned.withheldFromGuide !== null;
        expect(
          guideIds.has(owned.eventId) || reported,
          `${owned.eventId} is ${owned.status} in the seller's directory but absent from the buyer `
          + 'guide with withheldFromGuide === null — a silent exclusion',
        ).toBe(true);
        // The converse: a reported withhold must actually be withheld, or the
        // seller is warned about a problem that does not exist.
        expect(guideIds.has(owned.eventId)).toBe(!reported);
      }
    }
  });

  it('reads viewer counts from live chat presence, not a stored column', async () => {
    const chat = new ChatService();
    chat.addMessage('busy-room', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'hello',
    });

    const service = new EventService(
      new StubStore([
        record({ eventId: 'busy-room', status: 'live' }),
        record({ eventId: 'quiet-room', status: 'live' }),
      ]),
      chat,
    );

    const events = await service.listForGuide();
    const busy = events.find((event) => event.eventId === 'busy-room');
    const quiet = events.find((event) => event.eventId === 'quiet-room');

    expect(busy?.viewers).toBeGreaterThan(0);
    expect(quiet?.viewers).toBe(0);
    // Presence-derived: the busier room sorts first within the live group.
    expect(events[0]?.eventId).toBe('busy-room');
  });

  it('reports zero viewers for an ended event even if presence lingers', async () => {
    const chat = new ChatService();
    chat.addMessage('old-room', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'still here',
    });

    const service = new EventService(
      new StubStore([record({ eventId: 'old-room', status: 'ended' })]),
      chat,
    );

    const [event] = await service.listForGuide();
    expect(event.viewers).toBe(0);
  });

  it('sorts upcoming by soonest start and ended by most recently finished', () => {
    const soon = summary({ eventId: 'soon', status: 'scheduled', startsAt: '2026-08-14T06:00:00.000Z' });
    const later = summary({ eventId: 'later', status: 'scheduled', startsAt: '2026-08-14T09:00:00.000Z' });
    expect([later, soon].sort(compareForGuide).map((e) => e.eventId)).toEqual(['soon', 'later']);

    const recent = summary({ eventId: 'recent', status: 'ended', endedAt: '2026-08-14T03:00:00.000Z' });
    const older = summary({ eventId: 'older', status: 'ended', endedAt: '2026-08-11T03:00:00.000Z' });
    expect([older, recent].sort(compareForGuide).map((e) => e.eventId)).toEqual(['recent', 'older']);
  });

  it('sorts a scheduled event with no start time after those that have one', () => {
    const dated = summary({ eventId: 'dated', status: 'scheduled', startsAt: '2026-08-14T06:00:00.000Z' });
    const undated = summary({ eventId: 'undated', status: 'scheduled', startsAt: null });
    expect([undated, dated].sort(compareForGuide).map((e) => e.eventId)).toEqual(['dated', 'undated']);
  });

  it('breaks ties on title so repeated reads return a stable order', () => {
    const b = summary({ eventId: 'b', title: 'Bravo', status: 'live', viewers: 5 });
    const a = summary({ eventId: 'a', title: 'Alpha', status: 'live', viewers: 5 });
    expect([b, a].sort(compareForGuide).map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('orders a seller workspace by live, scheduled, draft, then ended', () => {
    const events = [
      record({ eventId: 'ended', status: 'ended' }),
      record({ eventId: 'draft', status: 'draft' }),
      record({ eventId: 'scheduled', status: 'scheduled' }),
      record({ eventId: 'live', status: 'live' }),
    ];
    expect(events.sort(compareForSeller).map((event) => event.eventId)).toEqual([
      'live',
      'scheduled',
      'draft',
      'ended',
    ]);
  });

  it('serves a populated guide with no database behind it', async () => {
    const service = new EventService(new InMemoryEventStore(), new ChatService());
    const events = await service.listForGuide();

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.status === 'live')).toBe(true);
    expect(events.some((event) => event.status === 'scheduled')).toBe(true);
    expect(events.some((event) => event.status === 'ended')).toBe(true);
  });

  it('keeps the demo fallback relative to now, so "Up next" never rots into the past', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const upcoming = demoEventRecords(now).filter((event) => event.status === 'scheduled');

    expect(upcoming.length).toBeGreaterThan(0);
    for (const event of upcoming) {
      expect(Date.parse(event.startsAt as string)).toBeGreaterThan(now.getTime());
    }
  });
});

describe('event source selection', () => {
  it('seeds demo events only in development or explicit memory mode', () => {
    expect(eventStoreForPool(null, { NODE_ENV: 'development' })).toBeInstanceOf(InMemoryEventStore);
    expect(eventStoreForPool(null, { NODE_ENV: 'production', DATA_BACKEND: 'memory' }))
      .toBeInstanceOf(InMemoryEventStore);
  });

  it('rejects reads and writes instead of fabricating events when production storage is unavailable', async () => {
    const store = eventStoreForPool(null, { NODE_ENV: 'production', DATA_BACKEND: 'auto' });

    expect(store).toBeInstanceOf(UnavailableEventStore);
    await expect(store.listBuyerVisible()).rejects.toThrow('durable event storage is not connected');
    await expect(store.listBySeller('demo-seller')).rejects.toThrow('durable event storage is not connected');
    await expect(store.publish({
      eventId: 'synthetic-event',
      title: 'Synthetic event',
      sellerId: 'seller-test',
      sellerName: 'Test seller',
    })).rejects.toThrow('durable event storage is not connected');
  });
});

/**
 * Smoke: the no-infrastructure `npm run dev` path must actually SERVE the
 * documented demo event (WI-39266).
 *
 * This is deliberately end-to-end through the REAL wiring — the store the
 * factory picks when no pool exists, driven through the real EventService —
 * rather than a StubStore. Every prior regression here survived the unit
 * tests precisely because they asserted against a stub: the store selection
 * was green, `guideWithholdReason` was green, and `sunday-drop` was still
 * absent from the buyer guide in the running app.
 *
 * The documented reviewer path is `npm run dev` with no Docker, so a reviewer
 * cloning the repo sees whatever THIS store hands the guide.
 */
describe('documented demo event survives the no-infrastructure dev path (WI-39266)', () => {
  it('serves sunday-drop as a live guide entry when no pg pool exists', async () => {
    const store = eventStoreForPool(null, { NODE_ENV: 'development' });
    const service = new EventService(store, new ChatService());

    const guide = await service.listForGuide();
    const sundayDrop = guide.find((event) => event.eventId === 'sunday-drop');

    expect(sundayDrop).toBeDefined();
    expect(sundayDrop?.status).toBe('live');
  });

  it('does not withhold the demo seller, because its name is not the retired placeholder', () => {
    const sundayDrop = demoEventRecords().find((event) => event.eventId === 'sunday-drop');

    // The retired placeholder is the DISPLAY NAME 'sidestage seller', never the
    // `demo-seller` id — an anonymous Studio visitor legitimately resolves to
    // that id, so withholding on identity hid real sellers' live events.
    expect(sundayDrop).toBeDefined();
    expect(guideWithholdReason(sundayDrop as EventRecord)).toBeNull();
  });
});

describe('seller-created events reach the guide (EI-20426845001666103 / P-014)', () => {
  it('rejects the legacy placeholder identity instead of publishing dummy seller data', async () => {
    const service = new EventService(new InMemoryEventStore([]), new ChatService());

    await expect(service.publishFromConfig(
      { eventId: 'p002-buyer-loop', name: 'P002 Buyer Loop' },
      { sellerId: 'demo-seller', sellerName: 'SideStage Seller' },
    )).resolves.toBe(false);
    await expect(service.listForGuide()).resolves.toEqual([]);
  });

  /**
   * WI-39723 REVERSED THIS TEST'S EXPECTATION, deliberately.
   *
   * It used to assert that a generated demo persona's event stayed PRIVATE.
   * That was the bug wearing the clothes of a requirement: the generated demo
   * persona is not a fixture, it is what a real person gets the first time they
   * open Studio (buyer-identity.ts resolves any minted persona to
   * `demo-seller`), so "keep it private" meant "no first-time seller can ever
   * reach the guide".
   */
  it('lets a generated demo seller reach the guide, and stay there through go-live', async () => {
    const service = new EventService(new InMemoryEventStore([]), new ChatService());

    await expect(service.publishFromConfig(
      { eventId: 'generated-demo-event', name: 'Generated demo event' },
      { sellerId: 'demo-seller', sellerName: 'seller-1dd66ef5' },
    )).resolves.toBe(true);

    await expect(service.listForSeller('demo-seller')).resolves.toEqual([
      expect.objectContaining({
        eventId: 'generated-demo-event',
        sellerId: 'demo-seller',
        sellerName: 'seller-1dd66ef5',
        // Nothing is hiding it from buyers.
        withheldFromGuide: null,
      }),
    ]);
    await expect(service.listForGuide()).resolves.toEqual([
      expect.objectContaining({ eventId: 'generated-demo-event', status: 'scheduled' }),
    ]);

    const live = await service.transition('generated-demo-event', 'demo-seller', 'go-live');
    expect(live.outcome).toBe('applied');

    await expect(service.listForGuide()).resolves.toEqual([
      expect.objectContaining({ eventId: 'generated-demo-event', status: 'live' }),
    ]);
  });

  it('publishFromConfig makes a brand-new event buyer-visible with its thumbnail', async () => {
    const service = new EventService(new InMemoryEventStore([]), new ChatService());

    await service.publishFromConfig({
      eventId: 'acceptance-dock-thumbnail',
      name: 'Acceptance dock thumbnail',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    }, { sellerId: 'seller-acceptance', sellerName: 'Acceptance Studio' });

    const events = await service.listForGuide();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'acceptance-dock-thumbnail',
      title: 'Acceptance dock thumbnail',
      status: 'scheduled',
      sellerId: 'seller-acceptance',
      sellerName: 'Acceptance Studio',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    });
  });

  it('publishes without a thumbnail as a row with no thumbnailUrl key', async () => {
    const service = new EventService(new InMemoryEventStore([]), new ChatService());

    await service.publishFromConfig(
      { eventId: 'bare-event', name: 'Bare event' },
      { sellerId: 'seller-bare', sellerName: 'Bare Studio' },
    );

    const [event] = await service.listForGuide();
    expect(event.eventId).toBe('bare-event');
    expect('thumbnailUrl' in event).toBe(false);
  });

  it('re-publishing an existing event updates title/thumbnail but never resets its lifecycle', async () => {
    const store = new InMemoryEventStore([
      record({
        eventId: 'live-show',
        title: 'Old title',
        status: 'live',
        startsAt: '2026-08-14T10:00:00.000Z',
      }),
    ]);
    const service = new EventService(store, new ChatService());

    await service.publishFromConfig({
      eventId: 'live-show',
      name: 'New title',
      thumbnailUrl: 'https://example.com/t.png',
    }, { sellerId: 'seller-x', sellerName: 'Seller X' });

    const [event] = await service.listForGuide();
    expect(event.title).toBe('New title');
    expect(event.thumbnailUrl).toBe('https://example.com/t.png');
    // The lifecycle survives a config re-save: still live, start time kept.
    expect(event.status).toBe('live');
    expect(event.startsAt).toBe('2026-08-14T10:00:00.000Z');
  });

  it('rejects a colliding foreign publication without changing the established owner or content', async () => {
    const store = new InMemoryEventStore([
      record({
        eventId: 'owned-show',
        title: 'Original title',
        sellerId: 'seller-alpha',
        sellerName: 'Alpha',
        status: 'live',
      }),
    ]);
    const service = new EventService(store, new ChatService());

    await expect(service.publishFromConfig(
      { eventId: 'owned-show', name: 'Hijacked title' },
      { sellerId: 'seller-beta', sellerName: 'Beta' },
    )).resolves.toBe(false);

    await expect(service.findOwned('owned-show', 'seller-beta')).resolves.toBeUndefined();
    await expect(service.findOwned('owned-show', 'seller-alpha')).resolves.toMatchObject({
      title: 'Original title',
      sellerId: 'seller-alpha',
      sellerName: 'Alpha',
      status: 'live',
    });
  });

  it('withdraws only the owning seller\'s event and can publish the draft again', async () => {
    const store = new InMemoryEventStore([
      record({ eventId: 'release-probe', sellerId: 'seller-a', status: 'live' }),
    ]);
    const service = new EventService(store, new ChatService());

    await expect(service.unpublish('release-probe', 'seller-b')).resolves.toBe(false);
    await expect(service.unpublish('release-probe', 'seller-a')).resolves.toBe(true);
    await expect(service.listForGuide()).resolves.toEqual([]);

    await store.publish({
      eventId: 'release-probe',
      title: 'Re-published probe',
      sellerId: 'seller-a',
      sellerName: 'Seller A',
    });
    const [republished] = await service.listForGuide();
    expect(republished).toMatchObject({
      eventId: 'release-probe',
      title: 'Re-published probe',
      status: 'scheduled',
    });
  });
});

describe('durable event seed isolation (P-003)', () => {
  const demoSql = readFileSync(join(__dirname, '../../../../db/seed/demo.sql'), 'utf8');
  const eventSection = demoSql.slice(demoSql.indexOf('-- ── Event directory'));

  it('keeps showcase events in explicit memory mode but never inserts them into durable storage', () => {
    const fixtures = demoEventRecords(new Date('2026-08-14T12:00:00.000Z'));
    expect(fixtures).toHaveLength(8);
    expect(eventSection).not.toMatch(/INSERT\s+INTO\s+event\s*\(/i);
    for (const fixture of fixtures) {
      expect(eventSection).toContain(`'${fixture.eventId}'`);
    }
  });

  it('removes only legacy rows whose authored fixture identity and content still match', () => {
    expect(eventSection).toContain('DELETE FROM event AS stored');
    expect(eventSection).toContain('stored.seller_id = fixture.seller_id');
    expect(eventSection).toContain('stored.seller_name = fixture.seller_name');
    expect(eventSection).toContain('stored.title = fixture.title');
    expect(eventSection).toContain('stored.thumbnail_url IS NOT DISTINCT FROM fixture.thumbnail_url');
    expect(eventSection).not.toContain("'spring-preview-draft'");
  });
});

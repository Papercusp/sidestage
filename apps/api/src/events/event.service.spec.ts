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
  isEventStatus,
  statusRank,
  type EventRecord,
  type EventSummary,
  type EventStore,
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
  return { ...record(overrides), viewers: 0, ...overrides };
}

class StubStore implements EventStore {
  constructor(private readonly records: EventRecord[]) {}
  async listBuyerVisible(): Promise<EventRecord[]> {
    return this.records.filter((entry) => entry.status !== 'draft');
  }
  async listBySeller(sellerId: string): Promise<EventRecord[]> {
    return this.records.filter((entry) => entry.sellerId === sellerId);
  }
  async findById(eventId: string): Promise<EventRecord | undefined> {
    return this.records.find((entry) => entry.eventId === eventId);
  }
  async findOwned(eventId: string, sellerId: string): Promise<EventRecord | undefined> {
    return this.records.find(
      (entry) => entry.eventId === eventId && entry.sellerId === sellerId,
    );
  }
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

describe('seller-created events reach the guide (EI-20426845001666103 / P-014)', () => {
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

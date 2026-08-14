import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import {
  compareForGuide,
  demoEventRecords,
  EventService,
  InMemoryEventStore,
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
}

describe('event directory (P-118 / D-019)', () => {
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

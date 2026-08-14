import { describe, expect, it } from 'vitest';
import {
  eventManagerHref,
  getEventManagerRouteFromUrl,
  getStudioViewFromUrl,
  studioViewHref,
} from './app-routing';

describe('Studio URL routing', () => {
  it('defaults to Current event and accepts exactly three views', () => {
    expect(getStudioViewFromUrl('/?tab=seller')).toBe('active-event');
    expect(getStudioViewFromUrl('/?tab=seller&studio=event-manager')).toBe('event-manager');
    expect(getStudioViewFromUrl('/?tab=seller&studio=inventory')).toBe('inventory');
    expect(getStudioViewFromUrl('/?tab=seller&studio=unknown')).toBe('active-event');
  });
  it('preserves event state while addressing a Studio board', () => {
    expect(studioViewHref('event-manager', '/?tab=buyer&event=drop-7#stage')).toBe('/?tab=seller&event=drop-7&studio=event-manager#stage');
    expect(studioViewHref('inventory', '/?tab=buyer&event=drop-7#stage')).toBe('/?tab=seller&event=drop-7&studio=inventory#stage');
  });

  it('addresses Event Manager workspace and selected-event detail views', () => {
    expect(getEventManagerRouteFromUrl('/?tab=seller&studio=event-manager')).toEqual({
      view: 'events',
      section: 'lineup',
    });
    expect(getEventManagerRouteFromUrl(
      '/?tab=seller&studio=event-manager&manager=events&event=drop-7&section=settings',
    )).toEqual({ view: 'events', eventId: 'drop-7', section: 'settings' });
    expect(getEventManagerRouteFromUrl(
      '/?tab=seller&studio=event-manager&manager=events&event=drop-7&section=rehearse',
    )).toEqual({ view: 'events', eventId: 'drop-7', section: 'rehearse' });
    expect(getEventManagerRouteFromUrl('/?manager=create&event=stale&section=settings')).toEqual({
      view: 'create',
      eventId: 'stale',
      section: 'settings',
    });
    expect(eventManagerHref(
      { view: 'events', eventId: 'drop-7', section: 'settings' },
      '/?tab=buyer#stage',
    )).toBe('/?tab=seller&studio=event-manager&manager=events&event=drop-7&section=settings#stage');
    expect(eventManagerHref(
      { view: 'events', eventId: 'drop-7', section: 'rehearse' },
      '/?tab=buyer#stage',
    )).toBe('/?tab=seller&studio=event-manager&manager=events&event=drop-7&section=rehearse#stage');
    expect(eventManagerHref(
      { view: 'create', section: 'lineup' },
      '/?tab=seller&studio=event-manager&event=drop-7&section=settings',
    )).toBe('/?tab=seller&studio=event-manager&manager=create');
  });
});

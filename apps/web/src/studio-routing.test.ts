import { describe, expect, it } from 'vitest';
import { getStudioViewFromUrl, studioViewHref } from './app-routing';

describe('Studio URL routing', () => {
  it('defaults to Active Event and accepts exactly two views', () => {
    expect(getStudioViewFromUrl('/?tab=seller')).toBe('active-event');
    expect(getStudioViewFromUrl('/?tab=seller&studio=event-manager')).toBe('event-manager');
    expect(getStudioViewFromUrl('/?tab=seller&studio=unknown')).toBe('active-event');
  });
  it('preserves event state while addressing a Studio board', () => {
    expect(studioViewHref('event-manager', '/?tab=buyer&event=drop-7#stage')).toBe('/?tab=seller&event=drop-7&studio=event-manager#stage');
  });
});


import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GuideEvent } from './api';
import { ChannelGuide } from './ChannelGuide';

const NOW = new Date('2026-08-14T12:00:00.000Z');

const EVENTS: GuideEvent[] = [
  {
    eventId: 'sunday-drop',
    title: 'Sunday vintage drop',
    sellerId: 'seller-marsh',
    sellerName: 'Marsh & Co Vintage',
    status: 'live',
    startsAt: '2026-08-14T11:25:00.000Z',
    endedAt: null,
    viewers: 3,
  },
  {
    eventId: 'tuesday-tool-run',
    title: 'Tuesday tool run',
    sellerId: 'seller-ironbark',
    sellerName: 'Ironbark Supply',
    status: 'scheduled',
    startsAt: '2026-08-14T14:00:00.000Z',
    endedAt: null,
    viewers: 0,
  },
  {
    eventId: 'friday-flash-audio',
    title: 'Friday flash: hi-fi audio',
    sellerId: 'seller-northstar',
    sellerName: 'Northstar Audio',
    status: 'ended',
    startsAt: '2026-08-13T17:00:00.000Z',
    endedAt: '2026-08-13T18:00:00.000Z',
    viewers: 0,
  },
];

function render(props: Partial<React.ComponentProps<typeof ChannelGuide>> = {}) {
  return renderToStaticMarkup(
    <ChannelGuide
      events={EVENTS}
      currentEventId="sunday-drop"
      onSelect={() => {}}
      now={NOW}
      {...props}
    />,
  );
}

describe('ChannelGuide (P-118 / D-019)', () => {
  it('always renders as the buyer layout\'s What\'s on sidebar', () => {
    const markup = render({ events: [] });
    expect(markup).toContain('<aside');
    expect(markup).toContain('class="channel-guide-panel"');
    expect(markup).toContain('aria-labelledby="channel-guide-title"');
  });

  it('groups events under the three headings the owner picked', () => {
    const markup = render();
    expect(markup).toContain('Live now');
    expect(markup).toContain('Up next');
    expect(markup).toContain('Ended');
    // Group order: live before upcoming before ended.
    expect(markup.indexOf('Live now')).toBeLessThan(markup.indexOf('Up next'));
    expect(markup.indexOf('Up next')).toBeLessThan(markup.indexOf('Ended'));
  });

  it('shows every seller, not just the current one', () => {
    const markup = render();
    expect(markup).toContain('Marsh &amp; Co Vintage');
    expect(markup).toContain('Ironbark Supply');
    expect(markup).toContain('Northstar Audio');
  });

  it('labels each row by its group: viewers, countdown, or age', () => {
    const markup = render();
    expect(markup).toContain('3 watching');
    expect(markup).toContain('Starts in 2h');
    expect(markup).toContain('Ended 18h ago');
  });

  it('check-marks the event currently being watched', () => {
    const markup = render();
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('Currently watching');
    expect(markup).toContain('is-current');
    // Exactly one row is current.
    expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('marks a different row current when the buyer switches event', () => {
    const markup = render({ currentEventId: 'tuesday-tool-run' });
    const currentIndex = markup.indexOf('aria-current="true"');
    expect(currentIndex).toBeGreaterThan(-1);
    // The check sits inside the Up next group, after that heading.
    expect(markup.indexOf('Up next')).toBeLessThan(currentIndex);
  });

  it('says the guide could not be read instead of claiming nothing is on', () => {
    const markup = render({ events: [], error: 'Could not load the event guide.' });
    expect(markup).toContain('Could not load the event guide.');
    expect(markup).not.toContain('No events scheduled yet.');
  });

  it('distinguishes loading from a genuinely empty directory', () => {
    expect(render({ events: [], loading: true })).toContain('Loading events…');
    const empty = render({ events: [], loading: false });
    expect(empty).toContain('No events scheduled yet.');
    expect(empty).not.toContain('Loading events…');
  });

  it('is a complementary landmark rather than a modal dialog', () => {
    const markup = render();
    expect(markup).toContain('<aside');
    expect(markup).toContain('id="channel-guide-title"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('aria-modal="true"');
  });

  it('carries no hard-coded colour — every colour comes from an R3 token', () => {
    // D-019 requires the guide to adopt the retheme tokens. A hex literal in
    // the rendered markup would mean a colour that survives a palette change.
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

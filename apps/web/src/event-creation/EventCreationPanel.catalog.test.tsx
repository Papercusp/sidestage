import { readFileSync } from 'node:fs';

import { SyncContext } from '@papercusp/sync';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { EventCreationPanel } from './EventCreationPanel';

const eventCreationCss = readFileSync(new URL('./event-creation.css', import.meta.url), 'utf8');

describe('EventCreationPanel catalog source loss', () => {
  it('renders an honest production alert and no demo inventory', () => {
    const useDataImpl = vi.fn(() => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: new Error('catalog unavailable'),
    }));

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventCreationPanel allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Catalog unavailable. No inventory is shown');
    expect(html).toContain('0 of 0 catalog items');
    expect(html).toContain('class="event-creation-toolbar"');
    expect(html.indexOf('class="event-creation-toolbar"')).toBeLessThan(
      html.indexOf('class="event-catalog-grid'),
    );
    expect(html.match(/Create event/g)).toHaveLength(1);
    expect(html).not.toContain('demo-espresso-matte-black');
    expect(html).not.toContain('offline fixture');
  });

  it('contains the sticky toolbar inside a phone-width seller dock', () => {
    const mobileCss = eventCreationCss.match(/@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/)?.[1] ?? '';

    expect(mobileCss).toMatch(
      /\.event-creation\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar-action\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar \.button\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
  });
});

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  App,
  appLayoutForTab,
  eventWatchHref,
  getTabFromUrl,
  TAB_GROUPS,
  tabHref,
  SystemTestsTab,
  variantToSellerProduct,
} from './App';
import { OFFLINE_FIXTURE } from './catalog';
import { ProductCard } from './components/ProductCard';

const stylesCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('SideStage tab state', () => {
  it('defaults to Buyer and accepts query or path URL state', () => {
    expect(getTabFromUrl('/')).toBe('buyer');
    expect(getTabFromUrl('/?tab=seller')).toBe('seller');
    expect(getTabFromUrl('/?tab=orders')).toBe('orders');
    expect(getTabFromUrl('/?tab=history')).toBe('history');
    expect(getTabFromUrl('/config')).toBe('seller');
    expect(getTabFromUrl('/?tab=config')).toBe('seller');
    expect(getTabFromUrl('/?tab=test')).toBe('test');
    expect(getTabFromUrl('/?tab=unknown')).toBe('buyer');
  });

  it('preserves the current route while writing the selected tab', () => {
    expect(tabHref('test', '/events?source=demo#ready')).toBe('/events?source=demo&tab=test#ready');
    expect(tabHref('config', '/events?source=demo')).toBe('/events?source=demo&tab=seller');
  });

  it('builds durable Watch links for guide events without dropping URL state', () => {
    expect(eventWatchHref('spring-room', '/events?source=demo#ready')).toBe(
      '/events?source=demo&tab=buyer&event=spring-room#ready',
    );
  });
});

describe('P-005 product card and shell', () => {
  it('renders reusable product data with a stage action', () => {
    const product = variantToSellerProduct(OFFLINE_FIXTURE[0], 0);
    const markup = renderToStaticMarkup(<ProductCard {...product} onSelect={() => undefined} />);
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(markup).toContain('Add to stage');
    expect(markup).toContain('data-product-id="demo-espresso-matte-black"');
  });

  it('renders the approved buyer and operator navigation groups in the app shell', () => {
    const markup = renderToStaticMarkup(<App />);
    expect(TAB_GROUPS.map((group) => group.tabs.map((tab) => tab.id))).toEqual([
      ['buyer', 'orders'],
      ['seller', 'history', 'test'],
    ]);
    for (const tab of ['Watch', 'Orders', 'Studio', 'Releases', 'Tests']) {
      expect(markup).toContain(`>${tab}</a>`);
    }
    expect(markup).not.toContain('>Settings</a>');
    expect(markup).not.toContain('>Rehearse</a>');
    expect(markup).toContain('aria-label="Buyer work"');
    expect(markup).toContain('aria-label="Operator work"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('Live commerce');
    expect(markup.match(/Demo user impersonation/g)).toHaveLength(1);
    expect(markup).toContain('id="global-demo-user-id"');
    expect(markup).not.toContain('Seller demo user');
    expect(markup.indexOf('data-platform="android"')).toBeLessThan(markup.indexOf('Demo user impersonation'));
    expect(markup.match(/class="button secondary topbar-held-items"/g)).toHaveLength(1);
    expect(markup).not.toContain('buyer-held-items-button');
    expect(markup.indexOf('Held items')).toBeLessThan(markup.indexOf('Ready for your next event'));
    expect(markup).toContain('Now selling');
    expect(markup).toContain('Event products');
    expect(markup).toContain('Live chat');
    expect(markup).toContain('Message the room');
    expect(markup).toContain('Share room');
    expect(markup).toContain('class="app-site-column"');
    expect(markup).toContain('class="channel-guide-panel"');
    expect(markup.indexOf('class="channel-guide-panel"')).toBeLessThan(markup.indexOf('class="topbar"'));
    expect(markup.indexOf('class="channel-guide-panel"')).toBeLessThan(markup.indexOf('id="buyer"'));
  });

  it('keeps the shared paper shell and keyboard-control baseline tokenized', () => {
    expect(stylesCss).toMatch(/--content-max:\s*80rem/);
    expect(stylesCss).toMatch(/\.topbar-inner\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    expect(stylesCss).toMatch(/\.nav-cluster\s*\{[^}]*background:\s*color-mix\(/);
    expect(stylesCss).toMatch(/\.button\s*\{[^}]*min-height:\s*2\.5rem/);
    expect(stylesCss).toMatch(/:where\(a, button, input, select, textarea\):focus-visible/);
    expect(stylesCss).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*var\(--channel-guide-width\) minmax\(0, 1fr\)/);
    expect(stylesCss).toMatch(/\.app-site-column\s*\{[^}]*min-width:\s*0/);
    expect(stylesCss).toMatch(
      /@media \(min-width: 761px\) and \(max-width: 1399px\)[\s\S]*?\.topbar-brand-group\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*grid-row:\s*1/,
    );
    expect(stylesCss).toMatch(
      /@media \(min-width: 761px\) and \(max-width: 1399px\)[\s\S]*?\.tab-nav\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*2[^}]*overflow-x:\s*auto/,
    );
    expect(stylesCss).toMatch(
      /@media \(min-width: 761px\) and \(max-width: 1399px\)[\s\S]*?\.topbar-status-group\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2/,
    );
    expect(stylesCss).toMatch(/@media \(max-width: 600px\)\s*\{\s*\.app-shell\s*\{[^}]*--channel-guide-width:\s*10rem/);
  });
});

describe('Seller workbench shell', () => {
  it('gives only Seller the edge-to-edge shell and removes its page footer', () => {
    expect(appLayoutForTab('seller')).toEqual({
      shellClassName: 'app-shell app-shell--seller',
      contentClassName: 'content content-seller',
      showFooter: false,
      showBuyerScout: false,
    });

    expect(appLayoutForTab('buyer')).toEqual({
      shellClassName: 'app-shell',
      contentClassName: 'content',
      showFooter: true,
      showBuyerScout: true,
    });

    expect(appLayoutForTab('orders').showBuyerScout).toBe(true);
    expect(appLayoutForTab('history').showBuyerScout).toBe(false);
    expect(appLayoutForTab('test').showBuyerScout).toBe(false);
  });
});

describe('system Tests tab', () => {
  it('renders deterministic controls and keeps every suite away from live commerce data', () => {
    const markup = renderToStaticMarkup(<SystemTestsTab />);

    expect(markup).toContain('Pressure-test the copilot seam.');
    expect(markup).toContain('Simulated users');
    expect(markup).toContain('Messages / user / sec');
    expect(markup).toContain('Duration (seconds)');
    expect(markup).toContain('Run load simulation');
    expect(markup).toContain('No live room is joined and no buyer receives a message.');
    expect(markup).toContain('Reply judge');
    expect(markup).toContain('Grade generated replies in isolation.');
    expect(markup).toContain('Run reply judge');
    expect(markup).toContain('No reply is sent to a buyer.');
  });
});

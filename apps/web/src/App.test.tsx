import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, DEMO_PRODUCTS, getTabFromUrl, tabHref, TestTab } from './App';
import { ProductCard } from './components/ProductCard';

describe('SideStage tab state', () => {
  it('defaults to Buyer and accepts query or path URL state', () => {
    expect(getTabFromUrl('/')).toBe('buyer');
    expect(getTabFromUrl('/?tab=seller')).toBe('seller');
    expect(getTabFromUrl('/config')).toBe('config');
    expect(getTabFromUrl('/?tab=unknown')).toBe('buyer');
  });

  it('preserves the current route while writing the selected tab', () => {
    expect(tabHref('test', '/events?source=demo#ready')).toBe('/events?source=demo&tab=test#ready');
  });
});

describe('P-005 product card and shell', () => {
  it('renders reusable product data with a stage action', () => {
    const markup = renderToStaticMarkup(<ProductCard {...DEMO_PRODUCTS[0]} onSelect={() => undefined} />);
    expect(markup).toContain('Aurora ceramic cup');
    expect(markup).toContain('Add to stage');
    expect(markup).toContain('data-product-id="aurora-cup"');
  });

  it('renders all four tab destinations in the app shell', () => {
    const markup = renderToStaticMarkup(<App />);
    for (const tab of ['Buyer', 'Seller', 'Config', 'Test']) {
      expect(markup).toContain(`>${tab}</a>`);
    }
    expect(markup).toContain('Join the room');
    expect(markup).toContain('Event products');
    expect(markup).toContain('Live chat');
    expect(markup).toContain('Message the room');
    expect(markup).toContain('Share event');
  });
});

describe('P-022 load simulator tab', () => {
  it('renders deterministic load controls and keeps the rehearsal local', () => {
    const markup = renderToStaticMarkup(<TestTab />);

    expect(markup).toContain('Pressure-test the copilot seam.');
    expect(markup).toContain('Simulated users');
    expect(markup).toContain('Messages / user / sec');
    expect(markup).toContain('Duration (seconds)');
    expect(markup).toContain('Run load rehearsal');
    expect(markup).toContain('without sending anything to buyers');
    expect(markup).toContain('Reply judge');
    expect(markup).toContain('Grade the copilot before buyers do.');
    expect(markup).toContain('Run judge rehearsal');
    expect(markup).toContain('same grounding, policy, price, and tone seam');
  });
});

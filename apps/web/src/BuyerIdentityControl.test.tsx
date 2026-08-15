import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuyerIdentityControl, DemoIdentityControl } from './BuyerIdentityControl';

const identityCss = readFileSync(new URL('./buyer-identity.css', import.meta.url), 'utf8');

describe('DemoIdentityControl', () => {
  it('renders the shared seller switcher with a unique control id', () => {
    const markup = renderToStaticMarkup(
      <DemoIdentityControl
        userId="seller-baf59833"
        onImpersonate={() => undefined}
        inputId="seller-demo-user-id"
        label="Seller demo user"
      />,
    );

    expect(markup).toContain('Seller demo user');
    expect(markup).toContain('id="seller-demo-user-id"');
    expect(markup).toContain('<strong title="baf59833">baf59833</strong>');
    expect(markup).toContain('value="baf59833"');
    expect(markup).not.toContain('seller-baf59833');
    expect(markup).toContain('Enter any user id');
    expect(markup).not.toContain('Demo only — any non-empty id, no password.');
    expect(markup).toContain('class="button primary"');
    expect(markup).toContain('>Switch</button>');
  });

  it('preserves the buyer compatibility wrapper', () => {
    const markup = renderToStaticMarkup(
      <BuyerIdentityControl buyerId="buyer-baf59833" onImpersonate={() => undefined} />,
    );

    expect(markup).toContain('Demo user');
    expect(markup).toContain('id="buyer-demo-user-id"');
    expect(markup).toContain('value="baf59833"');
    expect(markup).not.toContain('buyer-baf59833');
  });

  it('lets the shared identity grid shrink inside a narrow shell column', () => {
    expect(identityCss).toMatch(/\.demo-identity\s*\{[^}]*width:\s*min\(20rem, 100%\);[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-heading\s*\{[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-heading strong\s*\{[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-row\s*\{[^}]*min-width:\s*0;/s);
  });

  it('gives the demo switcher an unmistakable high-contrast treatment', () => {
    expect(identityCss).toMatch(
      /\.demo-identity\s*\{[^}]*border:\s*2px solid var\(--brand-red\);[^}]*background:\s*var\(--brand-yellow\);[^}]*box-shadow:/s,
    );
    expect(identityCss).toMatch(
      /\.demo-identity-heading > span\s*\{[^}]*color:\s*var\(--on-brand-red\);[^}]*background:\s*var\(--brand-red\);/s,
    );
    expect(identityCss).toMatch(
      /\.demo-identity-row input\s*\{[^}]*min-height:\s*2\.65rem;[^}]*border:\s*2px solid var\(--brand-red-active\);[^}]*font-weight:\s*720;/s,
    );
    expect(identityCss).toMatch(
      /\.demo-identity-row \.button\s*\{[^}]*min-height:\s*2\.65rem;[^}]*font-weight:\s*900;/s,
    );
  });
});

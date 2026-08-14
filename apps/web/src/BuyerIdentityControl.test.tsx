import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuyerIdentityControl, DemoIdentityControl } from './BuyerIdentityControl';

const identityCss = readFileSync(new URL('./buyer-identity.css', import.meta.url), 'utf8');

describe('DemoIdentityControl', () => {
  it('renders the shared seller switcher with a unique control id', () => {
    const markup = renderToStaticMarkup(
      <DemoIdentityControl
        userId="demo-seller-27"
        onImpersonate={() => undefined}
        inputId="seller-demo-user-id"
        label="Seller demo user"
      />,
    );

    expect(markup).toContain('Seller demo user');
    expect(markup).toContain('id="seller-demo-user-id"');
    expect(markup).toContain('value="demo-seller-27"');
    expect(markup).toContain('Enter any user id');
    expect(markup).toContain('any non-empty id, no password');
    expect(markup).toContain('>Switch</button>');
  });

  it('preserves the buyer compatibility wrapper', () => {
    const markup = renderToStaticMarkup(
      <BuyerIdentityControl buyerId="demo-buyer-27" onImpersonate={() => undefined} />,
    );

    expect(markup).toContain('Demo user');
    expect(markup).toContain('id="buyer-demo-user-id"');
    expect(markup).toContain('value="demo-buyer-27"');
  });

  it('lets the shared identity grid shrink inside a narrow shell column', () => {
    expect(identityCss).toMatch(/\.demo-identity\s*\{[^}]*width:\s*min\(20rem, 100%\);[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-heading\s*\{[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-heading strong\s*\{[^}]*min-width:\s*0;/s);
    expect(identityCss).toMatch(/\.demo-identity-row\s*\{[^}]*min-width:\s*0;/s);
  });
});

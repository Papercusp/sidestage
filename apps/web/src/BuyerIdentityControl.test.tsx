import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuyerIdentityControl, DemoIdentityControl } from './BuyerIdentityControl';

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
});

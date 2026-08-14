import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuyerIdentityControl } from './BuyerIdentityControl';

describe('BuyerIdentityControl', () => {
  it('makes the current demo identity and auth-free contract explicit', () => {
    const markup = renderToStaticMarkup(
      <BuyerIdentityControl buyerId="demo-buyer-27" onImpersonate={() => undefined} />,
    );

    expect(markup).toContain('Demo user');
    expect(markup).toContain('value="demo-buyer-27"');
    expect(markup).toContain('Enter any user id');
    expect(markup).toContain('any non-empty id, no password');
    expect(markup).toContain('>Switch</button>');
  });
});

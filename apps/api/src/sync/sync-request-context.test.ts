import { describe, expect, it } from 'vitest';
import { LEGACY_DEMO_SELLER_ID, rolePrincipal } from './sync-request-context';

describe('rolePrincipal', () => {
  it('preserves the catalog seed owner for seller-scoped inventory queries', () => {
    expect(rolePrincipal(LEGACY_DEMO_SELLER_ID, 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
  });

  it('keeps the legacy seller identity role-isolated from buyer traffic', () => {
    expect(rolePrincipal(LEGACY_DEMO_SELLER_ID, 'buyer')).toBe('buyer-demo-seller');
  });

  it('resolves bare minted anonymous personas to the seed seller on seller surfaces (mirrors buyer-identity.ts)', () => {
    // A minted persona was never a deliberate identity choice, and a
    // seller-<random> principal owns no events — the sync provider sends the
    // raw app-wide identity, so without this rule every seller-owned pane
    // (proposals, run of show, config) 404s for an anonymous visitor.
    expect(rolePrincipal('demo-54598e91', 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
  });

  it('keeps role-prefixed and buyer personas isolated — only the bare minted form collapses', () => {
    // A stored role-prefixed id came from a deliberate write, not the mint
    // path; the web client resolves these identically (isMintedDemoPersona is
    // anchored on the bare demo- form), so client and server stay in agreement.
    expect(rolePrincipal('buyer-demo-54598e91', 'seller')).toBe('seller-demo-54598e91');
    expect(rolePrincipal('seller-demo-54598e91', 'seller')).toBe('seller-demo-54598e91');
    expect(rolePrincipal('demo-54598e91', 'buyer')).toBe('buyer-demo-54598e91');
  });

  it('continues to project ordinary personas without stacking role prefixes', () => {
    expect(rolePrincipal('demo-avi', 'seller')).toBe('seller-demo-avi');
    expect(rolePrincipal('buyer-avi', 'seller')).toBe('seller-avi');
    expect(rolePrincipal('seller-avi', 'buyer')).toBe('buyer-avi');
  });
});

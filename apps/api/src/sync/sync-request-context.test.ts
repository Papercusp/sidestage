import { describe, expect, it } from 'vitest';
import { LEGACY_DEMO_SELLER_ID, rolePrincipal } from './sync-request-context';

describe('rolePrincipal', () => {
  it('preserves the catalog seed owner for seller-scoped inventory queries', () => {
    expect(rolePrincipal(LEGACY_DEMO_SELLER_ID, 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
  });

  it('keeps the legacy seller identity role-isolated from buyer traffic', () => {
    expect(rolePrincipal(LEGACY_DEMO_SELLER_ID, 'buyer')).toBe('buyer-demo-seller');
  });

  it('maps only generated anonymous seller personas to the seeded catalog owner', () => {
    expect(rolePrincipal('demo-54598e91', 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
    expect(rolePrincipal('buyer-demo-54598e91', 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
    expect(rolePrincipal('seller-demo-54598e91', 'seller')).toBe(LEGACY_DEMO_SELLER_ID);
    expect(rolePrincipal('demo-54598e91', 'buyer')).toBe('buyer-demo-54598e91');
  });

  it('continues to project ordinary personas without stacking role prefixes', () => {
    expect(rolePrincipal('demo-avi', 'seller')).toBe('seller-demo-avi');
    expect(rolePrincipal('buyer-avi', 'seller')).toBe('seller-avi');
    expect(rolePrincipal('seller-avi', 'buyer')).toBe('buyer-avi');
  });
});

import { describe, expect, it } from 'vitest';
import {
  LEGACY_DEMO_SELLER_ID,
  resolveSyncPrincipal,
  rolePrincipal,
} from './sync-request-context';

/**
 * WI-39763 error B. These lock the ONE property that keeps WebSockets alive:
 * the principal must survive the zero-cache hop, where the only identity
 * channel is `Authorization: Bearer`.
 *
 * The failure this prevents is silent and total. A `null` principal here makes
 * /zero/query answer `userID: null`, Zero reads that as "the server validated
 * this connection as having no user", and it closes EVERY connection with
 * `Unauthorized: Connection userID does not match validated server userID` —
 * demoting every user to polling. There is no partial failure mode.
 */
describe('resolveSyncPrincipal', () => {
  it('reads the identity zero-cache forwards — a bearer token and nothing else', () => {
    // This is EXACTLY the request zero-cache makes: no x-demo-principal
    // header, no demoPrincipal param, because it forwards neither.
    expect(resolveSyncPrincipal({ authorization: 'Bearer buyer-avi' })).toBe('buyer-avi');
  });

  it('never returns null for a request that carried an identity', () => {
    // The regression guard proper: null is the poison value, not merely a miss.
    for (const authorization of ['Bearer demo-54598e91', 'bearer demo-54598e91']) {
      expect(resolveSyncPrincipal({ authorization })).not.toBeNull();
    }
  });

  it('matches the scheme case-insensitively and strips only the scheme', () => {
    expect(resolveSyncPrincipal({ authorization: 'bearer seller-avi' })).toBe('seller-avi');
    expect(resolveSyncPrincipal({ authorization: 'BEARER\tseller-avi' })).toBe('seller-avi');
  });

  it('keeps the direct browser→API surfaces working unchanged', () => {
    // REST and SSE still send the header; they must not regress.
    expect(resolveSyncPrincipal({ principalHeader: 'demo-avi' })).toBe('demo-avi');
    expect(resolveSyncPrincipal({ principalParam: 'demo-avi' })).toBe('demo-avi');
  });

  it('prefers the bearer token over the header, so the connection-scoped identity wins', () => {
    expect(
      resolveSyncPrincipal({
        authorization: 'Bearer buyer-avi',
        principalHeader: 'demo-someone-else',
        principalParam: 'demo-third-party',
      }),
    ).toBe('buyer-avi');
  });

  it('ignores a non-bearer Authorization header rather than treating it as an identity', () => {
    expect(resolveSyncPrincipal({ authorization: 'Basic ZGVtbzpkZW1v' })).toBeNull();
    expect(resolveSyncPrincipal({ authorization: 'Bearer' })).toBeNull();
    expect(resolveSyncPrincipal({ authorization: 'Bearer   ' })).toBeNull();
  });

  it('resolves null only when the request genuinely carried no identity', () => {
    expect(resolveSyncPrincipal({})).toBeNull();
  });
});

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

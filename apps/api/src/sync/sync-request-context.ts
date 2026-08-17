/**
 * Server half of the canonical demo-principal wire convention exported to
 * browser transports by @papercusp/sync/principal. This local leaf keeps the
 * Nest CommonJS build independent from the React-oriented sync package.
 */
export const DEMO_PRINCIPAL_HEADER = 'x-demo-principal';
export const DEMO_PRINCIPAL_QUERY_PARAM = 'demoPrincipal';

export interface SyncRequestContext {
  principal: string | null;
}

export type DemoPrincipalRole = 'buyer' | 'seller';

/** Stable single-store Studio owner used by the clean-clone catalog and fixtures. */
export const LEGACY_DEMO_SELLER_ID = 'demo-seller';

export function normalizeDemoPrincipal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * An auto-minted anonymous persona (`demo-` + the 8-char random token the web
 * client generates). Mirrors isMintedDemoPersona in apps/web/src/buyer-identity.ts —
 * the two MUST agree, or the surface that resolves client-side (Studio panes
 * hitting REST directly) and the one that resolves here (sync-layer queries,
 * whose provider sends the raw app-wide identity) split onto different sellers
 * and every seller-owned pane 404s for an anonymous visitor.
 */
const MINTED_DEMO_PERSONA = /^demo-[a-z0-9]{8}$/;

/**
 * Project the selected app-wide demo identity into a role-specific authority.
 *
 * The browser may persist the base persona as `demo-avi`, `buyer-avi`, or
 * `seller-avi` depending on which surface last changed it. Stripping one
 * existing role before applying the requested one keeps all three spellings
 * on the same seller/buyer record and prevents clients from choosing a
 * different seller with a second header or query argument.
 *
 * A minted anonymous persona was never a deliberate identity choice, and a
 * `seller-<random>` principal owns no events — the seller role therefore
 * resolves minted personas to the seed owner (same rule as the web client);
 * only an explicitly typed identity names a different seller. Buyer identity
 * is untouched: anonymous buyers must stay distinct participants.
 */
export function rolePrincipal(
  value: unknown,
  role: DemoPrincipalRole,
): string | null {
  const principal = normalizeDemoPrincipal(value);
  if (!principal) return null;
  if (role === 'seller') {
    if (principal.toLowerCase() === LEGACY_DEMO_SELLER_ID) return LEGACY_DEMO_SELLER_ID;
    if (MINTED_DEMO_PERSONA.test(principal)) return LEGACY_DEMO_SELLER_ID;
  }
  const persona = principal.replace(/^(?:buyer|seller)-+/i, '');
  return persona.length > 0 ? `${role}-${persona}` : null;
}

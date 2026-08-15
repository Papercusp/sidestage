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

/** Seed/import owner used by the clean-clone catalog and acceptance fixtures. */
export const LEGACY_DEMO_SELLER_ID = 'demo-seller';

/**
 * Fresh anonymous browser sessions use `demo-<8 chars>`. The catalog predates
 * role-prefixed principals and is intentionally seeded to one shared demo
 * seller, so only that generated shape folds back to the seed owner. Named
 * personas such as `demo-avi` keep their own seller namespace.
 */
const GENERATED_DEMO_PERSONA = /^demo-[a-z0-9]{8}$/i;

export function normalizeDemoPrincipal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Project the selected app-wide demo identity into a role-specific authority.
 *
 * The browser may persist the base persona as `demo-avi`, `buyer-avi`, or
 * `seller-avi` depending on which surface last changed it. Stripping one
 * existing role before applying the requested one keeps all three spellings
 * on the same seller/buyer record and prevents clients from choosing a
 * different seller with a second header or query argument.
 */
export function rolePrincipal(
  value: unknown,
  role: DemoPrincipalRole,
): string | null {
  const principal = normalizeDemoPrincipal(value);
  if (!principal) return null;
  if (role === 'seller' && principal.toLowerCase() === LEGACY_DEMO_SELLER_ID) {
    return LEGACY_DEMO_SELLER_ID;
  }
  const persona = principal.replace(/^(?:buyer|seller)-+/i, '');
  if (role === 'seller' && GENERATED_DEMO_PERSONA.test(persona)) {
    return LEGACY_DEMO_SELLER_ID;
  }
  return persona.length > 0 ? `${role}-${persona}` : null;
}

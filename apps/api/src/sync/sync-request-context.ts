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

/** `Authorization: Bearer <token>`, scheme matched case-insensitively per RFC 7235. */
const BEARER_SCHEME = /^Bearer[ \t]+/i;

/**
 * Resolve the caller's principal for a **sync** request, which — unlike every
 * other controller in this app — may arrive second-hand from zero-cache.
 *
 * ## Why the demo header alone is not enough here (WI-39763)
 *
 * On the REST/SSE surfaces the browser calls us directly and sends
 * `x-demo-principal`. On the WebSocket surface it does not: the browser talks
 * to *zero-cache*, and zero-cache then calls `/zero/query` and `/zero/mutate`
 * itself, server-to-server. It forwards a fixed, closed set of things from the
 * browser connection — `schema` and `appID` on the URL, and on the headers an
 * optional API key, allow-listed connect headers, cookie, origin, and
 * `Authorization: Bearer <the client's opaque auth token>`. `x-demo-principal`
 * is in none of those buckets, so on that path it simply never arrives.
 *
 * That absence was not harmless. Zero reads the `userID` we return as a SERVER
 * VALIDATION of the connection's user, and a `null` there asserts "this
 * connection has no user" — which never equals the `userID` the browser opened
 * the connection with. zero-cache closed every connection with `Unauthorized:
 * Connection userID does not match validated server userID` and the transport
 * ladder demoted every user from WebSockets to SSE to polling.
 *
 * Reading the bearer token FIRST closes that gap: the web client sends its
 * identity as Zero's opaque `auth` token, zero-cache forwards it verbatim, and
 * the `userID` we hand back is the same string the connection claims. The demo
 * header and query param stay as fallbacks — the surfaces that call us
 * directly still use them, and they must keep working unchanged.
 */
export function resolveSyncPrincipal(sources: {
  authorization?: string;
  principalHeader?: string;
  principalParam?: string;
}): string | null {
  const bearer =
    typeof sources.authorization === 'string' && BEARER_SCHEME.test(sources.authorization)
      ? sources.authorization.replace(BEARER_SCHEME, '')
      : undefined;
  return (
    normalizeDemoPrincipal(bearer) ??
    normalizeDemoPrincipal(sources.principalHeader) ??
    normalizeDemoPrincipal(sources.principalParam)
  );
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

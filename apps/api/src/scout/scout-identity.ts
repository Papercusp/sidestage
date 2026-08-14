import type { ScoutIdentity, ScoutIdentityResolver } from './scout.types';

/**
 * Server-side buyer identity for a scout turn (P-012, D-009).
 *
 * Restart establishes this in its `/api/scout` proxy: it resolves the shopper
 * from a better-auth cookie and OVERWRITES `body.userId`, so a client-sent id
 * can never key another shopper's memory. SideStage has no proxy tier — the API
 * IS the edge — so the equivalent boundary lives here, at the controller edge.
 *
 * ⚠ WHAT THIS IS NOT. Until SideStage has real authentication, the cookie below
 * is UNSIGNED and therefore self-asserted: it buys per-visitor CONTINUITY, not
 * authentication or isolation. Restart may claim isolation because its tools
 * read scope off a cryptographically-verified session; this cannot, and D-009
 * binds us not to claim it. Nothing sensitive belongs in scout memory until
 * `resolve` is backed by a verified session — at which point that is the ONLY
 * function that changes.
 */
export const BUYER_COOKIE = 'ss_buyer_id';

/**
 * A buyer id we are willing to use as a memory scope key.
 *
 * Bounded and conservative on purpose: the value lands in a `user:<id>` scope
 * string, and an unbounded attacker-controlled cookie would otherwise let a
 * visitor mint arbitrarily many scopes (or one megabyte-long one) in the
 * memory table. Anything that fails this is treated as no identity at all,
 * which degrades to guest — never to an error.
 */
const BUYER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isUsableBuyerId(value: string | undefined | null): boolean {
  return typeof value === 'string' && BUYER_ID_PATTERN.test(value);
}

/**
 * Parse a `Cookie` header into a name→value map.
 *
 * Hand-rolled rather than pulling `cookie-parser`, matching this app's existing
 * choice to declare structural request shapes instead of depending on express
 * types. Values are percent-decoded; a malformed encoding yields the raw value
 * rather than throwing, because a bad cookie must degrade a turn to guest, not
 * fail it.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/** The single header value, when a header arrives repeated (`string[]`). */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join('; ');
  return value;
}

/**
 * The default resolver: identity from the `ss_buyer_id` cookie.
 *
 * This is the guest-continuity implementation D-009 describes. It reads ONLY
 * request headers — never a body — which is what makes the client-sent-id
 * overwrite in the controller total rather than best-effort.
 */
export class CookieScoutIdentityResolver implements ScoutIdentityResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ScoutIdentity {
    const cookies = parseCookies(headerValue(headers?.cookie));
    const candidate = cookies[BUYER_COOKIE];
    return { buyerId: isUsableBuyerId(candidate) ? candidate : null };
  }
}

/** Everyone is a guest. The resolver to use when continuity is switched off. */
export class AnonymousScoutIdentityResolver implements ScoutIdentityResolver {
  resolve(): ScoutIdentity {
    return { buyerId: null };
  }
}

/**
 * Strip every client-supplied identity key from a request body.
 *
 * Belt AND braces. The service already takes identity as an explicit argument
 * and never reads it off the payload, so this changes no behavior TODAY — its
 * job is to make the boundary survive a future edit. The realistic regression
 * is someone adding `buyerId` to `ScoutStreamRequest` for an unrelated reason
 * and a later reader trusting it; stripping at the edge means the forged value
 * is not merely ignored, it is GONE by the time any service sees the object.
 * Guarded by a test that fails if a client-sent id survives the controller.
 */
const CLIENT_IDENTITY_KEYS = ['buyerId', 'userId', 'customerId'] as const;

export function stripClientIdentity<T>(body: T): T {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...(body as Record<string, unknown>) };
  for (const key of CLIENT_IDENTITY_KEYS) delete clone[key];
  return clone as T;
}

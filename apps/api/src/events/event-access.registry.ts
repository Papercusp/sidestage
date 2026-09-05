/**
 * Reviewed access policy for every event-facing HTTP endpoint and named sync
 * query (D-003).
 *
 * This registry is consumed by two tests that must not drift apart:
 *
 * - `event-access.matrix.test.ts` proves the registry is COMPLETE — a route or
 *   named query added to the app fails discovery until it is classified here,
 *   which is what makes private-by-accident and public-by-accident loud.
 * - `event-access.cross-seller.test.ts` proves the registry is TRUE — every
 *   `seller-owned` cell is exercised against a second seller over real HTTP,
 *   and every `public-viewer` cell is exercised against both principals.
 *
 * Classification alone is a promise, not a proof; the pairing is deliberate.
 */
export type AccessPolicy =
  | 'public-viewer'
  | 'seller-owned'
  | 'principal-partitioned'
  | 'capability-scoped'
  | 'operational';

export const EVENT_ACCESS: {
  endpoints: Readonly<Record<string, AccessPolicy>>;
  syncQueries: Readonly<Record<string, AccessPolicy>>;
  sellerOwnedBranches: readonly string[];
} = {
  endpoints: {
    'POST /actions/events/:eventId/register': 'seller-owned',
    'GET /actions/events/:eventId/items': 'seller-owned',
    'GET /actions/events/:eventId/audit': 'seller-owned',
    'POST /actions/events/:eventId/execute': 'seller-owned',
    'POST /actions/audit/:auditId/rollback': 'seller-owned',
    'POST /auctions/access/guest': 'public-viewer',
    'POST /auctions/start': 'seller-owned',
    'GET /auctions/events/:eventId/active': 'public-viewer',
    'GET /auctions/events/:eventId/stream': 'public-viewer',
    'GET /auctions/inventory/:productId': 'public-viewer',
    'GET /auctions/:id': 'public-viewer',
    'POST /auctions/:id/bids': 'public-viewer',
    'POST /auctions/:id/cancel': 'seller-owned',
    'POST /auctions/:id/close': 'seller-owned',
    'GET /cart/:id': 'principal-partitioned',
    'POST /cart/items': 'principal-partitioned',
    'PATCH /cart/:cartId/items/:productId': 'principal-partitioned',
    'DELETE /cart/:cartId/items/:productId': 'principal-partitioned',
    'GET /chat/events/:eventId/messages': 'public-viewer',
    'POST /chat/events/:eventId/messages': 'public-viewer',
    'POST /chat/events/:eventId/transcript': 'seller-owned',
    'POST /chat/events/:eventId/transcript/product-focus': 'seller-owned',
    'POST /chat/events/:eventId/presence': 'public-viewer',
    'DELETE /chat/events/:eventId/presence/:role': 'principal-partitioned',
    'DELETE /chat/events/:eventId/messages/:messageId': 'seller-owned',
    'GET /chat/metrics': 'seller-owned',
    'GET /chat/events/:eventId/presence': 'public-viewer',
    'GET /events/:eventId/config': 'seller-owned',
    'PUT /events/:eventId/config': 'seller-owned',
    'GET /copilot/events/:eventId/proposals': 'seller-owned',
    'POST /copilot/events/:eventId/turns': 'seller-owned',
    'POST /copilot/proposals/:proposalId/approve': 'seller-owned',
    'POST /copilot/proposals/:proposalId/skip': 'seller-owned',
    'POST /copilot/proposals/:proposalId/confirm-action': 'seller-owned',
    'GET /events': 'public-viewer',
    'GET /events/mine': 'seller-owned',
    'DELETE /events/:eventId': 'seller-owned',
    // Schedule / go live / end (D-002). Seller-owned for the same reason the
    // unpublish above is: it moves an event's lifecycle, and the handler proves
    // ownership via findOwned before writing anything.
    'PATCH /events/:eventId/lifecycle': 'seller-owned',
    'GET /v1/seller/policies/effective': 'seller-owned',
    'GET /v1/seller/policies/:id': 'seller-owned',
    'POST /v1/seller/policies': 'seller-owned',
    'PATCH /v1/seller/policies/:id': 'seller-owned',
    'POST /v1/seller/policies/:id/validate': 'seller-owned',
    'POST /v1/seller/policies/:id/publish': 'seller-owned',
    'GET /v1/seller/policies/:id/audit': 'seller-owned',
    'GET /rehearsals/preflight/:eventId': 'seller-owned',
    'GET /rehearsals/client-clock': 'operational',
    'POST /rehearsals/client-realtime/:eventId': 'seller-owned',
    'POST /rehearsals/all': 'operational',
    'POST /rehearsals/:kind': 'operational',
    'GET /events/:eventId/run-of-show': 'seller-owned',
    'PUT /events/:eventId/run-of-show': 'seller-owned',
    'GET /events/:eventId/stats': 'public-viewer',
    'GET /events/:eventId/products/:productId/pricing-history': 'public-viewer',
    'POST /sync/rest-query-batch': 'principal-partitioned',
    'GET /sync/sse': 'principal-partitioned',
    'POST /transcription/deepgram-token': 'seller-owned',
  },
  syncQueries: {
    'event.actions.items': 'seller-owned',
    'event.lineup.items': 'public-viewer',
    'event.auction.active': 'public-viewer',
    'event.chat.messages': 'public-viewer',
    'event.chat.presence': 'public-viewer',
    'event.chat.stats': 'public-viewer',
    'event.chat.transcript': 'public-viewer',
    'event.config': 'seller-owned',
    'event.copilot.proposals': 'seller-owned',
    'event.pricingHistory': 'public-viewer',
    'event.replay.chapters': 'public-viewer',
    'event.runOfShow': 'seller-owned',
    'event.stats': 'public-viewer',
    'events.guide': 'public-viewer',
    'events.mine': 'seller-owned',
    'rehearsal.preflight': 'seller-owned',
  },

  /**
   * Routes whose PRIMARY policy is not `seller-owned`, but which ALSO enforce
   * seller ownership on a conditional branch: the caller is ownership-checked
   * only when it presents a seller principal, and travels the public or
   * partitioned path otherwise.
   *
   * One label per route cannot express that shape, and that is exactly how
   * these branches escaped proof. `event-access.cross-seller.test.ts` derives
   * its owner-only cells from `endpointsWithPolicy('seller-owned')`, so a
   * route parked under `public-viewer` was never asked for an owned cell —
   * deleting the ownership check on `POST /chat/events/:eventId/messages` left
   * the whole matrix green (measured 2026-09-05, P-008 item (d) probe D2).
   * The check was correct; the matrix simply could not see it.
   *
   * Declaring the branch here puts it back inside both proofs:
   * `event-access.matrix.test.ts` fails when a controller grows a new
   * ownership call on a route that is not `seller-owned` and is not listed
   * here, and the cross-seller matrix fails when a listed branch has no cell.
   */
  sellerOwnedBranches: [
    'DELETE /chat/events/:eventId/presence/:role',
    'POST /chat/events/:eventId/messages',
    'POST /chat/events/:eventId/presence',
  ],
};

export function endpointsWithPolicy(policy: AccessPolicy): string[] {
  return Object.entries(EVENT_ACCESS.endpoints)
    .filter(([, value]) => value === policy)
    .map(([route]) => route)
    .sort();
}

/** The declared conditional seller-ownership branches, sorted. */
export function sellerOwnedBranchRoutes(): string[] {
  return [...EVENT_ACCESS.sellerOwnedBranches].sort();
}

export function syncQueriesWithPolicy(policy: AccessPolicy): string[] {
  return Object.entries(EVENT_ACCESS.syncQueries)
    .filter(([, value]) => value === policy)
    .map(([name]) => name)
    .sort();
}

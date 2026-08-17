/**
 * SideStage Zero custom mutators.
 *
 * ── Why this registry is deliberately SMALL ─────────────────────────────────
 *
 * A Zero custom mutator runs TWICE: optimistically against the browser's local
 * replica, and authoritatively inside a Postgres transaction on the server via
 * `/zero/mutate`. That is the right shape only when a write's rule set is
 * ROW-LOCAL — expressible identically in both places.
 *
 * Most SideStage writes are not. The data-surface census classifies them
 * `command-with-synced-result`: the authority is an API command transaction
 * that also runs guardrail policy, idempotency keys, an audit append, an
 * outbox event, and (for Copilot/auction/checkout) external calls. Re-expressing
 * that inside a mutator would FORK the business rules into a second
 * implementation that drifts — the exact failure the shared registry exists to
 * prevent. Those writes keep going through the existing REST commands, which
 * `@papercusp/sync`'s `useSyncMutate` already falls back to when a namespace is
 * absent from this registry. The synced RESULT still arrives over Zero, because
 * the command's Postgres commit is what replication observes.
 *
 * So a mutator lands here only when all three hold:
 *   1. the write touches one row (or one row per call) with no cross-row
 *      invariant beyond a primary key,
 *   2. there is no guardrail/policy/idempotency/audit obligation, and
 *   3. an optimistic local apply that is later corrected by replication is
 *      strictly better UX than a REST round-trip.
 *
 * Chat presence is the clean case: a heartbeat upsert and a leave delete, both
 * keyed on (event_id, user_id), no policy, and latency is the whole point.
 *
 * ── Contract with the server ───────────────────────────────────────────────
 *
 * Following the Restart reference (apps/shop-api/src/zero/zero.controller.ts),
 * leaves are plain `(tx, args, ctx)` functions invoked positionally on BOTH
 * sides. The wire name is namespaced with '|' (e.g. `chatPresence|touch`); the
 * server walks this registry by splitting on `[|.]`.
 *
 * `ctx` carries the authenticated principal. A mutator MUST authorize against
 * `ctx`, never against an id supplied in `args` — on the server `args` is
 * attacker-controlled.
 */

/** The principal resolved by the API for a `/zero/mutate` call. */
export interface SideStageMutatorContext {
  /** The selected demo principal (buyer or seller user id), or null if public. */
  principal: string | null;
}

/** Minimal structural type for the Zero transaction handed to a mutator. */
interface MutatorTx {
  mutate: Record<
    string,
    {
      insert: (row: Record<string, unknown>) => Promise<void> | void;
      upsert: (row: Record<string, unknown>) => Promise<void> | void;
      update: (row: Record<string, unknown>) => Promise<void> | void;
      delete: (row: Record<string, unknown>) => Promise<void> | void;
    }
  >;
}

export interface TouchPresenceArgs {
  eventId: string;
  userId: string;
  displayName: string;
  role: 'buyer' | 'seller';
}

export interface LeavePresenceArgs {
  eventId: string;
  userId: string;
}

function assertOwnPrincipal(ctx: SideStageMutatorContext | undefined, userId: string): void {
  // On the client `ctx` may be absent (the optimistic apply already knows it is
  // acting as the selected identity). On the server it is always supplied, and
  // this is the only thing standing between a crafted push and one buyer
  // writing another buyer's presence row.
  if (!ctx) return;
  if (ctx.principal !== userId) {
    throw new Error(
      `presence mutator principal mismatch: ctx principal ${ctx.principal ?? '<none>'} may not write presence for ${userId}`,
    );
  }
}

/**
 * Build the mutator registry. A factory (not a constant) so the server can
 * later inject per-request collaborators the way Restart's `createMutators()`
 * does, without changing any call site.
 */
export function createMutators() {
  return {
    chatPresence: {
      /** Heartbeat: upsert this participant's presence row for the event. */
      touch: async (tx: MutatorTx, args: TouchPresenceArgs, ctx?: SideStageMutatorContext) => {
        assertOwnPrincipal(ctx, args.userId);
        await tx.mutate.chatPresence.upsert({
          eventId: args.eventId,
          userId: args.userId,
          displayName: args.displayName,
          role: args.role,
          lastSeenAt: Date.now(),
        });
      },

      /** Explicit leave: drop the presence row immediately rather than aging out. */
      leave: async (tx: MutatorTx, args: LeavePresenceArgs, ctx?: SideStageMutatorContext) => {
        assertOwnPrincipal(ctx, args.userId);
        await tx.mutate.chatPresence.delete({
          eventId: args.eventId,
          userId: args.userId,
        });
      },
    },
  };
}

export type Mutators = ReturnType<typeof createMutators>;

/**
 * Write surfaces that stay REST commands, each with the reason it is NOT a Zero
 * mutator. The parity test requires every mutator name the web client uses
 * (census `SYNC_MUTATOR_SURFACES`) to be either implemented above or listed
 * here — so the cutover cannot silently drop a write path.
 */
export const REST_COMMAND_MUTATORS: Readonly<Record<string, string>> = {
  'auction.start': 'Guarded seller command: inventory allocation + lifecycle transition + audit append in one API transaction.',
  'auction.placeBid': 'Bid ordering and settlement are transaction-owned on the aggregate; an optimistic local bid could invert bid order.',
  'auction.close': 'Closes the auction, settles the winner, creates the hold and order — multi-table, not row-local.',
  'cart.holdProduct': 'Takes an inventory_reservation via the reserve_variant SQL function; stock invariants are enforced in Postgres.',
  'cart.removeItem': 'Releases a reservation alongside the cart document edit.',
  'cart.setQuantity': 'Adjusts a reservation alongside the cart document edit.',
  'chat.sendMessage': 'Runs moderation, client-request idempotency, and the seller-queue grounding classifier before the row exists.',
  'chat.addTranscriptMoment': 'Seller command gated by event visibility policy.',
  'chat.touchPresence': 'SUPERSEDED by the chatPresence.touch Zero mutator; the REST command remains as the SSE/polling fallback.',
  'chat.leavePresence': 'SUPERSEDED by the chatPresence.leave Zero mutator; the REST command remains as the SSE/polling fallback.',
  'checkout.createSession': 'Calls the external payment provider; the durable result syncs back.',
  'copilot.createTurn': 'Calls the model provider.',
  'copilot.approve': 'Guarded review transition with revision check and audit append.',
  'copilot.skip': 'Guarded review transition with revision check.',
  'copilot.confirmAction': 'Executes the proposed action through the guarded action path.',
  'event.lifecycle': 'Server-side legality table (resolveLifecycleTransition) decides the move and stamps status/starts_at/ended_at together; a row-local optimistic write would let the client apply a transition the server refuses.',
  'event.setup': 'Creates the event and its initial config in one transaction.',
  'event.unpublish': 'Withdraws the event from every buyer surface under a seller-ownership check, fanning out invalidations across the guide, the seller directory and the event lineup.',
  'event.addItems': 'Registers lineup items with position allocation and product ownership checks.',
  'event.adjustStock': 'Guarded seller stock command with audit append.',
  'event.executeAction': 'The guarded-action path itself: policy evaluation, idempotency key, audit entry, outbox event.',
  'event.updateConfig': 'Writes a new immutable seller_policy_revision alongside the config document.',
  'inventory.save': 'Seller inventory write with ownership isolation.',
  'inventory.onboard': 'Creates catalog + variant + option rows together.',
  'runOfShow.save': 'Whole-document replace with seller ownership check.',
  'judge.run': 'Operational command; no replicated table.',
  'rehearsal.run': 'Operational command with a progress stream.',
  'rehearsal.runAll': 'Operational command with a progress stream.',
  'shipping.meter': 'Calls an external rate provider.',
  'shipping.rates': 'Calls an external rate provider.',
};

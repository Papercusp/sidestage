/** Buyer cart reservations stay exclusive for a bounded human checkout window. */
export const BUYER_HOLD_DURATION_MS = 15 * 60_000;

export function buyerHoldExpiresAt(now = Date.now()): string {
  return new Date(now + BUYER_HOLD_DURATION_MS).toISOString();
}

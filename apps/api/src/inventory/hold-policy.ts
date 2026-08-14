/** Buyer cart reservations stay exclusive for two minutes. */
export const BUYER_HOLD_DURATION_MS = 2 * 60_000;

export function buyerHoldExpiresAt(now = Date.now()): string {
  return new Date(now + BUYER_HOLD_DURATION_MS).toISOString();
}

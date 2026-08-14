import type { CartData } from '@papercusp/cart-drawer';
import type { BuyerProduct } from './buyer';
import type { BuyerCart } from './buyer-checkout-api';

/**
 * The ONE seam between the shared `@papercusp/cart-drawer` shell and SideStage's
 * holds/expiry cart API (`apps/api/src/cart`). The library is deliberately
 * backend-agnostic — it renders lines and calls back — so every write named here
 * is a HOLD operation whose semantics the server owns:
 *
 * - `hold` → `POST /cart/items`, which reserves auction inventory and stamps a
 *   server-authored two-minute `expiresAt` (`inventory/hold-policy`). The client
 *   never authors or extends an expiry; it only renders the one it is given.
 * - `setQuantity` → `PATCH`, which re-reserves at the new quantity and rejects
 *   with 409 when stock cannot cover it. The rejection message is the per-line
 *   alert the drawer shows, so it must be allowed to propagate.
 * - `remove` → `DELETE`, which releases the reservation.
 * - `refresh` re-reads the cart. `GET /cart/:id` prunes expired holds ON READ and
 *   releases their reservations, so a refresh is also how an expired line leaves
 *   the drawer — there is no client-side eviction to keep in sync with it.
 *
 * Implementations live in `BuyerCheckoutProvider`, which routes every one of
 * these through `@papercusp/sync` (`cart.holdProduct` / `cart.setQuantity` /
 * `cart.removeItem`) rather than calling `fetch` directly.
 */
export interface BuyerCartAdapter {
  hold(product: BuyerProduct): Promise<BuyerCart>;
  setQuantity(productId: string, quantity: number): Promise<BuyerCart>;
  remove(productId: string): Promise<BuyerCart>;
  refresh(): void;
}

/** Server-enforced per-line bounds (`CartService.assertQuantity`). */
export const MIN_HELD_QUANTITY = 1;
export const MAX_HELD_QUANTITY = 99;

/**
 * Map SideStage's cart onto the library's structural `CartData`.
 *
 * SideStage carries no separate line id — the server keys one line per product
 * (`items.find(item => item.productId === …)`), so the product id IS the line
 * key and is used for both. `availableQty` stays undefined on purpose:
 * purchasable stock is not carried on the cart payload, and the library treats
 * undefined as "unknown, do not clamp". The server therefore stays the single
 * authority on availability, and a rejected write surfaces as a per-line alert
 * instead of a client-side guess that could disagree with it.
 */
export function toCartData(cart: BuyerCart | null | undefined): CartData | null {
  if (!cart) return null;
  return {
    id: cart.id,
    currency: cart.currency,
    items: cart.items.map((item) => ({
      id: item.productId,
      productId: item.productId,
      quantity: item.quantity,
      product: {
        id: item.productId,
        title: item.title,
        imageUrl: item.imageUrl ?? null,
        priceCents: item.priceCents,
      },
    })),
  };
}

/**
 * Milliseconds left on a hold, or null when the line carries no expiry.
 * An unparseable expiry reads as ALREADY EXPIRED (0) rather than as "no hold":
 * the safe failure is releasing a hold the buyer no longer has, never rendering
 * an indefinite one.
 */
export function holdRemainingMs(expiresAt: string | undefined, nowMs: number): number | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - nowMs);
}

export function formatHoldCountdown(remainingMs: number | null): string {
  if (remainingMs === null) return 'Reserved';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

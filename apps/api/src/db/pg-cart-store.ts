import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  assertEventCartQuantity,
  assertEventCartScope,
  cloneCart,
  emptyCart,
  hasEventHoldKey,
  recordEventHoldKey,
  summarizeCart,
  upsertEventCartItem,
  type Cart,
  type CartStore,
  type EventCartHoldInput,
} from '../cart/cart.service';

interface CartPayloadRow {
  payload: Cart | string;
}

interface EventLineupRow {
  event_id: string;
  event_item_id: string;
  product_id: string;
  title: string;
  current_price_cents: number;
  current_quantity: number;
}

interface InventoryRow {
  available_qty: number;
}

interface ReservationRow {
  quantity: number;
  state: 'held' | 'committed' | 'expired' | 'released';
}

function cartPayload(row: CartPayloadRow | undefined): Cart | undefined {
  if (!row) return undefined;
  const value = typeof row.payload === 'string' ? JSON.parse(row.payload) as Cart : row.payload;
  return cloneCart(value);
}

/**
 * Durable cart storage. The cart document keeps its service-level shape and is
 * stored whole as jsonb — carts are single-writer session documents, so a
 * normalized item table would buy nothing but joins.
 */
export class PgCartStore implements CartStore {
  constructor(private readonly pool: Pool) {}

  async get(id: string): Promise<Cart | undefined> {
    const result = await this.pool.query<CartPayloadRow>(
      'SELECT payload FROM cart WHERE id = $1',
      [id],
    );
    return cartPayload(result.rows[0]);
  }

  async set(cart: Cart): Promise<void> {
    await this.pool.query(
      `INSERT INTO cart (id, payload, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [cart.id, JSON.stringify(cart)],
    );
  }

  /**
   * Persist the event allocation, source-tracked physical reservation, and
   * cart aggregate under one database transaction. The cart row is inserted
   * before it is selected FOR UPDATE so even two first writes to the same cart
   * serialize on the primary key rather than racing as two missing rows.
   */
  async holdEventItem(input: EventCartHoldInput): Promise<Cart> {
    return this.transaction(async (client) => {
      const initial = emptyCart(input.cartId);
      await client.query(
        `INSERT INTO cart (id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO NOTHING`,
        [input.cartId, JSON.stringify(initial)],
      );
      const selectedCart = await client.query<CartPayloadRow>(
        'SELECT payload FROM cart WHERE id = $1 FOR UPDATE',
        [input.cartId],
      );
      const cart = cartPayload(selectedCart.rows[0]);
      if (!cart) throw new Error(`Cart ${input.cartId} could not be locked`);
      if (hasEventHoldKey(cart, input.idempotencyKey)) return cart;

      assertEventCartScope(cart, input.eventId);
      const existing = cart.items.find((candidate) => candidate.eventItemId === input.eventItemId);
      const previousQuantity = existing?.quantity ?? 0;
      const nextQuantity = previousQuantity + input.quantity;
      assertEventCartQuantity(nextQuantity);

      // Match PgAuctionStore's storefront-before-lineup lock order. Holding the
      // variant makes the generated availableQty stable through the reservation
      // upsert and prevents two carts from both observing the same stock.
      const inventory = await client.query<InventoryRow>(
        `SELECT "availableQty" AS available_qty
           FROM storefront_product
          WHERE id = $1 AND active
          FOR UPDATE`,
        [input.productId],
      );
      if (!inventory.rows[0]) throw new NotFoundException('Event item is not available');

      const reservation = await client.query<ReservationRow>(
        `SELECT quantity, state
           FROM inventory_reservation
          WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2
          FOR UPDATE`,
        [input.cartId, input.productId],
      );
      const currentReservation = reservation.rows[0];
      if (currentReservation?.state === 'committed') {
        throw new ConflictException('The cart inventory commitment is already paid');
      }
      if (currentReservation?.state === 'held' && currentReservation.quantity !== previousQuantity) {
        throw new ConflictException('The cart inventory commitment changed; reload the cart and retry');
      }
      const activeReservedQuantity = currentReservation?.state === 'held'
        ? currentReservation.quantity
        : 0;
      const additionalPhysicalQuantity = nextQuantity - activeReservedQuantity;
      if (inventory.rows[0].available_qty < additionalPhysicalQuantity) {
        throw new ConflictException(`Insufficient available quantity for ${input.productId}`);
      }

      // The join is deliberately non-enumerating: missing, foreign, and draft
      // event/item combinations all become the same public 404.
      const selectedItem = await client.query<EventLineupRow>(
        `SELECT item.event_id, item.event_item_id, item.product_id, item.title,
                item.current_price_cents, item.current_quantity
           FROM event_lineup_item AS item
           JOIN event AS published ON published.event_id = item.event_id
          WHERE item.event_id = $1
            AND item.event_item_id = $2
            AND item.product_id = $3
            AND published.status <> 'draft'
          FOR UPDATE OF item, published`,
        [input.eventId, input.eventItemId, input.productId],
      );
      const item = selectedItem.rows[0];
      if (!item) throw new NotFoundException('Event item is not available');
      if (item.current_quantity < input.quantity) {
        throw new ConflictException(`Insufficient event allocation for ${input.eventItemId}`);
      }

      await client.query(
        `UPDATE event_lineup_item
            SET current_quantity = current_quantity - $4,
                version = version + 1,
                updated_at = now()
          WHERE event_id = $1 AND event_item_id = $2 AND product_id = $3`,
        [input.eventId, input.eventItemId, input.productId, input.quantity],
      );
      await client.query(
        `INSERT INTO inventory_reservation
           (variant_id, source_kind, source_id, quantity, state, expires_at)
         VALUES ($1, 'cart', $2, $3, 'held', $4)
         ON CONFLICT (source_kind, source_id, variant_id) DO UPDATE
           SET quantity = EXCLUDED.quantity,
               state = 'held',
               expires_at = EXCLUDED.expires_at`,
        [input.productId, input.cartId, nextQuantity, input.expiresAt],
      );

      upsertEventCartItem(cart, {
        eventId: item.event_id,
        eventItemId: item.event_item_id,
        productId: item.product_id,
        title: item.title,
        priceCents: item.current_price_cents,
      }, input, nextQuantity);
      recordEventHoldKey(cart, input.idempotencyKey);
      const updated = summarizeCart(cart);
      await client.query(
        'UPDATE cart SET payload = $2::jsonb, updated_at = now() WHERE id = $1',
        [input.cartId, JSON.stringify(updated)],
      );
      return cloneCart(updated);
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

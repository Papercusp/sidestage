import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  assertEventCartQuantity,
  assertEventCartScope,
  assertEventCartTargetQuantity,
  assertExpectedCartRevision,
  cartRevision,
  cloneCart,
  emptyCart,
  hasEventHoldKey,
  recordEventHoldKey,
  requireEventCartContext,
  summarizeCart,
  terminalTransitionReplay,
  upsertEventCartItem,
  type Cart,
  type CartStore,
  type EventCartHoldInput,
  type EventCartQuantityInput,
  type EventCartTerminalInput,
  type EventCartTerminalState,
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
  listed_quantity: number;
}

interface InventoryRow {
  available_qty: number;
  active: boolean;
}

interface ReservationRow {
  quantity: number;
  state: 'held' | 'committed' | 'expired' | 'released';
  unexpired: boolean;
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

      // Establish the buyer-visible tuple before reading physical inventory.
      // The authoritative row is locked again below after the storefront lock,
      // preserving the shared storefront-before-lineup lock order while making
      // missing, foreign, and draft combinations uniformly non-enumerating.
      const visibleItem = await client.query<{ event_item_id: string }>(
        `SELECT item.event_item_id
           FROM event_lineup_item AS item
           JOIN event AS published ON published.event_id = item.event_id
          WHERE item.event_id = $1
            AND item.event_item_id = $2
            AND item.product_id = $3
            AND published.status <> 'draft'`,
        [input.eventId, input.eventItemId, input.productId],
      );
      if (!visibleItem.rows[0]) throw new NotFoundException('Event item is not available');

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
      cart.eventTerminalTransition = undefined;
      const updated = summarizeCart(cart);
      await client.query(
        'UPDATE cart SET payload = $2::jsonb, updated_at = now() WHERE id = $1',
        [input.cartId, JSON.stringify(updated)],
      );
      return cloneCart(updated);
    });
  }

  async setEventItemQuantity(input: EventCartQuantityInput): Promise<Cart> {
    return this.transaction(async (client) => {
      const cart = await this.lockCart(client, input.cartId);
      assertExpectedCartRevision(cart, input.expectedRevision);
      assertEventCartScope(cart, input.eventId);
      assertEventCartTargetQuantity(input.quantity);
      const existing = cart.items.find((candidate) => (
        candidate.eventId === input.eventId
        && candidate.eventItemId === input.eventItemId
        && candidate.productId === input.productId
      ));
      if (!existing) throw new NotFoundException('Event cart item is not available');
      if (existing.quantity === input.quantity) return cloneCart(cart);

      const inventory = await client.query<InventoryRow>(
        `SELECT "availableQty" AS available_qty, active
           FROM storefront_product
          WHERE id = $1
          FOR UPDATE`,
        [input.productId],
      );
      if (!inventory.rows[0]) throw new ConflictException('Event cart inventory changed; reload the cart and retry');

      const reservation = await client.query<ReservationRow>(
        `SELECT quantity, state, (expires_at IS NULL OR expires_at > now()) AS unexpired
           FROM inventory_reservation
          WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2
          FOR UPDATE`,
        [input.cartId, input.productId],
      );
      const held = reservation.rows[0];
      if (!held || held.quantity !== existing.quantity || held.state === 'released' || held.state === 'committed') {
        throw new ConflictException('Event cart inventory commitment changed; reload the cart and retry');
      }
      if (held.state === 'expired' && input.quantity !== 0) {
        throw new ConflictException('Event cart inventory commitment expired; reload the cart and retry');
      }

      const selectedItem = await client.query<EventLineupRow>(
        `SELECT event_id, event_item_id, product_id, title,
                current_price_cents, current_quantity, listed_quantity
           FROM event_lineup_item
          WHERE event_id = $1 AND event_item_id = $2 AND product_id = $3
          FOR UPDATE`,
        [input.eventId, input.eventItemId, input.productId],
      );
      const item = selectedItem.rows[0];
      if (!item) throw new ConflictException('Event cart allocation changed; reload the cart and retry');

      const delta = input.quantity - existing.quantity;
      if (delta > 0) {
        if (!inventory.rows[0].active || inventory.rows[0].available_qty < delta) {
          throw new ConflictException(`Insufficient available quantity for ${input.productId}`);
        }
        if (item.current_quantity < delta) {
          throw new ConflictException(`Insufficient event allocation for ${input.eventItemId}`);
        }
      } else if (item.current_quantity - delta > item.listed_quantity) {
        throw new ConflictException('Event cart allocation changed; reload the cart and retry');
      }

      await client.query(
        `UPDATE event_lineup_item
            SET current_quantity = current_quantity - $4,
                version = version + 1,
                updated_at = now()
          WHERE event_id = $1 AND event_item_id = $2 AND product_id = $3`,
        [input.eventId, input.eventItemId, input.productId, delta],
      );
      if (input.quantity === 0) {
        await client.query(
          `UPDATE inventory_reservation
              SET state = 'released', expires_at = NULL
            WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2`,
          [input.cartId, input.productId],
        );
        cart.items = cart.items.filter((candidate) => candidate !== existing);
      } else {
        await client.query(
          `UPDATE inventory_reservation
              SET quantity = $3, state = 'held'
            WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2`,
          [input.cartId, input.productId, input.quantity],
        );
        existing.quantity = input.quantity;
        existing.title = item.title;
        existing.priceCents = item.current_price_cents;
      }

      const updated = summarizeCart(cart);
      await this.writeLockedCart(client, updated);
      return cloneCart(updated);
    });
  }

  async releaseEventCart(input: EventCartTerminalInput): Promise<Cart> {
    return this.transitionEventCart(input, 'released');
  }

  async commitEventCart(input: EventCartTerminalInput): Promise<Cart> {
    return this.transitionEventCart(input, 'committed');
  }

  private async transitionEventCart(
    input: EventCartTerminalInput,
    state: EventCartTerminalState,
  ): Promise<Cart> {
    return this.transaction(async (client) => {
      const cart = await this.lockCart(client, input.cartId);
      const replay = terminalTransitionReplay(cart, input, state);
      if (replay) return replay;
      assertExpectedCartRevision(cart, input.expectedRevision);
      const context = requireEventCartContext(cart);
      if (context.eventId !== input.eventId) throw new ConflictException('Event cart context changed');

      const items = [...cart.items].sort((left, right) => (
        left.productId.localeCompare(right.productId)
        || left.eventItemId!.localeCompare(right.eventItemId!)
      ));
      for (const item of items) {
        const inventory = await client.query<InventoryRow>(
          `SELECT "availableQty" AS available_qty, active
             FROM storefront_product
            WHERE id = $1
            FOR UPDATE`,
          [item.productId],
        );
        if (!inventory.rows[0]) throw new ConflictException('Event cart inventory changed; reload the cart and retry');

        const reservation = await client.query<ReservationRow>(
          `SELECT quantity, state, (expires_at IS NULL OR expires_at > now()) AS unexpired
             FROM inventory_reservation
            WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2
            FOR UPDATE`,
          [cart.id, item.productId],
        );
        const held = reservation.rows[0];
        const releasable = held?.state === 'held' || held?.state === 'expired';
        if (!held || held.quantity !== item.quantity || (state === 'released' ? !releasable : held.state !== 'held')) {
          throw new ConflictException(`Event cart inventory commitment for ${item.productId} changed`);
        }
        if (state === 'committed' && !held.unexpired) {
          throw new ConflictException(`Event cart inventory commitment for ${item.productId} expired`);
        }

        const selectedItem = await client.query<EventLineupRow>(
          `SELECT event_id, event_item_id, product_id, title,
                  current_price_cents, current_quantity, listed_quantity
             FROM event_lineup_item
            WHERE event_id = $1 AND event_item_id = $2 AND product_id = $3
            FOR UPDATE`,
          [input.eventId, item.eventItemId, item.productId],
        );
        const lineup = selectedItem.rows[0];
        if (!lineup) throw new ConflictException('Event cart allocation changed; reload the cart and retry');

        if (state === 'released') {
          if (lineup.current_quantity + item.quantity > lineup.listed_quantity) {
            throw new ConflictException('Event cart allocation changed; reload the cart and retry');
          }
          await client.query(
            `UPDATE event_lineup_item
                SET current_quantity = current_quantity + $4,
                    version = version + 1,
                    updated_at = now()
              WHERE event_id = $1 AND event_item_id = $2 AND product_id = $3`,
            [input.eventId, item.eventItemId, item.productId, item.quantity],
          );
          await client.query(
            `UPDATE inventory_reservation
                SET state = 'released', expires_at = NULL
              WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2`,
            [cart.id, item.productId],
          );
        } else {
          await client.query(
            `UPDATE inventory_reservation
                SET state = 'committed', expires_at = NULL
              WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2`,
            [cart.id, item.productId],
          );
        }
      }

      const sourceRevision = input.expectedRevision ?? cartRevision(cart);
      cart.items = [];
      cart.eventTerminalTransition = { eventId: input.eventId, state, sourceRevision };
      const updated = summarizeCart(cart);
      await this.writeLockedCart(client, updated);
      return cloneCart(updated);
    });
  }

  private async lockCart(client: PoolClient, cartId: string): Promise<Cart> {
    const selected = await client.query<CartPayloadRow>(
      'SELECT payload FROM cart WHERE id = $1 FOR UPDATE',
      [cartId],
    );
    const cart = cartPayload(selected.rows[0]);
    if (!cart) throw new NotFoundException(`Cart ${cartId} was not found`);
    return cart;
  }

  private async writeLockedCart(client: PoolClient, cart: Cart): Promise<void> {
    await client.query(
      'UPDATE cart SET payload = $2::jsonb, updated_at = now() WHERE id = $1',
      [cart.id, JSON.stringify(cart)],
    );
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

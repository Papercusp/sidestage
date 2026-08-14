import type { Pool } from 'pg';
import type { CheckoutOrder, OrderStore } from '../checkout/checkout.service';

/** Durable checkout orders; the status column is lifted out for queries. */
export class PgOrderStore implements OrderStore {
  constructor(private readonly pool: Pool) {}

  async get(id: string): Promise<CheckoutOrder | undefined> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      'SELECT payload FROM checkout_order WHERE id = $1',
      [id],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async findPendingByCart(cartId: string, buyerId: string): Promise<CheckoutOrder | undefined> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      "SELECT payload FROM checkout_order WHERE cart_id = $1 AND payload->>'buyerId' = $2 AND status = 'pending' ORDER BY updated_at DESC LIMIT 1",
      [cartId, buyerId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async listByBuyer(buyerId: string): Promise<CheckoutOrder[]> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      "SELECT payload FROM checkout_order WHERE payload->>'buyerId' = $1 ORDER BY updated_at DESC LIMIT 200",
      [buyerId],
    );
    return result.rows.map((row) => row.payload);
  }

  async set(order: CheckoutOrder): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkout_order (id, cart_id, status, payload, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET cart_id = EXCLUDED.cart_id, status = EXCLUDED.status,
             payload = EXCLUDED.payload, updated_at = now()`,
      [order.id, order.cartId, order.status, JSON.stringify(order)],
    );
  }
}

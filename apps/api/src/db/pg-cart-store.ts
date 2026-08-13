import type { Pool } from 'pg';
import type { Cart, CartStore } from '../cart/cart.service';

/**
 * Durable cart storage. The cart document keeps its service-level shape and is
 * stored whole as jsonb — carts are single-writer session documents, so a
 * normalized item table would buy nothing but joins.
 */
export class PgCartStore implements CartStore {
  constructor(private readonly pool: Pool) {}

  async get(id: string): Promise<Cart | undefined> {
    const result = await this.pool.query<{ payload: Cart }>(
      'SELECT payload FROM cart WHERE id = $1',
      [id],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async set(cart: Cart): Promise<void> {
    await this.pool.query(
      `INSERT INTO cart (id, payload, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [cart.id, JSON.stringify(cart)],
    );
  }
}

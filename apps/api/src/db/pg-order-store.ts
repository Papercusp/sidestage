import type { Pool } from 'pg';
import type {
  CheckoutOrder,
  OrderStore,
  PayableOrderSourceKind,
} from '../checkout/checkout.service';

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

  async findBySource(sourceKind: PayableOrderSourceKind, sourceId: string): Promise<CheckoutOrder | undefined> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      'SELECT payload FROM checkout_order WHERE source_kind = $1 AND source_id = $2 LIMIT 1',
      [sourceKind, sourceId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async findByPaymentIntent(paymentIntentId: string): Promise<CheckoutOrder | undefined> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      'SELECT payload FROM checkout_order WHERE stripe_payment_intent_id = $1 LIMIT 1',
      [paymentIntentId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async listByBuyer(buyerId: string): Promise<CheckoutOrder[]> {
    const result = await this.pool.query<{ payload: CheckoutOrder }>(
      'SELECT payload FROM checkout_order WHERE buyer_id = $1 ORDER BY updated_at DESC LIMIT 200',
      [buyerId],
    );
    return result.rows.map((row) => row.payload);
  }

  async set(order: CheckoutOrder): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkout_order
         (id, cart_id, buyer_id, source_kind, source_id, status, payment_state,
          stripe_payment_intent_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET cart_id = EXCLUDED.cart_id,
             status = EXCLUDED.status,
             payment_state = EXCLUDED.payment_state,
             stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
             payload = EXCLUDED.payload,
             updated_at = now()`,
      [
        order.id,
        order.cartId ?? null,
        order.buyerId,
        order.sourceKind,
        order.sourceId,
        order.status,
        order.paymentState,
        order.stripePaymentIntentId ?? null,
        JSON.stringify(order),
      ],
    );
  }
}

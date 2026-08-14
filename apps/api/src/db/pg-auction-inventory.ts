import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import type {
  AuctionInventory,
  AuctionInventorySnapshot,
  InventoryHoldSource,
} from '../auction/auction.service';

interface VariantRow {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
  priceCents: number;
}

/**
 * Durable auction inventory over storefront_product + inventory_reservation.
 * Holds go through the schema's source-tracked reserve_inventory() /
 * release_inventory() primitives, so every hold is idempotent per
 * (source, variant) and reserved_qty stays derived by trigger — restart-safe,
 * unlike a counter bump.
 */
export class PgAuctionInventory implements AuctionInventory {
  constructor(private readonly pool: Pool) {}

  async get(productId: string): Promise<AuctionInventorySnapshot | undefined> {
    await this.pool.query('SELECT expire_inventory_reservations()');
    const result = await this.pool.query<VariantRow>(
      'SELECT id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents" FROM storefront_product WHERE id = $1',
      [productId],
    );
    return result.rows[0] ?? undefined;
  }

  async seed(productId: string, qty: number, reservedQty = 0): Promise<AuctionInventorySnapshot> {
    const id = productId.trim();
    if (!id || id.length > 120) throw new BadRequestException('productId is required and must be 120 characters or fewer');
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('qty must be a non-negative integer');
    if (!Number.isInteger(reservedQty) || reservedQty < 0 || reservedQty > qty) {
      throw new BadRequestException('reservedQty must be an integer between 0 and qty');
    }
    // Event setup on a clean clone may reference a product that is not in the
    // catalog yet; create a minimal sellable variant so the auction can hold it.
    const result = await this.pool.query<VariantRow>(
      `INSERT INTO storefront_product (id, slug, region, sku, price_cents, active, qty, reserved_qty)
       VALUES ($1, $1, 'US', upper(regexp_replace($1, '[^A-Za-z0-9]+', '-', 'g')), 0, true, $2, $3)
       ON CONFLICT (id) DO UPDATE SET qty = EXCLUDED.qty, reserved_qty = EXCLUDED.reserved_qty
       RETURNING id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents"`,
      [id, qty, reservedQty],
    );
    return result.rows[0];
  }

  async restock(productId: string, quantity: number, priceCents?: number): Promise<AuctionInventorySnapshot | undefined> {
    const id = productId.trim();
    if (!id || id.length > 120) throw new BadRequestException('productId is required and must be 120 characters or fewer');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    if (priceCents !== undefined && (!Number.isInteger(priceCents) || priceCents < 0)) {
      throw new BadRequestException('priceCents must be a non-negative integer');
    }
    const result = await this.pool.query<VariantRow>(
      `UPDATE storefront_product
          SET qty = qty + $2,
              price_cents = COALESCE($3, price_cents),
              updated_at = now()
        WHERE id = $1
        RETURNING id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents"`,
      [id, quantity, priceCents ?? null],
    );
    return result.rows[0] ?? undefined;
  }

  async reserve(productId: string, quantity: number, source: InventoryHoldSource, expiresAt?: string): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    try {
      await this.pool.query('SELECT expire_inventory_reservations()');
      await this.pool.query('SELECT reserve_inventory($1, $2, $3, $4, $5)', [productId, source.kind, source.id, quantity, expiresAt ?? null]);
      return true;
    } catch (error) {
      // reserve_inventory raises for a missing variant or insufficient stock;
      // both mean "the hold was not placed", which is this seam's false.
      if (error instanceof Error && /insufficient inventory|was not found/i.test(error.message)) return false;
      throw error;
    }
  }

  async release(productId: string, _quantity: number, source: InventoryHoldSource): Promise<boolean> {
    const result = await this.pool.query<{ released: boolean }>(
      'SELECT release_inventory($1, $2, $3) AS released',
      [source.kind, source.id, productId],
    );
    return result.rows[0]?.released ?? false;
  }

  async commit(productId: string, source: InventoryHoldSource): Promise<boolean> {
    const result = await this.pool.query<{ committed: boolean }>(
      'SELECT commit_inventory($1, $2, $3) AS committed',
      [source.kind, source.id, productId],
    );
    return result.rows[0]?.committed ?? false;
  }
}

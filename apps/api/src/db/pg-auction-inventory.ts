import { BadRequestException, ConflictException } from '@nestjs/common';
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

  async getOwned(productId: string, sellerId: string): Promise<AuctionInventorySnapshot | undefined> {
    await this.pool.query('SELECT expire_inventory_reservations()');
    const result = await this.pool.query<VariantRow>(
      'SELECT id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents" FROM storefront_product WHERE id = $1 AND seller_id = $2',
      [productId, sellerId],
    );
    return result.rows[0] ?? undefined;
  }

  async seed(productId: string, qty: number, reservedQty = 0, sellerId = 'demo-seller'): Promise<AuctionInventorySnapshot> {
    const id = productId.trim();
    if (!id || id.length > 120) throw new BadRequestException('productId is required and must be 120 characters or fewer');
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('qty must be a non-negative integer');
    if (!Number.isInteger(reservedQty) || reservedQty < 0 || reservedQty > qty) {
      throw new BadRequestException('reservedQty must be an integer between 0 and qty');
    }
    // Event setup on a clean clone may reference a product that is not in the
    // catalog yet; create a minimal sellable variant so the auction can hold it.
    const result = await this.pool.query<VariantRow>(
      `INSERT INTO storefront_product (id, slug, region, sku, price_cents, active, qty, reserved_qty, seller_id)
       VALUES ($1, $1, 'US', upper(regexp_replace($1, '[^A-Za-z0-9]+', '-', 'g')), 0, true, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET qty = EXCLUDED.qty, reserved_qty = EXCLUDED.reserved_qty
         WHERE storefront_product.seller_id = EXCLUDED.seller_id
       RETURNING id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents"`,
      [id, qty, reservedQty, sellerId],
    );
    if (!result.rows[0]) throw new ConflictException(`Inventory item ${id} belongs to another seller`);
    return result.rows[0];
  }

  async save(productId: string, quantity: number, priceCents: number): Promise<AuctionInventorySnapshot | undefined> {
    return this.saveScoped(productId, quantity, priceCents);
  }

  async saveOwned(productId: string, quantity: number, priceCents: number, sellerId: string): Promise<AuctionInventorySnapshot | undefined> {
    return this.saveScoped(productId, quantity, priceCents, sellerId);
  }

  private async saveScoped(productId: string, quantity: number, priceCents: number, sellerId?: string): Promise<AuctionInventorySnapshot | undefined> {
    const id = productId.trim();
    if (!id || id.length > 120) throw new BadRequestException('productId is required and must be 120 characters or fewer');
    if (!Number.isInteger(quantity) || quantity < 0) throw new BadRequestException('quantity must be a non-negative integer');
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new BadRequestException('priceCents must be a non-negative integer');
    const result = await this.pool.query<VariantRow>(
      `UPDATE storefront_product
          SET qty = $2,
              price_cents = $3,
              updated_at = now()
        WHERE id = $1 AND reserved_qty <= $2
          AND ($4::text IS NULL OR seller_id = $4)
        RETURNING id AS "productId", qty, reserved_qty AS "reservedQty", "availableQty", price_cents AS "priceCents"`,
      [id, quantity, priceCents, sellerId ?? null],
    );
    if (result.rows[0]) return result.rows[0];
    const current = await this.pool.query<{ reservedQty: number }>(
      'SELECT reserved_qty AS "reservedQty" FROM storefront_product WHERE id = $1 AND ($2::text IS NULL OR seller_id = $2)',
      [id, sellerId ?? null],
    );
    if (current.rows[0] && quantity < current.rows[0].reservedQty) {
      throw new ConflictException(`Quantity cannot be lower than ${current.rows[0].reservedQty} reserved units for ${id}`);
    }
    return undefined;
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

  async reserveOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string, expiresAt?: string): Promise<boolean> {
    if (!(await this.owned(productId, sellerId))) return false;
    return this.reserve(productId, quantity, source, expiresAt);
  }

  async release(productId: string, _quantity: number, source: InventoryHoldSource): Promise<boolean> {
    const result = await this.pool.query<{ released: boolean }>(
      'SELECT release_inventory($1, $2, $3) AS released',
      [source.kind, source.id, productId],
    );
    return result.rows[0]?.released ?? false;
  }

  async releaseOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string): Promise<boolean> {
    if (!(await this.owned(productId, sellerId))) return false;
    return this.release(productId, quantity, source);
  }

  async commit(productId: string, source: InventoryHoldSource): Promise<boolean> {
    const result = await this.pool.query<{ committed: boolean }>(
      'SELECT commit_inventory($1, $2, $3) AS committed',
      [source.kind, source.id, productId],
    );
    return result.rows[0]?.committed ?? false;
  }

  private async owned(productId: string, sellerId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM storefront_product WHERE id = $1 AND seller_id = $2',
      [productId, sellerId],
    );
    return result.rows.length > 0;
  }
}

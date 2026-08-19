import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';
import type {
  AuctionInventory,
  AuctionInventorySnapshot,
  InventoryHoldSource,
} from '../auction/auction.service';
import { sellerListingId } from '../auction/auction.service';

/** Postgres SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = '23505';

interface VariantRow {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
  priceCents: number;
}

interface ListingIdentityRow {
  id: string;
  groupId: string | null;
  region: string;
  optionSignature: string;
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

  async onboardOwned(sourceProductId: string, quantity: number, priceCents: number, sellerId: string): Promise<AuctionInventorySnapshot | undefined> {
    const sourceId = sourceProductId.trim();
    const owner = sellerId.trim();
    if (!sourceId || sourceId.length > 120) throw new BadRequestException('sourceProductId is required and must be 120 characters or fewer');
    if (!owner || owner.length > 120) throw new BadRequestException('sellerId is required and must be 120 characters or fewer');
    if (!Number.isInteger(quantity) || quantity < 0) throw new BadRequestException('quantity must be a non-negative integer');
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new BadRequestException('priceCents must be a non-negative integer');

    const source = await this.pool.query<ListingIdentityRow>(
      `SELECT id, group_id AS "groupId", region, option_signature AS "optionSignature"
         FROM storefront_product
        WHERE id = $1 AND active`,
      [sourceId],
    );
    const identity = source.rows[0];
    if (!identity) return undefined;
    // EI-20739798038041966 / prod 500, 2026-08-19. The derived id is a function
    // of (seller, group, region, signature) — the SAME tuple that
    // `storefront_product_seller_group_signature_unique` covers — so onboarding
    // twice normally collides on the PRIMARY KEY and the guarded ON CONFLICT (id)
    // below absorbs it. It does NOT absorb a row holding that natural key under a
    // DIFFERENT id, which is what every hand-seeded listing is (e.g.
    // `sidestage-onboarding-harbor-kettle-v1`). That raised a bare 23505 out of
    // the driver and Nest rendered it as `500 Internal server error` — an
    // ordinary "you already stock this" reported as the server being broken.
    // Targeting the row that already holds the natural key makes the operation
    // idempotent instead, which is what "onboard with this qty and price" means.
    const targetId = await this.existingListingId(owner, identity) ?? this.listingIdFor(owner, identity);
    // slug+region and region+SKU are global uniqueness boundaries, so the
    // qualifier must carry BOTH hashes from sellerListingId. Using only its
    // trailing source hash makes two sellers cloning the same public variant
    // collide even though their primary listing ids are correctly distinct.
    const qualifier = targetId.slice('seller-listing-'.length);
    const result = await this.pool.query<VariantRow>(
      `WITH upserted AS (
         INSERT INTO storefront_product
           (id, slug, region, sku, price_cents, active, group_id, condition, handling,
            option_signature, variant_images, qty, reserved_qty, seller_id)
         SELECT $2,
                source.slug || '-' || $3,
                source.region,
                source.sku || '-' || upper($3),
                $4,
                source.active,
                source.group_id,
                source.condition,
                source.handling,
                source.option_signature,
                source.variant_images,
                $5,
                0,
                $6
           FROM storefront_product AS source
          WHERE source.id = $1 AND source.active
         ON CONFLICT (id) DO UPDATE
           SET qty = EXCLUDED.qty,
               price_cents = EXCLUDED.price_cents,
               updated_at = now()
         WHERE storefront_product.seller_id = EXCLUDED.seller_id
           AND storefront_product.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
           AND storefront_product.region = EXCLUDED.region
           AND storefront_product.option_signature = EXCLUDED.option_signature
           AND storefront_product.reserved_qty <= EXCLUDED.qty
         RETURNING id AS "productId", qty, reserved_qty AS "reservedQty",
                   "availableQty", price_cents AS "priceCents"
       ), copied_options AS (
         INSERT INTO storefront_product_option (variant_id, axis_id, value_id)
         SELECT upserted."productId", source_option.axis_id, source_option.value_id
           FROM upserted
           JOIN storefront_product_option AS source_option
             ON source_option.variant_id = $1
         ON CONFLICT (variant_id, axis_id) DO NOTHING
       )
       SELECT "productId", qty, "reservedQty", "availableQty", "priceCents"
         FROM upserted`,
      [sourceId, targetId, qualifier, priceCents, quantity, owner],
    ).catch((error: unknown) => {
      // Belt and braces for the class above: ANY residual unique violation is a
      // statement about the CALLER's request ("you already stock this"), never
      // about the server. Letting the driver's 23505 escape renders it as a bare
      // 500, which is indistinguishable from an outage to the UI and to anyone
      // reading logs — the exact failure this endpoint shipped with.
      if ((error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) {
        throw new ConflictException(
          `This seller already stocks catalog variant ${sourceId}; onboarding it again would duplicate that listing.`,
        );
      }
      throw error;
    });
    if (result.rows[0]) return result.rows[0];
    const current = await this.pool.query<{ reservedQty: number }>(
      'SELECT reserved_qty AS "reservedQty" FROM storefront_product WHERE id = $1 AND seller_id = $2',
      [targetId, owner],
    );
    if (current.rows[0] && quantity < current.rows[0].reservedQty) {
      throw new ConflictException(`Quantity cannot be lower than ${current.rows[0].reservedQty} reserved units for ${targetId}`);
    }
    throw new ConflictException(`Catalog variant ${sourceId} could not be onboarded for this seller`);
  }

  async resolveOwnedProductId(productId: string, sellerId: string): Promise<string | undefined> {
    const id = productId.trim();
    const owner = sellerId.trim();
    if (!id || !owner) return undefined;
    if (await this.ownsRow(id, owner)) return id;
    const source = await this.pool.query<ListingIdentityRow>(
      `SELECT id, group_id AS "groupId", region, option_signature AS "optionSignature"
         FROM storefront_product
        WHERE id = $1 AND active`,
      [id],
    );
    const identity = source.rows[0];
    if (!identity) return undefined;
    const derived = this.listingIdFor(owner, identity);
    return await this.ownsRow(derived, owner) ? derived : undefined;
  }

  private async ownsRow(productId: string, sellerId: string): Promise<boolean> {
    const owned = await this.pool.query(
      'SELECT 1 FROM storefront_product WHERE id = $1 AND seller_id = $2',
      [productId, sellerId],
    );
    return owned.rows.length > 0;
  }

  /**
   * The id this seller ALREADY holds for the source's product identity, if any.
   *
   * `storefront_product_seller_group_signature_unique` — not the primary key —
   * is the real "one listing per product per seller" rule, and a row can satisfy
   * it under an id this class never derived (anything hand-seeded or imported).
   * Reading it first is what keeps onboarding idempotent for those rows.
   */
  private async existingListingId(
    sellerId: string,
    identity: ListingIdentityRow,
  ): Promise<string | undefined> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM storefront_product
        WHERE seller_id = $1
          AND group_id IS NOT DISTINCT FROM $2
          AND region = $3
          AND option_signature = $4
        LIMIT 1`,
      [sellerId, identity.groupId, identity.region, identity.optionSignature],
    );
    return existing.rows[0]?.id;
  }

  /** Must match onboardOwned's target so a hold finds the row onboarding created. */
  private listingIdFor(sellerId: string, identity: ListingIdentityRow): string {
    return sellerListingId(
      sellerId,
      `${identity.groupId ?? identity.id}\0${identity.region}\0${identity.optionSignature}`,
    );
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

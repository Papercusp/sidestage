# SideStage generalized variations

Status: P-003 design artifact (WI-38474). This is the schema contract for the
catalog, seller event items, buyer picker, and inventory paths. It is intentionally
portable SQL/Drizzle guidance: P-001 owns the app/migration bootstrap, while P-002
owns the Restart data dump.

## Design choice

Reuse Restart's `product_catalog` as the parent read model and
`storefront_product` as the per-variant inventory row. Do not introduce a second
`product_variants` table: every row in `storefront_product` already has a stable
variant id, price, quantity, reservation state, and a `groupId`/region parent.
Add normalized option metadata around that row:

```text
product_catalog (group_id, region, title, properties, images, ...)
  └─ product_option_axes (id, group_id, region, slug, label, position, required)
       └─ product_option_values (id, axis_id, slug, label, position, metadata)
              └─ storefront_product_option (variant_id, axis_id, value_id)
                     └─ storefront_product (variant_id, sku, price, qty, ...)
```

`product_catalog` remains the grounding source for title, description, images, and
typed properties. The option tables are the source for picker labels and valid
combinations. `storefront_product` remains the source for sellable price and
inventory. Event items reference the variant id, never only the parent group id.

## Tables and constraints

The P-001 migration should add the following tables (SQL names are shown; Drizzle
properties can stay camelCase):

| table | required columns | invariants |
| --- | --- | --- |
| `product_option_axes` | `id`, `group_id`, `region`, `slug`, `label`, `position`, `required` | unique `(group_id, region, slug)` and `(group_id, region, position)`; `position >= 0`; slug is lowercase kebab-case |
| `product_option_values` | `id`, `axis_id`, `slug`, `label`, `position`, `metadata jsonb` | unique `(axis_id, slug)` and `(axis_id, position)`; `position >= 0`; value belongs to exactly one axis |
| `storefront_product_option` | `variant_id`, `axis_id`, `value_id` | FK to the variant and axis; composite FK `(axis_id, value_id)` to the value; unique `(variant_id, axis_id)` |

Extend the imported `storefront_product` row rather than replacing it:

- `sku text NOT NULL` with a case-insensitive unique index on `(region, sku)`;
- `option_signature text NOT NULL`, unique for `(groupId, region,
  option_signature)` where `groupId IS NOT NULL`; the signature is the sorted,
  escaped `axisSlug=valueSlug` list, or `base` for a product with no options;
- `variant_images jsonb NOT NULL DEFAULT '[]'`, holding `{url, alt, isPrimary}`
  values specific to this variant;
- retain Restart's `qty`, `reserved_qty`, and quoted `availableQty` compatibility
  columns during the first import. Services must never write `reserved_qty` or
  `availableQty` directly.

Required axes are enforced in the command transaction (one value per required
axis, no unknown axis/value ids). The database constraints prevent duplicate
values and duplicate combinations; the service validates that a variant has all
required axes before commit so a partially mapped variant cannot become sellable.

## Restart import mapping

Restart's existing `condition` and `handling` dimensions are real variant
dimensions. The import must not discard them or flatten them into product JSON.
For each `(groupId, region)`:

1. Create deterministic synthetic axes `condition` and `handling` only when those
   columns are populated.
2. Upsert values from the existing normalized forms (`NEW`, `REF`, `B`, `C`, and
   integer handling days), preserving display labels in `metadata`.
3. Map every existing `storefront_product.id` to its option values and derive a
   stable `option_signature` and SKU. Preserve the original variant id, price,
   qty, reservation state, slug, and parent group.
4. Leave a nullable legacy `condition`/`handling` read path until all imported
   callers move to the option join. New SideStage variants use the generic option
   tables; they do not add another special-case dimension.

The migration is idempotent: rerunning it must use the deterministic axis/value
slugs and variant ids, and must fail loudly on a conflicting SKU or signature
instead of creating a second variant.

## Reservation and availability contract

Use one recomputation function, scoped when possible:

```text
recompute_variant_reserved_qty(variant_ids text[] | NULL)
  -> SUM active inventory reservations by variant
  -> write storefront_product.reserved_qty
  -> availableQty = GREATEST(0, qty - reserved_qty)
```

The existing Restart order/quote reservation sources remain valid during the
port. SideStage event holds and auction holds should be represented by a single
`inventory_reservation` table (`variant_id`, `source_kind`, `source_id`,
`quantity`, `state`, `expires_at`) rather than adding one trigger family per new
feature. Active states are `held` and `committed`; expired holds are transitioned
to `expired` by the expiry job, which fires the same recomputation path. A source
must have a unique `(source_kind, source_id, variant_id)` key so retries are
idempotent.

Allocation is one transaction: lock the variant row, recheck
`qty - reserved_qty >= requested`, insert/update the reservation, and let the
trigger/recompute path update `reserved_qty`. Reject insufficient inventory with
a typed error. This prevents two concurrent buyers, bids, or offers from
overselling the same row. A quantity update must preserve `reserved_qty`; a
reservation release must make the formerly available quantity visible again.

Event listing quantity is not automatically reserved: an event item stores its
`variant_id`, seller `offer_price_cents`, and optional `quantity_limit`. Only a
checkout hold, accepted offer, or auction hold creates an inventory reservation.

## Variant picker contract

The catalog/event read model returns normalized axes plus compact variants:

```ts
type VariantPickerData = {
  productId: string;             // group_id + region parent
  axes: Array<{
    id: string;
    slug: string;
    label: string;
    position: number;
    required: boolean;
    values: Array<{ id: string; slug: string; label: string; position: number }>;
  }>;
  variants: Array<{
    id: string;
    sku: string;
    optionValueIds: string[];    // ordered by axis.position
    priceCents: number;
    availableQty: number;
    images: Array<{ url: string; alt?: string; isPrimary: boolean }>;
  }>;
  defaultVariantId: string | null;
};
```

The client keeps a selection map keyed by axis id, derives the canonical
signature in axis order, and resolves the variant from an indexed signature map.
Unavailable values are disabled when no active variant with the current partial
selection has stock. A complete selection with zero stock remains visible but
disabled; it must not silently choose a different SKU. If a product has no axes,
return its sole `base` variant and skip the picker UI.

## Demo seed and verification

Seed data must exercise the cross-product, not only one dimension. Use an
idempotent transaction with at least:

- `linen-hoodie`: `Color` (Red, Blue) × `Size` (S, M), four variants with distinct
  SKUs, prices, quantities, and at least one variant-specific image;
- `stoneware-mug`: `Finish` (Matte, Gloss) × `Capacity` (12oz, 16oz), four
  variants, including one zero-stock row;
- one no-option base product to prove the picker fallback.

The P-003 test set must prove: duplicate axis/value/combination rejection; stable
signature and SKU uniqueness; required-axis validation; correct partial-selection
availability; seed idempotency; reservation allocation/release under concurrent
requests; `availableQty = max(0, qty - reserved_qty)`; and preservation of
reservations when stock sync updates price or qty.

## Delivery order

1. P-001 creates the app migration/test harness and imports the shared Restart
   schema names.
2. P-002 supplies the catalog/storefront dump and clean-clone seed baseline.
3. Implement this model and tests before P-006/P-017 event and auction writes.
4. P-019/P-020 consume `VariantPickerData` and reservation errors; they must pass
   `variant_id` through cart, offer, bid, and checkout paths.


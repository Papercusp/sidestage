#!/usr/bin/env bash
# load-restart-catalog.sh — Load the real Restart catalog into the SideStage DB.
#
# Companion to export-restart-catalog.sh. That script produces a portable SQL
# artifact; THIS one streams the two catalog tables directly from a Restart
# Postgres into SideStage's Postgres, adapting the real Restart shapes to the
# SideStage port along the way:
#
#   • Restart allows NULL in images/bullets/weight/dimensions where the
#     SideStage port declares NOT NULL with defaults → COALESCE'd here.
#   • Restart's storefront_product uses camelCase columns (groupId, priceCents,
#     createdAt, updatedAt) and has no sku / option_signature / variant_images
#     → mapped and synthesized here (sku from slug, first variant per group is
#     'base', later ones get a deterministic legacy signature).
#   • Orphan variants (groupId with no catalog row) keep the variant but drop
#     the group link, matching the FK's ON DELETE SET NULL semantics.
#
# Idempotent: every insert is ON CONFLICT DO NOTHING, so demo rows and re-runs
# are safe. Production data never lands in the repo — only in the local DB.
#
# Usage:
#   RESTART_DATABASE_URL=postgres://…/restart \
#   SIDESTAGE_DATABASE_URL=postgres://…/sidestage \
#     ./scripts/load-restart-catalog.sh
set -Eeuo pipefail

SOURCE_URL="${RESTART_DATABASE_URL:-${DATABASE_URL:-}}"
TARGET_URL="${SIDESTAGE_DATABASE_URL:-postgresql://sidestage:dev-only-change-me@localhost:5432/sidestage}"

if [[ -z "$SOURCE_URL" ]]; then
  echo "Set RESTART_DATABASE_URL (or DATABASE_URL) to the Restart Postgres URL." >&2
  exit 2
fi
for tool in pg_dump psql sed; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

echo "==> Preparing staging tables"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 --quiet <<'SQL'
DROP TABLE IF EXISTS _restart_catalog_stage;
DROP TABLE IF EXISTS _restart_storefront_stage;

CREATE TABLE _restart_catalog_stage (LIKE product_catalog INCLUDING DEFAULTS);
DO $$
DECLARE col text;
BEGIN
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = '_restart_catalog_stage'
  LOOP
    EXECUTE format('ALTER TABLE _restart_catalog_stage ALTER COLUMN %I DROP NOT NULL', col);
  END LOOP;
END $$;

-- Restart's real storefront shape, camelCase and all.
CREATE TABLE _restart_storefront_stage (
  id text, slug text, active boolean,
  "createdAt" timestamptz, "updatedAt" timestamptz,
  "groupId" text, condition text, handling integer,
  "priceCents" integer, qty integer, reserved_qty integer,
  "availableQty" integer, region text
);
SQL

echo "==> Streaming catalog data from Restart (2 tables; this takes a few minutes)"
pg_dump "$SOURCE_URL" \
  --data-only --no-owner --no-privileges \
  --table=product_catalog --table=storefront_product \
| sed \
    -e '/^SET transaction_timeout = 0;$/d' \
    -e 's/^COPY public\.product_catalog /COPY public._restart_catalog_stage /' \
    -e 's/^COPY public\.storefront_product /COPY public._restart_storefront_stage /' \
| psql "$TARGET_URL" -v ON_ERROR_STOP=1 --quiet

echo "==> Merging into SideStage tables (normalizing Restart NULLs + shapes)"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 --quiet <<'SQL'
INSERT INTO product_catalog (
  group_id, region, product_type, title, description, brand, manufacturer,
  country_of_origin, variant_slug, identifiers, properties, images, bullets,
  weight, dimensions,
  tier_1, tier_1_discount, tier_2, tier_2_discount, tier_3, tier_3_discount,
  tier_4, tier_4_discount, tier_5, tier_5_discount,
  created_at, updated_at
)
SELECT
  group_id, COALESCE(region, 'US'), product_type, title,
  COALESCE(description, ''), COALESCE(brand, ''), manufacturer,
  country_of_origin, variant_slug,
  COALESCE(identifiers, '{}'::jsonb), COALESCE(properties, '{}'::jsonb),
  COALESCE(images, '[]'::jsonb), COALESCE(bullets, '[]'::jsonb),
  weight, dimensions,
  COALESCE(tier_1, 5), COALESCE(tier_1_discount, 3),
  COALESCE(tier_2, 10), COALESCE(tier_2_discount, 5),
  COALESCE(tier_3, 23), COALESCE(tier_3_discount, 6),
  COALESCE(tier_4, 35), COALESCE(tier_4_discount, 8),
  COALESCE(tier_5, 50), COALESCE(tier_5_discount, 10),
  COALESCE(created_at, now()), COALESCE(updated_at, now())
FROM _restart_catalog_stage
WHERE group_id IS NOT NULL AND title IS NOT NULL AND product_type IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO storefront_product (
  id, slug, region, sku, price_cents, active, group_id, condition, handling,
  option_signature, variant_images, qty, reserved_qty, created_at, updated_at
)
SELECT
  s.id, s.slug, COALESCE(s.region, 'US'),
  upper(regexp_replace(s.slug, '[^A-Za-z0-9]+', '-', 'g')),
  COALESCE(s."priceCents", 0), COALESCE(s.active, true),
  CASE WHEN c.group_id IS NULL THEN NULL ELSE s."groupId" END,
  s.condition, s.handling,
  CASE
    WHEN row_number() OVER (
      PARTITION BY s."groupId", COALESCE(s.region, 'US') ORDER BY s.id
    ) = 1 THEN 'base'
    ELSE 'legacy=' || lower(regexp_replace(s.slug, '[^a-z0-9]+', '-', 'g'))
  END,
  '[]'::jsonb, COALESCE(s.qty, 0), COALESCE(s.reserved_qty, 0),
  COALESCE(s."createdAt", now()), COALESCE(s."updatedAt", now())
FROM _restart_storefront_stage s
LEFT JOIN product_catalog c
  ON c.group_id = s."groupId" AND c.region = COALESCE(s.region, 'US')
WHERE s.id IS NOT NULL AND s.slug IS NOT NULL
ON CONFLICT DO NOTHING;

DROP TABLE _restart_catalog_stage;
DROP TABLE _restart_storefront_stage;
ANALYZE product_catalog;
ANALYZE storefront_product;
SQL

psql "$TARGET_URL" -tA <<'SQL'
SELECT 'product_catalog rows: ' || count(*) FROM product_catalog;
SELECT 'storefront_product rows: ' || count(*) FROM storefront_product;
SELECT 'catalog rows missing search_tsv: ' || count(*) FROM product_catalog WHERE search_tsv IS NULL;
SQL
echo "==> Done."

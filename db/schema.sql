-- SideStage product data model
--
-- This is the deliberately small, public-clone-friendly slice of Restart's
-- catalog that SideStage needs for browsing, event setup, and variant-aware
-- selling.  Product descriptions and image metadata live on product_catalog;
-- each sellable condition/handling combination is a storefront_product row.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS product_catalog (
  group_id text NOT NULL,
  region text NOT NULL DEFAULT 'US',
  product_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  brand text NOT NULL DEFAULT '',
  manufacturer text,
  country_of_origin text,
  variant_slug text,
  identifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  bullets jsonb NOT NULL DEFAULT '[]'::jsonb,
  weight jsonb,
  dimensions jsonb,
  tier_1 integer NOT NULL DEFAULT 5 CHECK (tier_1 > 0),
  tier_1_discount integer NOT NULL DEFAULT 3 CHECK (tier_1_discount BETWEEN 0 AND 100),
  tier_2 integer NOT NULL DEFAULT 10 CHECK (tier_2 > tier_1),
  tier_2_discount integer NOT NULL DEFAULT 5 CHECK (tier_2_discount BETWEEN 0 AND 100),
  tier_3 integer NOT NULL DEFAULT 23 CHECK (tier_3 > tier_2),
  tier_3_discount integer NOT NULL DEFAULT 6 CHECK (tier_3_discount BETWEEN 0 AND 100),
  tier_4 integer NOT NULL DEFAULT 35 CHECK (tier_4 > tier_3),
  tier_4_discount integer NOT NULL DEFAULT 8 CHECK (tier_4_discount BETWEEN 0 AND 100),
  tier_5 integer NOT NULL DEFAULT 50 CHECK (tier_5 > tier_4),
  tier_5_discount integer NOT NULL DEFAULT 10 CHECK (tier_5_discount BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Kept as a normal column rather than a generated expression: Postgres
  -- rejects the to_tsvector/concat_ws expression as non-immutable on some
  -- supported images. The trigger below keeps it current and pg_dump can
  -- still import Restart's existing search values.
  search_tsv tsvector,
  PRIMARY KEY (group_id, region),
  CONSTRAINT product_catalog_identifiers_object CHECK (jsonb_typeof(identifiers) = 'object'),
  CONSTRAINT product_catalog_properties_object CHECK (jsonb_typeof(properties) = 'object'),
  CONSTRAINT product_catalog_images_array CHECK (jsonb_typeof(images) = 'array'),
  CONSTRAINT product_catalog_bullets_array CHECK (jsonb_typeof(bullets) = 'array')
);

CREATE TABLE IF NOT EXISTS storefront_product (
  id text PRIMARY KEY,
  slug text NOT NULL,
  region text NOT NULL DEFAULT 'US',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  group_id text,
  condition text,
  handling integer CHECK (handling IS NULL OR handling >= 0),
  qty integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved_qty integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  available_qty integer GENERATED ALWAYS AS (GREATEST(0, qty - reserved_qty)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_product_group_fk
    FOREIGN KEY (group_id, region) REFERENCES product_catalog (group_id, region)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT storefront_product_condition_check
    CHECK (condition IS NULL OR condition IN ('NEW', 'REFURBISHED', 'USED', 'B', 'C')),
  CONSTRAINT storefront_product_slug_region_unique UNIQUE (slug, region)
);

CREATE INDEX IF NOT EXISTS product_catalog_search_tsv_idx
  ON product_catalog USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS product_catalog_type_idx
  ON product_catalog (region, product_type);
CREATE INDEX IF NOT EXISTS product_catalog_brand_idx
  ON product_catalog (region, brand);
CREATE INDEX IF NOT EXISTS product_catalog_properties_idx
  ON product_catalog USING GIN (properties);
CREATE INDEX IF NOT EXISTS storefront_product_active_available_idx
  ON storefront_product (region, active, available_qty);
CREATE INDEX IF NOT EXISTS storefront_product_group_idx
  ON storefront_product (region, group_id, condition, handling);
CREATE INDEX IF NOT EXISTS storefront_product_price_idx
  ON storefront_product (region, active, price_cents);
CREATE INDEX IF NOT EXISTS storefront_product_slug_trgm_idx
  ON storefront_product USING GIN (slug gin_trgm_ops);

CREATE OR REPLACE FUNCTION sidestage_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sidestage_set_catalog_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv = to_tsvector(
    'simple'::regconfig,
    concat_ws(' ', NEW.title, NEW.brand, NEW.description)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_catalog_set_search_tsv ON product_catalog;
CREATE TRIGGER product_catalog_set_search_tsv
BEFORE INSERT OR UPDATE OF title, brand, description ON product_catalog
FOR EACH ROW EXECUTE FUNCTION sidestage_set_catalog_search();

DROP TRIGGER IF EXISTS product_catalog_touch_updated_at ON product_catalog;
CREATE TRIGGER product_catalog_touch_updated_at
BEFORE UPDATE ON product_catalog
FOR EACH ROW EXECUTE FUNCTION sidestage_touch_updated_at();

DROP TRIGGER IF EXISTS storefront_product_touch_updated_at ON storefront_product;
CREATE TRIGGER storefront_product_touch_updated_at
BEFORE UPDATE ON storefront_product
FOR EACH ROW EXECUTE FUNCTION sidestage_touch_updated_at();

-- Atomic reservation primitives. Checkout/cart code can use these without
-- reading a quantity first and racing another buyer. The generalized
-- reservation triggers for future order tables build on the same columns.
CREATE OR REPLACE FUNCTION reserve_storefront_stock(
  p_product_id text,
  p_quantity integer
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'reservation quantity must be positive';
  END IF;

  UPDATE storefront_product
  SET reserved_qty = reserved_qty + p_quantity
  WHERE id = p_product_id
    AND active
    AND available_qty >= p_quantity;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION release_storefront_stock(
  p_product_id text,
  p_quantity integer
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'release quantity must be positive';
  END IF;

  UPDATE storefront_product
  SET reserved_qty = reserved_qty - p_quantity
  WHERE id = p_product_id
    AND reserved_qty >= p_quantity;

  RETURN FOUND;
END;
$$;

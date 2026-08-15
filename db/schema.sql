-- SideStage product data model
--
-- This is the deliberately small, public-clone-friendly slice of Restart's
-- catalog that SideStage needs for browsing, event setup, and variant-aware
-- selling. Restart's table and column names are retained verbatim where they
-- cross the port boundary (including quoted "availableQty").

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
  -- Keep this as a normal column: some supported Postgres images reject a
  -- generated to_tsvector expression as non-immutable.
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
  sku text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  group_id text,
  condition text,
  handling integer CHECK (handling IS NULL OR handling >= 0),
  option_signature text NOT NULL DEFAULT 'base',
  variant_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  qty integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved_qty integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  -- This quoted camelCase name is part of Restart's compatibility surface.
  "availableQty" integer GENERATED ALWAYS AS (GREATEST(0, qty - reserved_qty)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_product_group_fk
    FOREIGN KEY (group_id, region) REFERENCES product_catalog (group_id, region)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT storefront_product_condition_check
    CHECK (condition IS NULL OR condition IN ('NEW', 'REF', 'REFURBISHED', 'USED', 'B', 'C')),
  CONSTRAINT storefront_product_slug_region_unique UNIQUE (slug, region),
  CONSTRAINT storefront_product_option_signature_not_empty CHECK (option_signature <> ''),
  CONSTRAINT storefront_product_variant_images_array CHECK (jsonb_typeof(variant_images) = 'array')
);

-- The first P-002 scaffold used an unquoted available_qty generated column.
-- Rename it in-place when this file is applied to that scaffold so a rerun
-- converges on Restart's exact compatibility name instead of leaving two
-- independently computed availability columns.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'storefront_product'
      AND column_name = 'available_qty'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'storefront_product'
      AND column_name = 'availableQty'
  ) THEN
    ALTER TABLE storefront_product RENAME COLUMN available_qty TO "availableQty";
  END IF;
END;
$$;

-- Converge an already-created P-002 table without requiring a destructive
-- rebuild. New clean clones get the complete definition above directly.
ALTER TABLE storefront_product ADD COLUMN IF NOT EXISTS sku text;
UPDATE storefront_product
SET sku = upper(regexp_replace(slug, '[^A-Za-z0-9]+', '-', 'g'))
WHERE sku IS NULL;
ALTER TABLE storefront_product ALTER COLUMN sku SET NOT NULL;

ALTER TABLE storefront_product ADD COLUMN IF NOT EXISTS option_signature text NOT NULL DEFAULT 'base';
ALTER TABLE storefront_product ADD COLUMN IF NOT EXISTS variant_images jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A pre-variations Restart import can have several condition/handling rows
-- under one group while all of them still carry the temporary `base` default.
-- Give only the duplicate legacy rows a deterministic compatibility signature
-- before the uniqueness index is created below. P-002's later import mapping
-- can replace these with the normalized condition/handling axes.
WITH duplicate_signatures AS (
  SELECT id
  FROM (
    SELECT id,
      row_number() OVER (
        PARTITION BY group_id, region, option_signature
        ORDER BY id
      ) AS duplicate_number
    FROM storefront_product
    WHERE group_id IS NOT NULL
  ) AS ranked
  WHERE duplicate_number > 1
)
UPDATE storefront_product AS variant
SET option_signature = 'legacy=' || lower(regexp_replace(variant.slug, '[^a-z0-9]+', '-', 'g'))
FROM duplicate_signatures
WHERE variant.id = duplicate_signatures.id;

CREATE TABLE IF NOT EXISTS product_option_axes (
  id text PRIMARY KEY,
  group_id text NOT NULL,
  region text NOT NULL DEFAULT 'US',
  slug text NOT NULL,
  label text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  required boolean NOT NULL DEFAULT true,
  CONSTRAINT product_option_axes_group_fk
    FOREIGN KEY (group_id, region) REFERENCES product_catalog (group_id, region)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT product_option_axes_slug_format
    CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT product_option_axes_group_slug_unique UNIQUE (group_id, region, slug),
  CONSTRAINT product_option_axes_group_position_unique UNIQUE (group_id, region, position)
);

CREATE TABLE IF NOT EXISTS product_option_values (
  id text PRIMARY KEY,
  axis_id text NOT NULL,
  slug text NOT NULL,
  label text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT product_option_values_axis_fk
    FOREIGN KEY (axis_id) REFERENCES product_option_axes (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT product_option_values_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT product_option_values_axis_slug_unique UNIQUE (axis_id, slug),
  CONSTRAINT product_option_values_axis_position_unique UNIQUE (axis_id, position),
  -- The mapping table needs this pair so a value cannot be attached to an
  -- unrelated axis even when both ids are otherwise valid.
  CONSTRAINT product_option_values_axis_id_unique UNIQUE (axis_id, id),
  CONSTRAINT product_option_values_slug_format
    CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS storefront_product_option (
  variant_id text NOT NULL,
  axis_id text NOT NULL,
  value_id text NOT NULL,
  CONSTRAINT storefront_product_option_variant_fk
    FOREIGN KEY (variant_id) REFERENCES storefront_product (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT storefront_product_option_value_fk
    FOREIGN KEY (axis_id, value_id) REFERENCES product_option_values (axis_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT storefront_product_option_axis_fk
    FOREIGN KEY (axis_id) REFERENCES product_option_axes (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT storefront_product_option_variant_axis_unique UNIQUE (variant_id, axis_id)
);

CREATE TABLE IF NOT EXISTS inventory_reservation (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  variant_id text NOT NULL REFERENCES storefront_product (id) ON UPDATE CASCADE ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  state text NOT NULL DEFAULT 'held'
    CHECK (state IN ('held', 'committed', 'expired', 'released')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reservation_source_unique UNIQUE (source_kind, source_id, variant_id)
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
  ON storefront_product (region, active, "availableQty");
CREATE INDEX IF NOT EXISTS storefront_product_group_idx
  ON storefront_product (region, group_id, condition, handling);
CREATE INDEX IF NOT EXISTS storefront_product_price_idx
  ON storefront_product (region, active, price_cents);
CREATE INDEX IF NOT EXISTS storefront_product_slug_trgm_idx
  ON storefront_product USING GIN (slug gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS storefront_product_region_sku_ci_unique
  ON storefront_product (region, lower(sku));
CREATE UNIQUE INDEX IF NOT EXISTS storefront_product_group_signature_unique
  ON storefront_product (group_id, region, option_signature)
  WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storefront_product_option_value_idx
  ON storefront_product_option (axis_id, value_id, variant_id);
CREATE INDEX IF NOT EXISTS inventory_reservation_variant_state_idx
  ON inventory_reservation (variant_id, state);
CREATE INDEX IF NOT EXISTS inventory_reservation_expiry_idx
  ON inventory_reservation (expires_at)
  WHERE state = 'held' AND expires_at IS NOT NULL;

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

DROP TRIGGER IF EXISTS inventory_reservation_touch_updated_at ON inventory_reservation;
CREATE TRIGGER inventory_reservation_touch_updated_at
BEFORE UPDATE ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION sidestage_touch_updated_at();

-- Recompute from reservation rows rather than maintaining a second counter in
-- application code. Only held and committed reservations consume stock.
CREATE OR REPLACE FUNCTION recompute_variant_reserved_qty(p_variant_ids text[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE storefront_product AS variant
  SET reserved_qty = COALESCE((
    SELECT SUM(reservation.quantity)::integer
    FROM inventory_reservation AS reservation
    WHERE reservation.variant_id = variant.id
      AND reservation.state IN ('held', 'committed')
  ), 0)
  WHERE p_variant_ids IS NULL OR variant.id = ANY (p_variant_ids);
END;
$$;

CREATE OR REPLACE FUNCTION sidestage_sync_reservation_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_variant_reserved_qty(ARRAY[OLD.variant_id]);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.variant_id <> NEW.variant_id THEN
    PERFORM recompute_variant_reserved_qty(ARRAY[OLD.variant_id]);
  END IF;
  PERFORM recompute_variant_reserved_qty(ARRAY[NEW.variant_id]);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_sync_stock ON inventory_reservation;
CREATE TRIGGER inventory_reservation_sync_stock
AFTER INSERT OR UPDATE OF variant_id, quantity, state OR DELETE ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION sidestage_sync_reservation_stock();

-- Validate the required-axis contract at the service boundary before a new
-- variant is made sellable. FKs and the unique (variant, axis) key enforce
-- known values and one value per axis; this function enforces completeness.
CREATE OR REPLACE FUNCTION variant_options_valid(p_variant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM storefront_product WHERE id = p_variant_id)
    AND NOT EXISTS (
      SELECT 1
      FROM storefront_product AS variant
      JOIN product_option_axes AS axis
        ON axis.group_id = variant.group_id
       AND axis.region = variant.region
       AND axis.required
      WHERE variant.id = p_variant_id
        AND NOT EXISTS (
          SELECT 1
          FROM storefront_product_option AS selected
          WHERE selected.variant_id = variant.id
            AND selected.axis_id = axis.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM storefront_product_option AS selected
      JOIN storefront_product AS variant ON variant.id = selected.variant_id
      JOIN product_option_axes AS axis ON axis.id = selected.axis_id
      WHERE selected.variant_id = p_variant_id
        AND (axis.group_id <> variant.group_id OR axis.region <> variant.region)
    );
$$;

-- Atomic compatibility primitive retained for the existing cart/order port.
-- New event and auction holds should use reserve_inventory() below so every
-- source is represented in inventory_reservation and recomputed by trigger.
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
    AND "availableQty" >= p_quantity;

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

-- Insert or retry one source reservation while holding the variant row. The
-- unique source key makes retries idempotent, and the trigger above keeps
-- storefront_product.reserved_qty derived from the source rows.
CREATE OR REPLACE FUNCTION reserve_inventory(
  p_variant_id text,
  p_source_kind text,
  p_source_id text,
  p_quantity integer,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_available integer;
  v_seller_id text;
  v_reservation_id bigint;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'reservation quantity must be positive';
  END IF;
  IF nullif(trim(p_source_kind), '') IS NULL OR nullif(trim(p_source_id), '') IS NULL THEN
    RAISE EXCEPTION 'reservation source kind and id are required';
  END IF;

  SELECT seller_id INTO v_seller_id
  FROM storefront_product
  WHERE id = p_variant_id AND active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active variant % was not found', p_variant_id;
  END IF;

  PERFORM recompute_variant_reserved_qty(ARRAY[p_variant_id]);
  SELECT "availableQty" INTO v_available
  FROM storefront_product
  WHERE id = p_variant_id
  FOR UPDATE;
  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'insufficient inventory for variant %: requested %, available %',
      p_variant_id, p_quantity, v_available
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO inventory_reservation (variant_id, seller_id, source_kind, source_id, quantity, state, expires_at)
  VALUES (p_variant_id, v_seller_id, p_source_kind, p_source_id, p_quantity, 'held', p_expires_at)
  ON CONFLICT (source_kind, source_id, variant_id) DO UPDATE
    SET quantity = CASE
          WHEN inventory_reservation.state = 'committed' THEN inventory_reservation.quantity
          ELSE EXCLUDED.quantity
        END,
        state = CASE
          WHEN inventory_reservation.state = 'committed' THEN inventory_reservation.state
          ELSE 'held'
        END,
        expires_at = CASE
          WHEN inventory_reservation.state = 'committed' THEN inventory_reservation.expires_at
          ELSE EXCLUDED.expires_at
        END
  RETURNING id INTO v_reservation_id;

  RETURN v_reservation_id;
END;
$$;

CREATE OR REPLACE FUNCTION release_inventory(
  p_source_kind text,
  p_source_id text,
  p_variant_id text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE inventory_reservation
  SET state = 'released', expires_at = NULL
  WHERE source_kind = p_source_kind
    AND source_id = p_source_id
    AND variant_id = p_variant_id
    AND state IN ('held', 'committed', 'released');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Checkout converts an active cart hold into sold inventory. The expiry is
-- cleared so the periodic/lazy expiry sweep can never return paid stock.
CREATE OR REPLACE FUNCTION commit_inventory(
  p_source_kind text,
  p_source_id text,
  p_variant_id text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE inventory_reservation
  SET state = 'committed', expires_at = NULL
  WHERE source_kind = p_source_kind
    AND source_id = p_source_id
    AND variant_id = p_variant_id
    AND state IN ('held', 'committed');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION expire_inventory_reservations()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_expired integer;
BEGIN
  UPDATE inventory_reservation
  SET state = 'expired', expires_at = NULL
  WHERE state = 'held'
    AND expires_at IS NOT NULL
    AND expires_at <= now();
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;

-- ── Durable service state (P-101, sidestage-code-quality plan) ───────────────
-- Carts and checkout orders are single-writer session documents; each keeps its
-- service-level shape whole as jsonb, with hot filter columns lifted out.

CREATE TABLE IF NOT EXISTS cart (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- Scout conversation transcripts (P-007). Single-writer session documents like
-- the cart: the message list is stored whole as jsonb, since no query ever
-- reads one message independently of its conversation. last_active_at is not
-- bookkeeping — it is half of the transcript's ETag (count + last-write), so an
-- in-place edit of the final message still changes the version.
CREATE TABLE IF NOT EXISTS scout_session (
  id text PRIMARY KEY,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scout_session_messages_array CHECK (jsonb_typeof(messages) = 'array')
);

-- Scout long-term memory (P-012). Scope-keyed: `user:<buyerId>` holds one
-- buyer's own memories, `store` holds shared facts; a recall reads a list of
-- scopes so a turn can pull both at once.
--
-- Recall is LEXICAL, not semantic (D-008): this database has no `vector`
-- extension and the deployment sets TYPESENSE_EMBEDDING_PROVIDER=none, so
-- memory rides the same full-text + trigram machinery product_catalog already
-- uses rather than inventing a retrieval mechanism. `english` (not the
-- catalog's `simple`) because memories are natural-language sentences where
-- stemming and stopword removal are what make recall work at all.
CREATE TABLE IF NOT EXISTS scout_memory (
  id text PRIMARY KEY,
  scope text NOT NULL,
  kind text NOT NULL DEFAULT 'fact',
  text text NOT NULL,
  search_tsv tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Scope is in EVERY recall's WHERE clause, and created_at breaks rank ties.
CREATE INDEX IF NOT EXISTS scout_memory_scope_idx
  ON scout_memory (scope, created_at DESC);

CREATE INDEX IF NOT EXISTS scout_memory_search_idx
  ON scout_memory USING GIN (search_tsv);

-- The fuzzy leg: catches a near-miss the tsquery does not stem into a match.
CREATE INDEX IF NOT EXISTS scout_memory_trgm_idx
  ON scout_memory USING GIN (text gin_trgm_ops);

CREATE OR REPLACE FUNCTION sidestage_set_scout_memory_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_tsv = to_tsvector('english'::regconfig, NEW.text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scout_memory_set_search_tsv ON scout_memory;
CREATE TRIGGER scout_memory_set_search_tsv
BEFORE INSERT OR UPDATE OF text ON scout_memory
FOR EACH ROW EXECUTE FUNCTION sidestage_set_scout_memory_search();

CREATE TABLE IF NOT EXISTS checkout_order (
  id text PRIMARY KEY,
  cart_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_order_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS checkout_order_cart_status_idx
  ON checkout_order (cart_id, status);

-- Auction aggregates are transaction-owned documents. Bids are ordered and
-- settled together with the lifecycle transition, inventory hold, and winner
-- order, so keeping the aggregate whole avoids a partially-written auction
-- while the lifted columns preserve the hot event/product/buyer reads.
CREATE TABLE IF NOT EXISTS auction_state (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  event_item_id text NOT NULL,
  product_id text NOT NULL REFERENCES storefront_product (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active', 'closed')),
  quantity integer NOT NULL CHECK (quantity > 0),
  current_price_cents integer NOT NULL CHECK (current_price_cents > 0),
  winner_bidder_id text,
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  closed_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auction_state_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT auction_state_time_order CHECK (ends_at > started_at),
  CONSTRAINT auction_state_closed_at_consistent CHECK (
    (status = 'active' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS auction_state_one_active_per_event
  ON auction_state (event_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS auction_state_event_started_idx
  ON auction_state (event_id, started_at DESC);
CREATE INDEX IF NOT EXISTS auction_state_product_started_idx
  ON auction_state (product_id, started_at DESC);
CREATE INDEX IF NOT EXISTS auction_state_winner_created_idx
  ON auction_state (winner_bidder_id, closed_at DESC)
  WHERE winner_bidder_id IS NOT NULL;

-- Event configuration (P-105): name, reply tone, guardrail toggles, and the
-- copilot action policy — the settings the Config tab edits and the guardrail
-- module enforces. One jsonb document per event.
CREATE TABLE IF NOT EXISTS event_config (
  event_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_config_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- Seller Copilot review queue. The JSON payload is the auditable generation
-- snapshot; hot lifecycle columns make event/status reads and optimistic review
-- transitions cheap without splitting the provider-neutral contract apart.
CREATE TABLE IF NOT EXISTS copilot_proposal (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  source_message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'skipped', 'blocked', 'executed')),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT copilot_proposal_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT copilot_proposal_source_unique UNIQUE (event_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS copilot_proposal_event_created_idx
  ON copilot_proposal (event_id, created_at DESC);

-- The seller's run of show for one event: planned product order, per-product
-- time budgets, and talking-point notes (plan sidestage-run-of-show-planner-
-- 2026-08-14). One jsonb document per event, same shape of seam as
-- event_config: entry array order IS the planned order. Advisory only — this
-- never feeds the action guard.
CREATE TABLE IF NOT EXISTS event_run_of_show (
  event_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_run_of_show_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- ── Seller policies (P-114, docs/config-policies.md) ─────────────────────────
-- Immutable revisions behind draft→validated→published→superseded (\→rejected).
-- The whole revision is jsonb with hot columns lifted; the DB enforces one
-- published revision + monotonic revision numbers per (seller, event) scope.
-- COALESCE(event_id,'') makes NULL (seller-wide) participate in uniqueness.

CREATE TABLE IF NOT EXISTS seller_policy_revision (
  id text PRIMARY KEY,
  seller_id text NOT NULL,
  event_id text,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft', 'validated', 'published', 'superseded', 'rejected')),
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_policy_revision_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_policy_revision_scope_rev
  ON seller_policy_revision (seller_id, COALESCE(event_id, ''), revision);

CREATE UNIQUE INDEX IF NOT EXISTS seller_policy_one_published
  ON seller_policy_revision (seller_id, COALESCE(event_id, ''))
  WHERE state = 'published';

-- Immutable audit trail: every draft/validate/publish/automation decision.
CREATE TABLE IF NOT EXISTS policy_audit_entry (
  id text PRIMARY KEY,
  seller_id text NOT NULL,
  event_id text,
  policy_revision_id text,
  action text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_audit_entry_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS policy_audit_entry_scope_idx
  ON policy_audit_entry (seller_id, policy_revision_id, created_at);

-- Transactional outbox: written in the SAME transaction as the revision +
-- audit row; the sync layer drains it idempotently by event id.
CREATE TABLE IF NOT EXISTS policy_outbox_event (
  id text PRIMARY KEY,
  name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT policy_outbox_event_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS policy_outbox_event_undelivered_idx
  ON policy_outbox_event (created_at) WHERE delivered_at IS NULL;

-- Idempotency keys scoped to seller + route: a replay with the same request
-- hash returns the original response; a different hash is IDEMPOTENCY_REPLAY.
CREATE TABLE IF NOT EXISTS policy_idempotency (
  seller_id text NOT NULL,
  route text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, route, key)
);

-- ── The event directory (P-118 / D-019) ──────────────────────────────────────
-- The buyer "What's on" Channel Guide lists events across ALL sellers, so the
-- directory is its own table rather than a projection of event_config: config
-- is per-event copilot settings keyed by an id the caller already knows, while
-- THIS answers "which events exist at all", which nothing could answer before.
--
-- `status` carries the seller-controlled lifecycle and reuses the vocabulary
-- the web already speaks (EventStatus in apps/web/src/events/events.ts), so the
-- API does not invent a second set of names for the same four states. The
-- buyer-visible mapping is live→"Live now", scheduled→"Up next", ended→
-- "Ended"; `draft` is deliberately NOT buyer-visible — an unpublished event
-- must never appear in the guide, which is why the read path filters on status
-- rather than returning everything and hiding rows in the client.
--
-- viewer counts are NOT stored here: they are live chat presence, read at
-- request time from ChatService the same way /events/:id/stats does. A stored
-- counter would be a second source of truth that goes stale the moment a
-- viewer leaves.
CREATE TABLE IF NOT EXISTS event (
  event_id text PRIMARY KEY,
  title text NOT NULL,
  seller_id text NOT NULL,
  seller_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  starts_at timestamptz,
  ended_at timestamptz,
  thumbnail_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_status_known
    CHECK (status IN ('draft', 'scheduled', 'live', 'ended'))
);

-- The guide's default ordering: live first, then soonest-upcoming, then most
-- recently ended. Indexed on the two columns that ordering actually reads.
CREATE INDEX IF NOT EXISTS event_status_starts_at_idx
  ON event (status, starts_at);

-- One restart-safe lineup authority shared by seller actions and buyer-facing
-- event projections. The event/product pair is the natural membership key;
-- event_item_id remains the stable public identity even when registration is
-- repeated with refreshed presentation data.
CREATE TABLE IF NOT EXISTS event_lineup_item (
  event_item_id text PRIMARY KEY,
  event_id text NOT NULL,
  product_id text NOT NULL,
  position integer NOT NULL,
  reference_price_cents integer NOT NULL,
  current_price_cents integer NOT NULL,
  listed_quantity integer NOT NULL,
  current_quantity integer NOT NULL,
  stage_state text NOT NULL DEFAULT 'queued',
  title text NOT NULL,
  description text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_lineup_item_event_product_unique UNIQUE (event_id, product_id),
  CONSTRAINT event_lineup_item_event_fk FOREIGN KEY (event_id)
    REFERENCES event (event_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT event_lineup_item_product_fk FOREIGN KEY (product_id)
    REFERENCES storefront_product (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT event_lineup_item_position_nonnegative CHECK (position >= 0),
  CONSTRAINT event_lineup_item_reference_price_positive CHECK (reference_price_cents > 0),
  CONSTRAINT event_lineup_item_current_price_positive CHECK (current_price_cents > 0),
  CONSTRAINT event_lineup_item_listed_quantity_nonnegative CHECK (listed_quantity >= 0),
  CONSTRAINT event_lineup_item_current_quantity_nonnegative CHECK (current_quantity >= 0),
  CONSTRAINT event_lineup_item_stage_state_known
    CHECK (stage_state IN ('queued', 'on-stage', 'completed')),
  CONSTRAINT event_lineup_item_attributes_object CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT event_lineup_item_version_positive CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS event_lineup_item_event_position_idx
  ON event_lineup_item (event_id, position, event_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS event_lineup_item_one_on_stage
  ON event_lineup_item (event_id) WHERE stage_state = 'on-stage';

-- Immutable guarded-action evidence. Request ids make retried commands
-- restart-safe, while one rollback row plus rolled_back_at makes rollback
-- replay visible and rejectable across API processes.
CREATE TABLE IF NOT EXISTS action_audit_entry (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL,
  product_id text NOT NULL,
  buyer_id text,
  reason text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  client_request_id text,
  rollback_of text,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT action_audit_event_fk FOREIGN KEY (event_id)
    REFERENCES event (event_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT action_audit_rollback_fk FOREIGN KEY (rollback_of)
    REFERENCES action_audit_entry (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT action_audit_kind_known CHECK (kind IN (
    'markdown', 'targeted-offer', 'push', 'swap', 'price-adjust', 'stock-adjust', 'rollback'
  )),
  CONSTRAINT action_audit_actor_nonempty CHECK (btrim(actor_id) <> ''),
  CONSTRAINT action_audit_product_nonempty CHECK (btrim(product_id) <> ''),
  CONSTRAINT action_audit_reason_nonempty CHECK (btrim(reason) <> ''),
  CONSTRAINT action_audit_request_nonempty
    CHECK (client_request_id IS NULL OR btrim(client_request_id) <> ''),
  CONSTRAINT action_audit_snapshot_objects
    CHECK (jsonb_typeof(before_state) = 'object' AND jsonb_typeof(after_state) = 'object'),
  CONSTRAINT action_audit_rollback_shape
    CHECK ((kind = 'rollback') = (rollback_of IS NOT NULL)),
  CONSTRAINT action_audit_rollback_time
    CHECK (rolled_back_at IS NULL OR rolled_back_at >= created_at)
);

CREATE INDEX IF NOT EXISTS action_audit_event_created_idx
  ON action_audit_entry (event_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS action_audit_request_unique
  ON action_audit_entry (event_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS action_audit_rollback_unique
  ON action_audit_entry (rollback_of)
  WHERE rollback_of IS NOT NULL;

-- ── Demo-principal ownership boundary (demo-user-isolation P-002) ──────────
-- Event-anchored rows deliberately do NOT duplicate seller_id: event is the
-- owner oracle, and the foreign keys below make every dependent event id
-- resolvable through that oracle. Inventory and Scout sessions have no event
-- anchor, so they carry their seller/buyer directly.
--
-- The defaults are a rolling-deploy compatibility bridge for the old writers
-- that are live while this schema is applied. P-005/P-006 make every writer
-- explicit and then remove these defaults; the immutable-owner triggers below
-- already prevent an upsert from changing an established owner.

-- PostgreSQL stores a constant DEFAULT as table metadata, so this is instant
-- even for the million-row demo catalog instead of rewriting every row.
ALTER TABLE storefront_product
  ADD COLUMN IF NOT EXISTS seller_id text NOT NULL DEFAULT 'demo-seller';
UPDATE storefront_product
SET seller_id = 'demo-seller'
WHERE seller_id IS NULL OR btrim(seller_id) = '';
ALTER TABLE storefront_product ALTER COLUMN seller_id SET DEFAULT 'demo-seller';
ALTER TABLE storefront_product ALTER COLUMN seller_id SET NOT NULL;

ALTER TABLE inventory_reservation
  ADD COLUMN IF NOT EXISTS seller_id text NOT NULL DEFAULT 'demo-seller';
UPDATE inventory_reservation AS reservation
SET seller_id = product.seller_id
FROM storefront_product AS product
WHERE reservation.variant_id = product.id
  AND (reservation.seller_id IS NULL OR btrim(reservation.seller_id) = '');
ALTER TABLE inventory_reservation ALTER COLUMN seller_id SET DEFAULT 'demo-seller';
ALTER TABLE inventory_reservation ALTER COLUMN seller_id SET NOT NULL;

ALTER TABLE scout_session
  ADD COLUMN IF NOT EXISTS buyer_id text NOT NULL DEFAULT 'buyer-demo';
UPDATE scout_session
SET buyer_id = 'buyer-demo'
WHERE buyer_id IS NULL OR btrim(buyer_id) = '';
ALTER TABLE scout_session ALTER COLUMN buyer_id SET DEFAULT 'buyer-demo';
ALTER TABLE scout_session ALTER COLUMN buyer_id SET NOT NULL;

ALTER TABLE auction_state ADD COLUMN IF NOT EXISTS seller_id text;

-- Old snapshots can contain config/run-of-show/Copilot/auction rows created
-- before the event directory existed. Materialise one deterministic draft row
-- for each such id before installing foreign keys, so no dependent row is
-- orphaned and re-applying this file is a no-op.
WITH legacy_event_ids AS (
  SELECT event_id FROM event_config
  UNION
  SELECT event_id FROM event_run_of_show
  UNION
  SELECT event_id FROM copilot_proposal
  UNION
  SELECT event_id FROM auction_state
)
INSERT INTO event (event_id, title, seller_id, seller_name, status)
SELECT event_id, 'Legacy event ' || event_id, 'demo-seller', 'Demo Seller', 'draft'
FROM legacy_event_ids
WHERE event_id IS NOT NULL AND btrim(event_id) <> ''
ON CONFLICT (event_id) DO NOTHING;

UPDATE auction_state AS auction
SET seller_id = owner.seller_id
FROM event AS owner
WHERE auction.event_id = owner.event_id
  AND (auction.seller_id IS NULL OR btrim(auction.seller_id) = '');
ALTER TABLE auction_state ALTER COLUMN seller_id SET DEFAULT 'demo-seller';
ALTER TABLE auction_state ALTER COLUMN seller_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS event_id_seller_id_unique
  ON event (event_id, seller_id);
CREATE UNIQUE INDEX IF NOT EXISTS storefront_product_id_seller_id_unique
  ON storefront_product (id, seller_id);

CREATE INDEX IF NOT EXISTS event_seller_id_idx
  ON event (seller_id, event_id);
CREATE INDEX IF NOT EXISTS storefront_product_seller_active_idx
  ON storefront_product (seller_id, active, "availableQty");
CREATE INDEX IF NOT EXISTS inventory_reservation_seller_state_idx
  ON inventory_reservation (seller_id, state, variant_id);
CREATE INDEX IF NOT EXISTS auction_state_seller_event_idx
  ON auction_state (seller_id, event_id, started_at DESC);
CREATE INDEX IF NOT EXISTS scout_session_buyer_active_idx
  ON scout_session (buyer_id, last_active_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_config_event_fk') THEN
    ALTER TABLE event_config
      ADD CONSTRAINT event_config_event_fk FOREIGN KEY (event_id)
      REFERENCES event (event_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_run_of_show_event_fk') THEN
    ALTER TABLE event_run_of_show
      ADD CONSTRAINT event_run_of_show_event_fk FOREIGN KEY (event_id)
      REFERENCES event (event_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copilot_proposal_event_fk') THEN
    ALTER TABLE copilot_proposal
      ADD CONSTRAINT copilot_proposal_event_fk FOREIGN KEY (event_id)
      REFERENCES event (event_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auction_state_event_owner_fk') THEN
    ALTER TABLE auction_state
      ADD CONSTRAINT auction_state_event_owner_fk FOREIGN KEY (event_id, seller_id)
      REFERENCES event (event_id, seller_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_reservation_variant_owner_fk') THEN
    ALTER TABLE inventory_reservation
      ADD CONSTRAINT inventory_reservation_variant_owner_fk FOREIGN KEY (variant_id, seller_id)
      REFERENCES storefront_product (id, seller_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_product_seller_nonempty') THEN
    ALTER TABLE storefront_product ADD CONSTRAINT storefront_product_seller_nonempty
      CHECK (btrim(seller_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_reservation_seller_nonempty') THEN
    ALTER TABLE inventory_reservation ADD CONSTRAINT inventory_reservation_seller_nonempty
      CHECK (btrim(seller_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auction_state_seller_nonempty') THEN
    ALTER TABLE auction_state ADD CONSTRAINT auction_state_seller_nonempty
      CHECK (btrim(seller_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scout_session_buyer_nonempty') THEN
    ALTER TABLE scout_session ADD CONSTRAINT scout_session_buyer_nonempty
      CHECK (btrim(buyer_id) <> '');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidestage_preserve_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) ->> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0]) THEN
    RAISE EXCEPTION '% owner is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS event_preserve_seller ON event;
CREATE TRIGGER event_preserve_seller
BEFORE UPDATE OF seller_id ON event
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('seller_id');

DROP TRIGGER IF EXISTS storefront_product_preserve_seller ON storefront_product;
CREATE TRIGGER storefront_product_preserve_seller
BEFORE UPDATE OF seller_id ON storefront_product
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('seller_id');

DROP TRIGGER IF EXISTS inventory_reservation_preserve_seller ON inventory_reservation;
CREATE TRIGGER inventory_reservation_preserve_seller
BEFORE UPDATE OF seller_id ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('seller_id');

-- Event holds are seller-private. The event directory is the owner oracle, so
-- a reservation can only name an event owned by the same seller as its variant.
CREATE OR REPLACE FUNCTION sidestage_validate_inventory_source_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_kind = 'event' AND NOT EXISTS (
    SELECT 1 FROM event
    WHERE event_id = NEW.source_id AND seller_id = NEW.seller_id
  ) THEN
    RAISE EXCEPTION 'event inventory source was not found for variant owner'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_reservation_validate_source_owner ON inventory_reservation;
CREATE TRIGGER inventory_reservation_validate_source_owner
BEFORE INSERT OR UPDATE OF source_kind, source_id, seller_id ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION sidestage_validate_inventory_source_owner();

DROP TRIGGER IF EXISTS auction_state_preserve_seller ON auction_state;
CREATE TRIGGER auction_state_preserve_seller
BEFORE UPDATE OF seller_id ON auction_state
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('seller_id');

-- P-005 has made every inventory writer explicit. Removing the compatibility
-- defaults makes any future unowned writer fail loudly instead of silently
-- assigning another seller's stock to the legacy demo owner.
ALTER TABLE storefront_product ALTER COLUMN seller_id DROP DEFAULT;
ALTER TABLE inventory_reservation ALTER COLUMN seller_id DROP DEFAULT;

DROP TRIGGER IF EXISTS scout_session_preserve_buyer ON scout_session;
CREATE TRIGGER scout_session_preserve_buyer
BEFORE UPDATE OF buyer_id ON scout_session
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('buyer_id');

-- ── Durable real-system test runs (Tests-tab acceptance P-003 / D-007) ──────
--
-- This is the single run ledger for the Tests tab, API, and acceptance worker.
-- Suite/case/environment/evidence data is snapshotted per launch so history
-- remains interpretable after a manifest changes. Transitions are append-only;
-- the current state on system_test_run is only the indexed projection.
CREATE TABLE IF NOT EXISTS system_test_run (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  contract_version integer NOT NULL,
  suite_id text NOT NULL,
  suite_version integer NOT NULL,
  profile text NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  requested_sha text NOT NULL,
  event_id text,
  deployed_sha text,
  state text NOT NULL DEFAULT 'queued',
  blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT system_test_run_contract_version_positive CHECK (contract_version > 0),
  CONSTRAINT system_test_run_suite_version_positive CHECK (suite_version > 0),
  CONSTRAINT system_test_run_suite_known
    CHECK (suite_id IN ('actions', 'auction', 'checkout', 'injection', 'load', 'judge')),
  CONSTRAINT system_test_run_profile_known
    CHECK (profile IN ('smoke', 'full', 'sandbox', 'load')),
  CONSTRAINT system_test_run_actor_role_known CHECK (actor_role IN ('operator', 'release')),
  CONSTRAINT system_test_run_requested_sha_format CHECK (requested_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT system_test_run_event_id_format
    CHECK (event_id IS NULL OR event_id ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'),
  CONSTRAINT system_test_run_deployed_sha_format
    CHECK (deployed_sha IS NULL OR deployed_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT system_test_run_state_known CHECK (state IN (
    'queued', 'provisioning', 'running', 'collecting', 'cleaning',
    'passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'
  )),
  CONSTRAINT system_test_run_blocked_reasons_array
    CHECK (jsonb_typeof(blocked_reasons) = 'array')
);

CREATE INDEX IF NOT EXISTS system_test_run_state_heartbeat_idx
  ON system_test_run (state, heartbeat_at);
CREATE INDEX IF NOT EXISTS system_test_run_created_at_idx
  ON system_test_run (created_at DESC);

-- Existing SideStage volumes predate retry support; CREATE TABLE IF NOT EXISTS
-- does not add new columns, so keep this lift repeatable for both fresh and
-- already-initialized databases.
ALTER TABLE system_test_run ADD COLUMN IF NOT EXISTS event_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_test_run_event_id_format') THEN
    ALTER TABLE system_test_run ADD CONSTRAINT system_test_run_event_id_format
      CHECK (event_id IS NULL OR event_id ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS system_test_suite (
  run_id text PRIMARY KEY REFERENCES system_test_run (id) ON DELETE CASCADE,
  suite_id text NOT NULL,
  suite_version integer NOT NULL,
  profile text NOT NULL,
  title text NOT NULL,
  manifest_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_test_suite_manifest_object
    CHECK (jsonb_typeof(manifest_snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS system_test_case (
  run_id text NOT NULL REFERENCES system_test_run (id) ON DELETE CASCADE,
  case_id text NOT NULL,
  ordinal integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'not-run',
  summary text NOT NULL DEFAULT '',
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, case_id),
  UNIQUE (run_id, ordinal),
  CONSTRAINT system_test_case_status_known
    CHECK (status IN ('passed', 'failed', 'blocked', 'not-run'))
);

CREATE TABLE IF NOT EXISTS system_test_artifact (
  run_id text NOT NULL REFERENCES system_test_run (id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  case_id text,
  kind text NOT NULL,
  ref text NOT NULL,
  summary text NOT NULL,
  captured_at timestamptz NOT NULL,
  deployed_sha text NOT NULL,
  byte_size bigint,
  redacted boolean NOT NULL DEFAULT true,
  PRIMARY KEY (run_id, artifact_id),
  CONSTRAINT system_test_artifact_case_fk
    FOREIGN KEY (run_id, case_id) REFERENCES system_test_case (run_id, case_id) ON DELETE CASCADE,
  CONSTRAINT system_test_artifact_byte_size_nonnegative
    CHECK (byte_size IS NULL OR byte_size >= 0),
  CONSTRAINT system_test_artifact_deployed_sha_format
    CHECK (deployed_sha ~ '^[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS system_test_artifact_case_idx
  ON system_test_artifact (run_id, case_id, captured_at);

CREATE TABLE IF NOT EXISTS system_test_environment (
  run_id text NOT NULL REFERENCES system_test_run (id) ON DELETE CASCADE,
  environment_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  image_digest text,
  endpoint_fingerprint text,
  configuration_fingerprint text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, environment_id),
  CONSTRAINT system_test_environment_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE TABLE IF NOT EXISTS system_test_transition (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES system_test_run (id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence),
  CONSTRAINT system_test_transition_from_state_known CHECK (from_state IS NULL OR from_state IN (
    'queued', 'provisioning', 'running', 'collecting', 'cleaning',
    'passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'
  )),
  CONSTRAINT system_test_transition_to_state_known CHECK (to_state IN (
    'queued', 'provisioning', 'running', 'collecting', 'cleaning',
    'passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'
  ))
);

CREATE INDEX IF NOT EXISTS system_test_transition_run_time_idx
  ON system_test_transition (run_id, occurred_at);

CREATE TABLE IF NOT EXISTS system_test_cancellation (
  run_id text PRIMARY KEY REFERENCES system_test_run (id) ON DELETE CASCADE,
  requested_by_id text NOT NULL,
  requested_by_role text NOT NULL,
  reason text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  CONSTRAINT system_test_cancellation_role_known
    CHECK (requested_by_role IN ('operator', 'release'))
);

CREATE TABLE IF NOT EXISTS system_test_retention (
  run_id text PRIMARY KEY REFERENCES system_test_run (id) ON DELETE CASCADE,
  results_expires_at timestamptz NOT NULL,
  artifacts_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_test_retention_results_idx
  ON system_test_retention (results_expires_at);
CREATE INDEX IF NOT EXISTS system_test_retention_artifacts_idx
  ON system_test_retention (artifacts_expires_at);

CREATE TABLE IF NOT EXISTS system_test_cleanup (
  run_id text PRIMARY KEY REFERENCES system_test_run (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not-started',
  summary text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_test_cleanup_status_known
    CHECK (status IN ('not-started', 'pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT system_test_cleanup_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE TABLE IF NOT EXISTS system_test_fixture_lease (
  run_id text PRIMARY KEY REFERENCES system_test_run (id) ON DELETE CASCADE,
  namespace text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT system_test_fixture_lease_namespace_format
    CHECK (namespace ~ '^sst_[a-z0-9_]{1,58}$'),
  CONSTRAINT system_test_fixture_lease_status_known
    CHECK (status IN ('active', 'cleaning', 'leaked', 'released')),
  CONSTRAINT system_test_fixture_lease_expiry_order
    CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS system_test_fixture_lease_reaper_idx
  ON system_test_fixture_lease (status, expires_at);

CREATE TABLE IF NOT EXISTS system_test_fixture_resource (
  run_id text NOT NULL REFERENCES system_test_fixture_lease (run_id) ON DELETE CASCADE,
  kind text NOT NULL,
  identifier text NOT NULL,
  cleanup_order integer NOT NULL,
  status text NOT NULL DEFAULT 'leased',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (run_id, kind),
  UNIQUE (kind, identifier),
  UNIQUE (run_id, cleanup_order),
  CONSTRAINT system_test_fixture_resource_kind_known CHECK (kind IN (
    'postgres-database', 'postgres-schema', 'typesense-collection-prefix',
    'redis-key-prefix', 'mediamtx-path-prefix', 'user-id', 'event-id',
    'order-id', 'idempotency-key', 'external-sandbox'
  )),
  CONSTRAINT system_test_fixture_resource_status_known
    CHECK (status IN ('leased', 'active', 'leaked', 'released')),
  CONSTRAINT system_test_fixture_resource_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT system_test_fixture_resource_cleanup_order_nonnegative
    CHECK (cleanup_order >= 0),
  CONSTRAINT system_test_fixture_resource_attempts_nonnegative
    CHECK (cleanup_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS system_test_fixture_resource_cleanup_idx
  ON system_test_fixture_resource (run_id, status, cleanup_order DESC);

-- ── Canonical payable orders (P-001, Stripe/order recovery plan) ────────────
-- SideStage owns the complete purchase record. Payment processors contribute
-- only an external reference and webhook evidence; cart, auction, and offer
-- purchases all resolve through one source-unique application row.
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS buyer_id text;
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS payment_state text;
ALTER TABLE checkout_order ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE checkout_order ALTER COLUMN cart_id DROP NOT NULL;

-- Existing checkout rows predate lifted identity/payment columns. Their JSON
-- document remains the lossless source for this deterministic, repeatable lift.
UPDATE checkout_order
   SET buyer_id = COALESCE(NULLIF(btrim(buyer_id), ''), NULLIF(btrim(payload->>'buyerId'), ''), 'buyer-demo'),
       source_kind = COALESCE(NULLIF(btrim(source_kind), ''), NULLIF(btrim(payload->>'sourceKind'), ''), 'cart'),
       source_id = COALESCE(NULLIF(btrim(source_id), ''), NULLIF(btrim(payload->>'sourceId'), ''), cart_id, id),
       payment_state = CASE COALESCE(NULLIF(btrim(payment_state), ''), NULLIF(btrim(payload->>'paymentState'), ''), status)
         WHEN 'pending' THEN 'payment_required'
         WHEN 'failed' THEN 'payment_failed'
         WHEN 'payment_required' THEN 'payment_required'
         WHEN 'payment_processing' THEN 'payment_processing'
         WHEN 'paid' THEN 'paid'
         WHEN 'payment_failed' THEN 'payment_failed'
         WHEN 'cancelled' THEN 'cancelled'
         WHEN 'expired' THEN 'expired'
         ELSE 'payment_required'
       END,
       stripe_payment_intent_id = COALESCE(
         NULLIF(btrim(stripe_payment_intent_id), ''),
         NULLIF(btrim(payload->>'stripePaymentIntentId'), '')
       );

UPDATE checkout_order
   SET payload = payload || jsonb_build_object(
         'buyerId', buyer_id,
         'sourceKind', source_kind,
         'sourceId', source_id,
         'paymentState', payment_state
       ) || CASE
         WHEN stripe_payment_intent_id IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('stripePaymentIntentId', stripe_payment_intent_id)
       END;

-- Auction winner orders used to exist only inside auction_state.payload. Copy
-- them into the canonical order table without changing their order IDs, winning
-- prices, quantities, buyer, event, or source snapshot. The legacy aggregate is
-- retained for auction history; the source/id uniqueness below prevents forks.
INSERT INTO checkout_order
  (id, cart_id, buyer_id, source_kind, source_id, status, payment_state,
   stripe_payment_intent_id, payload, updated_at)
SELECT winner->>'id',
       NULL,
       winner->>'bidderId',
       'auction',
       COALESCE(NULLIF(winner->>'auctionId', ''), auction.id),
       'pending',
       'payment_required',
       NULL,
       jsonb_build_object(
         'id', winner->>'id',
         'buyerId', winner->>'bidderId',
         'sourceKind', 'auction',
         'sourceId', COALESCE(NULLIF(winner->>'auctionId', ''), auction.id),
         'eventId', COALESCE(NULLIF(winner->>'eventId', ''), auction.event_id),
         'subtotalCents', (winner->>'totalCents')::integer,
         'shippingCents', 0,
         'totalCents', (winner->>'totalCents')::integer,
         'currency', 'USD',
         'status', 'pending',
         'paymentState', 'payment_required',
         'createdAt', COALESCE(NULLIF(winner->>'createdAt', ''), auction.closed_at::text, auction.updated_at::text),
         'items', jsonb_build_array(jsonb_build_object(
           'productId', winner->>'productId',
           'title', winner->>'productId',
           'priceCents', (winner->>'unitPriceCents')::integer,
           'quantity', (winner->>'quantity')::integer
         )),
         'sourceSnapshot', winner
       ),
       COALESCE(auction.closed_at, auction.updated_at)
  FROM auction_state AS auction
 CROSS JOIN LATERAL (SELECT auction.payload->'winnerOrder' AS winner) AS source
 WHERE jsonb_typeof(winner) = 'object'
   AND NULLIF(winner->>'id', '') IS NOT NULL
   AND NULLIF(winner->>'bidderId', '') IS NOT NULL
   AND NULLIF(winner->>'productId', '') IS NOT NULL
   AND NULLIF(winner->>'totalCents', '') IS NOT NULL
   AND NULLIF(winner->>'unitPriceCents', '') IS NOT NULL
   AND NULLIF(winner->>'quantity', '') IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE checkout_order ALTER COLUMN buyer_id SET NOT NULL;
ALTER TABLE checkout_order ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE checkout_order ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE checkout_order ALTER COLUMN payment_state SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_buyer_nonempty') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_buyer_nonempty CHECK (btrim(buyer_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_source_kind_check') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_source_kind_check
      CHECK (source_kind IN ('cart', 'auction', 'offer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_source_id_nonempty') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_source_id_nonempty CHECK (btrim(source_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_payment_state_check') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_payment_state_check
      CHECK (payment_state IN (
        'payment_required', 'payment_processing', 'paid',
        'payment_failed', 'cancelled', 'expired'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_stripe_intent_nonempty') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_stripe_intent_nonempty
      CHECK (stripe_payment_intent_id IS NULL OR btrim(stripe_payment_intent_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_order_payload_identity') THEN
    ALTER TABLE checkout_order ADD CONSTRAINT checkout_order_payload_identity CHECK (
      payload->>'buyerId' = buyer_id
      AND payload->>'sourceKind' = source_kind
      AND payload->>'sourceId' = source_id
      AND payload->>'paymentState' = payment_state
      AND NULLIF(payload->>'stripePaymentIntentId', '') IS NOT DISTINCT FROM stripe_payment_intent_id
    );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS checkout_order_source_unique
  ON checkout_order (source_kind, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_order_stripe_payment_intent_unique
  ON checkout_order (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS checkout_order_buyer_payment_state_idx
  ON checkout_order (buyer_id, payment_state, updated_at DESC);

DROP TRIGGER IF EXISTS checkout_order_preserve_buyer ON checkout_order;
CREATE TRIGGER checkout_order_preserve_buyer
BEFORE UPDATE OF buyer_id ON checkout_order
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('buyer_id');

DROP TRIGGER IF EXISTS checkout_order_preserve_source_kind ON checkout_order;
CREATE TRIGGER checkout_order_preserve_source_kind
BEFORE UPDATE OF source_kind ON checkout_order
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('source_kind');

DROP TRIGGER IF EXISTS checkout_order_preserve_source_id ON checkout_order;
CREATE TRIGGER checkout_order_preserve_source_id
BEFORE UPDATE OF source_id ON checkout_order
FOR EACH ROW EXECUTE FUNCTION sidestage_preserve_owner('source_id');

-- ── Durable public chat, transcript, and presence authority (P-003) ────────
-- SSE remains the transient invalidation transport. These rows are the
-- restart-safe read authority used by ChatService and its Zero query surfaces.
CREATE TABLE IF NOT EXISTS chat_message (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  user_id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  text text NOT NULL,
  grounding jsonb,
  client_request_id text,
  created_at timestamptz NOT NULL,
  moderated_at timestamptz,
  moderated_by text,
  moderation_reason text,
  CONSTRAINT chat_message_event_fk
    FOREIGN KEY (event_id) REFERENCES event (event_id) ON DELETE CASCADE,
  CONSTRAINT chat_message_role_known CHECK (role IN ('buyer', 'seller')),
  CONSTRAINT chat_message_identity_nonempty
    CHECK (btrim(user_id) <> '' AND btrim(display_name) <> ''),
  CONSTRAINT chat_message_text_nonempty CHECK (btrim(text) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_message_idempotency_unique
  ON chat_message (event_id, user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_message_visible_page_idx
  ON chat_message (event_id, created_at DESC, id DESC)
  WHERE moderated_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_message_copilot_queue_idx
  ON chat_message (event_id, created_at ASC, id ASC)
  WHERE moderated_at IS NULL AND role = 'buyer' AND grounding->>'status' = 'seller-queue';

CREATE TABLE IF NOT EXISTS chat_transcript_moment (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  text text NOT NULL,
  start_ms bigint,
  end_ms bigint,
  product_id text,
  product_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_transcript_moment_event_fk
    FOREIGN KEY (event_id) REFERENCES event (event_id) ON DELETE CASCADE,
  CONSTRAINT chat_transcript_moment_text_nonempty CHECK (btrim(text) <> ''),
  CONSTRAINT chat_transcript_moment_timing_nonnegative CHECK (
    (start_ms IS NULL OR start_ms >= 0) AND (end_ms IS NULL OR end_ms >= 0)
  )
);

CREATE INDEX IF NOT EXISTS chat_transcript_event_timeline_idx
  ON chat_transcript_moment (event_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS chat_presence (
  event_id text NOT NULL,
  user_id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT chat_presence_event_fk
    FOREIGN KEY (event_id) REFERENCES event (event_id) ON DELETE CASCADE,
  CONSTRAINT chat_presence_role_known CHECK (role IN ('buyer', 'seller')),
  CONSTRAINT chat_presence_identity_nonempty
    CHECK (btrim(user_id) <> '' AND btrim(display_name) <> '')
);

CREATE INDEX IF NOT EXISTS chat_presence_freshness_idx
  ON chat_presence (event_id, last_seen_at);

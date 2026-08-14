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
  v_reservation_id bigint;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'reservation quantity must be positive';
  END IF;
  IF nullif(trim(p_source_kind), '') IS NULL OR nullif(trim(p_source_id), '') IS NULL THEN
    RAISE EXCEPTION 'reservation source kind and id are required';
  END IF;

  PERFORM 1
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

  INSERT INTO inventory_reservation (variant_id, source_kind, source_id, quantity, state, expires_at)
  VALUES (p_variant_id, p_source_kind, p_source_id, p_quantity, 'held', p_expires_at)
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
    AND state IN ('held', 'committed');
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
    AND state = 'held';
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

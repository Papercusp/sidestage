-- ─────────────────────────────────────────────────────────────────────────────
-- zero_publication — the logical-replication publication zero-cache subscribes to
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS IS
--   zero-cache does not read Postgres directly. It subscribes to a logical
--   replication publication and maintains its own SQLite replica from the change
--   stream. This file defines that publication for SideStage.
--
-- WHO OWNS THE TABLE LIST
--   The list below MUST equal the set of tables declared in the Zero contract
--   package (libs/zero/src/schema.ts — each table's `.from('<pg_name>')`).
--   That equality is enforced by a test that runs in the release gate:
--     apps/api/src/sync/zero-publication.parity.test.ts
--   If you add a table to the Zero schema, that test fails until you add it here.
--   Do not "fix" the test by loosening it — add the table.
--
-- IDEMPOTENT + RE-RUNNABLE
--   Safe to run repeatedly against an existing database. This matters: the prod
--   compose mounts db/*.sql into docker-entrypoint-initdb.d, which runs ONLY on
--   first init of an empty data directory. An existing deployment will therefore
--   NEVER see this file via the mount, and must have it applied explicitly:
--     docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--       < db/zero-publication.sql
--
-- PREREQUISITE
--   wal_level must be `logical` (set via the postgres `command:` flags in both
--   compose files). Verify with `SHOW wal_level;` — a publication can be created
--   under wal_level=replica but nothing will ever replicate from it.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Replica identity for storefront_product_option
-- ─────────────────────────────────────────────────────────────────────────────
--
-- storefront_product_option shipped WITHOUT a primary key. That is fine for an
-- unpublished table, but the moment it joins a publication Postgres requires a
-- replica identity to describe UPDATEs and DELETEs — and without one, those
-- statements do not merely fail to replicate, they ERROR OUT at the application:
--
--   ERROR: cannot update table "storefront_product_option" because it does not
--          have a replica identity and publishes updates
--
-- So adding this table to the publication without this fix would break writes to
-- it. The key below is (variant_id, axis_id, value_id): all three columns are
-- already NOT NULL, and it matches the Zero contract's declared primaryKey
-- ["variantId","axisId","valueId"] exactly.
--
-- Why not `REPLICA IDENTITY USING INDEX storefront_product_option_variant_axis_unique`?
-- That index is only (variant_id, axis_id). It would work as an identity, but it
-- would hand Postgres a 2-column identity while the Zero client believes the key
-- is 3 columns — a disagreement about row identity between the replica and the
-- client is exactly the kind of drift that produces silent, hard-to-trace sync
-- bugs. A real primary key keeps both sides on the same definition. The stricter
-- 2-column UNIQUE constraint remains in place alongside it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'storefront_product_option'
      AND c.contype = 'p'
  ) THEN
    ALTER TABLE public.storefront_product_option
      ADD CONSTRAINT storefront_product_option_pkey
      PRIMARY KEY (variant_id, axis_id, value_id);
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The publication
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠ NEVER make this `FOR ALL TABLES`.
--   Every write to every published table is buffered through zero-cache's
--   change-streamer. SideStage has high-volume tables that are NOT part of the
--   client data surface (system_test_* run/case/artifact tables, audit trails,
--   idempotency ledgers). Publishing them forces their churn through the
--   streamer for no client benefit and OOMs it. This is not hypothetical: it is
--   the documented root cause of the chronic zero-cache crashloop on the Restart
--   deployment (see Restart deploy/postgres-init.sql).
--
-- TWO COLUMNS CANNOT BE REPLICATED, for different reasons:
--
--   product_catalog.search_tsv  (tsvector)
--     Excluded by the explicit column list below. tsvector is replicable in
--     principle, but it is a server-side search artifact with no client
--     representation in the Zero schema. Listing columns explicitly is a PG15+
--     feature; we are on PG16, so this is available.
--
--   storefront_product."availableQty"  (GENERATED ALWAYS AS ... STORED)
--     Postgres does not replicate stored generated columns before PG17
--     (`publish_generated_columns`). A client waiting on this value would wait
--     forever for something replication never sends. It is therefore ABSENT from
--     the Zero schema and derived client-side as
--     `Math.max(0, qty - reservedQty)` — both operands DO replicate.
--
--     Note that storefront_product deliberately has NO column list here.
--     Postgres auto-excludes generated columns when no list is given, and naming
--     a generated column IN a column list is an ERROR before PG17. Adding a list
--     to this table is therefore both unnecessary and a trap.
--
--     (Restart solved the same problem differently — it converted availableQty
--     from GENERATED to a trigger-maintained regular column so it could
--     replicate. SideStage deliberately diverges: deriving on the client needs no
--     migration and no trigger. Do not "align" this back to Restart.)
--
-- A column list must include the table's replica identity columns.
-- product_catalog's primary key is (group_id, region) — both are in the list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'zero_publication'
  ) THEN
    CREATE PUBLICATION zero_publication FOR TABLE
      public.event,
      public.event_lineup_item,
      public.event_config,
      public.event_run_of_show,
      public.auction_state,
      public.chat_message,
      public.chat_presence,
      public.chat_transcript_moment,
      public.copilot_proposal,
      public.seller_policy_revision,
      public.action_audit_entry,
      public.targeted_offer,
      public.cart,
      public.checkout_order,
      public.inventory_reservation,
      public.storefront_product,
      public.product_option_axes,
      public.product_option_values,
      public.storefront_product_option,
      public.product_catalog (
        group_id,
        region,
        product_type,
        title,
        description,
        brand,
        manufacturer,
        country_of_origin,
        variant_slug,
        identifiers,
        properties,
        images,
        bullets,
        weight,
        dimensions,
        tier_1,
        tier_1_discount,
        tier_2,
        tier_2_discount,
        tier_3,
        tier_3_discount,
        tier_4,
        tier_4_discount,
        tier_5,
        tier_5_discount,
        created_at,
        updated_at
      );
  END IF;
END;
$$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (run by hand after applying)
-- ─────────────────────────────────────────────────────────────────────────────
--   SHOW wal_level;                       -- must be 'logical'
--   SELECT * FROM pg_publication_tables WHERE pubname = 'zero_publication';
--   SELECT slot_name, active, replay_lsn FROM pg_replication_slots;
--
-- The first query should list every table above. Confirm that search_tsv and
-- availableQty do NOT appear in its attnames column.

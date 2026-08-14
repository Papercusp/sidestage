# SideStage product data

SideStage keeps the two product surfaces that power the Restart storefront:

| Table | Grain | Purpose |
| --- | --- | --- |
| `product_catalog` | `(group_id, region)` | Canonical product description, structured attributes, bullets, and image metadata. |
| `storefront_product` | `(product variant, region)` | Sellable condition/handling variant with price and inventory. |

The split is intentional. A product can have many sellable variants, while its
title, description, brand, and image list are shared. `storefront_product.group_id`
and `region` reference the catalog row. `available_qty` is generated as
`greatest(0, qty - reserved_qty)` so reads cannot observe an independently edited
availability value.

`product_catalog.images` is a JSONB array of `{url, alt, isPrimary}` objects,
matching Restart's current schema. This preserves image ordering and primary-image
metadata without introducing a second image table during the initial port.

## Local data stack

The isolated data compose file is useful before the full app compose exists:

```sh
docker compose -f infra/docker-compose.data.yml up -d postgres
./scripts/seed-catalog.sh
docker compose -f infra/docker-compose.data.yml --profile search up -d typesense
```

The Postgres port is `55434` by default, so it does not collide with a local
Restart database. The Typesense profile is opt-in and uses port `8109`.

For an authorized local Restart database, export only the two catalog tables:

```sh
RESTART_DATABASE_URL='postgresql://…' ./scripts/export-restart-catalog.sh
```

Do not commit the resulting production-sized dump or credentials. The checked-in
`db/seed/demo.sql` is the small deterministic fixture used by clean-clone runs.

## Demo-principal ownership migration

`event.seller_id` is the ownership oracle for event-anchored state. Event
configuration, run-of-show, Copilot proposals, and auctions keep their existing
`event_id` grain and reference `event`; they do not grow parallel seller columns
unless a database constraint needs one. Auctions carry `seller_id` only so the
database can enforce the `(event_id, seller_id)` owner pair.

Inventory and Scout sessions have no event anchor. `storefront_product` and
`inventory_reservation` therefore carry `seller_id`, with a composite foreign
key preventing a reservation from naming a different owner than its variant.
`scout_session.buyer_id` binds each transcript to one selected demo buyer.
Owner columns are immutable after insert, including through `ON CONFLICT DO
UPDATE`; changing ownership means creating a new resource, never repointing an
existing one.

Applying `db/schema.sql` to an existing snapshot is repeatable. Legacy event
dependents get deterministic draft event rows owned by `demo-seller`, legacy
inventory is assigned to `demo-seller`, and legacy Scout transcripts are
assigned to `buyer-demo` before constraints become active. Those values are
temporary rolling-deploy defaults so the previous API can remain live while a
schema-first deploy completes. P-005 and P-006 make every writer explicit and
remove the defaults. Rollback is code-compatible while the additive columns and
constraints remain; dropping ownership data is intentionally not part of the
rollback because it would erase the isolation boundary.

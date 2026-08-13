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

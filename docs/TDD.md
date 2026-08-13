# SideStage — Technical Design Document

One npm-workspaces monorepo, clean-clone runnable: a NestJS API, a Vite/React
SPA, pinned shared Papercusp libraries, and a Docker Compose data plane.

## Topology

```
apps/api    NestJS (:3100)  — domain modules, one per commerce concern
apps/web    Vite/React SPA (:5173 dev; nginx static in prod)
libs/*      pinned shared libraries (grid-core/papergrid, sync, sse,
            ui-primitives, token-kit, typesense, …)
db/         schema.sql (Restart-compatible port) + demo seed
docker-compose.yml        dev data plane: Postgres, Typesense, Redis, MediaMTX
docker-compose.prod.yml   production stack + Traefik routing labels
deploy/deploy.sh          rsync-the-git-tracked-set production deploy
```

## API architecture

Domain modules, each `controller / service / types / tests`: catalog, cart,
checkout, auction, inventory, chat, scout, judge, shipping, actions, copilot
(pipeline libs), config, health. Cross-cutting seams are injection tokens with
two implementations each — a Postgres store and an in-memory fake:

| Seam | Durable impl | Purpose |
| --- | --- | --- |
| `CATALOG_SOURCE` | `PgCatalogSource` | The ONE product source (also adapted into scout's `SCOUT_CATALOG`). |
| `AUCTION_INVENTORY` | `PgAuctionInventory` | Source-tracked holds via `reserve_inventory()` / `release_inventory()`. |
| `CART_STORE` / `ORDER_STORE` | `PgCartStore` / `PgOrderStore` | Session documents as jsonb rows. |
| `EVENT_CONFIG_STORE` | `PgEventConfigStore` | Event settings + guardrail toggles. |

`DATA_BACKEND=auto|pg|memory`: the boot probe selects Postgres when reachable
and falls back to the in-memory fakes so a clean clone runs with no Docker.
The in-memory implementations double as the unit-test fakes.

**DI note:** the dev runtime (tsx/esbuild) emits no decorator metadata, so all
constructor injection uses explicit `@Inject(...)` tokens — by-type injection
is silently `undefined` under tsx and is banned in this codebase.

## Data model

`db/schema.sql` ports the Restart catalog verbatim (names preserved, including
the quoted `"availableQty"` generated column): `product_catalog` (groups) ×
`storefront_product` (variants) with option axes, plus `inventory_reservation`
— reservations are the ONLY way stock is held; `reserved_qty` is recomputed by
trigger from reservation rows, and `reserve_inventory()` is idempotent per
`(source_kind, source_id, variant)`. Service state (`cart`, `checkout_order`,
`event_config`) is one jsonb document per row with hot columns lifted out.
The full Restart catalog (1.1M products / 1.1M variants) loads via
`scripts/load-restart-catalog.sh`, which normalizes real-catalog shapes
(camelCase storefront columns, NULL-able fields) into the port.

## Search

The same search the Restart wholesale grid uses: `@papercusp/typesense`
(typo tolerance via `buildNumTypos`, one document per product group, conditions
facet, volume tiers). `scripts/typesense-sync.ts` builds the index from
Postgres in keyset-paginated batches with transient-error retry. The catalog
API queries Typesense first and falls back to Postgres full-text (tsvector GIN
+ trigram slug match) when Typesense is unavailable — the same
degrade-gracefully shape as the wholesale grid.

## Realtime

- **Chat** — API-backed room chat over the shared `@papercusp/sync` layer
  (SSE), with presence and message triage; buyer and seller render the same
  `EventChat` component.
- **Auctions** — server-ordered bids; SSE stream per event with heartbeats.
- **Streaming** — MediaMTX WHIP/WHEP WebRTC: seller publishes, buyers view;
  live transcript via Deepgram with product-alias mention detection driving
  the seller's on-deck slot.

## Guardrails and the depth area (agentic-write safety)

Every copilot reply and action passes a deterministic server-side gate before
send: grounding present, price within policy (markdown cap, per-product price
floors), availability claims backed by live inventory, tone constraints. The
Config tab's saved guardrails DERIVE the enforced `CopilotPolicy` — the toggle
is the policy. Guarded actions (markdown, price-adjust, targeted-offer, …) are
auditable and reversible. Two rehearsal instruments prove the property:

- **Reply judge** — deterministic four-dimension grading (grounding, policy,
  price correctness, tone) with per-case rationales and a pass threshold.
- **Load simulator** — deterministic N-user × M-msg/s scripted traffic across
  seven scenario kinds (price, shipping, policy, variant, stock, offer, bid),
  with coverage accounting.

## Web architecture

Small files by design: the app shell (`App.tsx`, ~80 lines) routes four tabs
held in the URL; each tab is its own component; shared behavior lives in hooks
(`useStreamSession`, `useCopyState`, `useCatalog`). Product surfaces render
from the one catalog source; grids use the shared `RichGrid`
(`@papercusp/grid-core`). A density token system (compact / console / roomy)
implements the approved design mockups per tab.

## Testing

Vitest across both workspaces (`npm test`; `npm run check` adds typechecks and
builds). Unit tests use the in-memory store fakes; integration-grade coverage
comes from the judge + load-simulator rehearsals and live smokes against the
running stack. CI runs the exact reviewer commands from a clean clone.

## Deployment

Production mirrors the shop.buyrestart.com pattern, as an independent stack:
`deploy/deploy.sh` rsyncs the git-tracked file set to `/opt/SideStage` on the
host, builds two images there (API: workspace build → `node dist`; web: Vite
build → nginx static), and `docker compose up`s the stack. Traefik (external,
`coolify` network) terminates TLS and routes `sidestage.buyrestart.com` — web
as catch-all, `/api` + `/healthz` to the API (`API_PREFIX=api`), and
`media.sidestage.buyrestart.com` (DNS-only) to MediaMTX for WebRTC. Secrets
live only in the on-box `.env.production`.

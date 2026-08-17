# SideStage — Technical Design Document

One npm-workspaces monorepo, clean-clone runnable: a NestJS API, a Vite/React
SPA, pinned shared Papercusp libraries, and a Docker Compose data plane.

## Topology

```
apps/api    NestJS (:3100)  — domain modules, one per commerce concern
apps/web    Vite/React SPA (:5173 dev; nginx static in prod)
libs/*      pinned shared libraries (grid-core/papergrid, sync, sse,
            ui-primitives, token-kit, typesense, …)
db/         schema.sql (ported production-grade commerce schema) + demo seed
docker-compose.yml        dev data plane: Postgres, Typesense, Redis, MediaMTX
docker-compose.prod.yml   production stack + Traefik routing labels
deploy/deploy.sh          immutable working-tree snapshot production deploy
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

`db/schema.sql` ports a production wholesale-catalog schema verbatim (names
preserved, including the quoted `"availableQty"` generated column):
`product_catalog` (groups) × `storefront_product` (variants) with option axes,
plus `inventory_reservation` — reservations are the ONLY way stock is held;
`reserved_qty` is recomputed by trigger from reservation rows, and
`reserve_inventory()` is idempotent per `(source_kind, source_id, variant)`.
Service state (`cart`, `checkout_order`, `event_config`) is one jsonb document
per row with hot columns lifted out. The full 1.1M-product real-world import
loads via `scripts/load-wholesale-catalog.sh`, which normalizes real-catalog
shapes (camelCase storefront columns, NULL-able fields) into the port.

## Search

`@papercusp/typesense` (typo tolerance via `buildNumTypos`, one document per
product group, conditions facet, volume tiers). `scripts/typesense-sync.ts`
builds the index from Postgres in keyset-paginated batches with
transient-error retry. The catalog API queries Typesense first and falls back
to Postgres full-text (tsvector GIN + trigram slug match) when Typesense is
unavailable, so search degrades gracefully instead of failing.

## Realtime

- **Chat** — API-backed room chat over the shared `@papercusp/sync` layer
  (SSE), with presence and message triage; buyer and seller render the same
  `EventChat` component.
- **Auctions** — server-ordered bids; SSE stream per event with heartbeats.
- **Streaming** — MediaMTX WHIP/WHEP WebRTC: seller publishes, buyers view;
  the API exchanges its server-only Deepgram project key for a short-lived JWT
  after seller authentication, and the publisher browser uses that JWT for one
  direct live-transcription session. Buyers consume the shared event transcript
  and never create their own transcription sessions.

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

Production is a single-box Docker Compose stack behind Traefik:
`deploy/deploy.sh` uses temporary Git indexes to export one immutable snapshot
of the superproject and initialized submodules. The snapshot includes tracked
edits and non-ignored new files without touching the real indexes; ignored
files and `.git` metadata never ship. The script rsyncs that snapshot to
`/opt/SideStage` while preserving the host-only `.env.production`, builds two
images there (API: workspace build → `node dist`; web: Vite build → nginx
static), and `docker compose up`s the stack. Traefik (external, `coolify`
network) terminates TLS and routes `sidestage.papercusp.com` — web as
catch-all, `/api` + `/healthz` to the API (`API_PREFIX=api`), and
`media.sidestage.papercusp.com` (DNS-only) to MediaMTX for WebRTC. Secrets
live only in the on-box `.env.production`. That file also supplies
`MEDIAMTX_PUBLIC_IP` as a literal IPv4 address: MediaMTX 1.9.3 copies the value
into ICE candidates and does not resolve the public DNS hostname there. Direct
UDP `8189` remains the preferred media path. Networks that block arbitrary UDP
or high ports fall back to authenticated TURN over TLS/TCP on the already-open
`media.sidestage.papercusp.com:443`; Traefik distinguishes TURN from HTTPS by
SNI plus the absence of HTTP ALPN, terminates TLS, and forwards the raw TURN
stream to coturn. `TURN_AUTH_SECRET` is required only in the host-side env and
MediaMTX uses it to mint expiring TURN REST credentials for browsers.

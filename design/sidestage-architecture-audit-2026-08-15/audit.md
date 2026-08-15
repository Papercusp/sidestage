# SideStage Architecture page — source-backed audit

## Executive verdict

The page is directionally strong and most named technologies, domains, data tables, and deployment mechanisms are real. It is not yet a faithful current-runtime map. Seven claims should be corrected before the page calls itself “source-backed”:

1. **Native mobile clients do not ship.** The repository contains one responsive React web app and placeholder `.ipa` / `.apk` download links; the PRD explicitly lists mobile-native clients as a non-goal.
2. **Redis is configured but unused by the application.** Production Compose starts Redis, yet the API has no Redis dependency, client, `REDIS_URL`, or runtime call. Calling it cache infrastructure and a production data service implies an active path that does not exist.
3. **Room history and explicit product-focus state do not ground Copilot turns.** A queued chat message is the question. The retriever grounds against event items, catalog search, relevant transcript moments, and seller policy.
4. **The dedicated auction SSE stream is not the buyer UI's active state path.** The endpoint and ordered event IDs exist, but current web consumers read `event.auction.active` through the shared sync query/invalidation path.
5. **Guarded actions are not universally “recorded and reversible before success.”** The service mutates the action-item store before writing its audit row, and a multi-item swap audit snapshots only the primary item. The normal path is guarded and audited, but the absolute ordering/reversibility claim is stronger than the implementation.
6. **The acceptance worker is not an all-suite runner.** The production worker installs only the Actions executor. Auction, checkout, injection, load, and judge are allow-listed in the contract/UI but block when the worker finds no executor.
7. **“Commerce is always server-authoritative” needs a scope qualifier.** Event-cart, auction, order, policy, and payment transitions have authoritative server paths. The legacy product-only cart endpoint still accepts client-supplied title and price and snapshots them into checkout.

The simplest honest page is therefore an **authority map with explicit status vocabulary**: active runtime, fallback, configured/idle, and planned. That model is mocked in Option 01.

## Verdict key

- **Supported** — the current production code path directly implements the claim.
- **Qualified** — the capability exists, but the wording hides an important limit, fallback, or inactive path.
- **Incorrect** — the repository contradicts the claim or no shipping implementation exists.

## 01 · Hero and system context

| Page claim | Verdict | Source evidence and correction |
|---|---|---|
| React 19 + Vite | Supported | `package.json` pins React 19 through overrides; `apps/web/package.json` uses React 19 and Vite 7. |
| NestJS modular API | Supported | `apps/api/package.json` uses NestJS 11; `apps/api/src/app.module.ts` composes domain modules. |
| PostgreSQL system of record | Supported | `db/schema.sql`, `apps/api/src/db/database.module.ts`, and production `DATABASE_URL` wire durable stores to Postgres. |
| Typesense searchable product index | Supported | `libs/typesense/src/client.ts`, catalog sources, and production Typesense settings implement the search index. |
| SSE application state | Supported | `apps/api/src/sync/sync.controller.ts` exposes the sync stream; `libs/sync/.../SSEAdapter.tsx` reconnects and invalidates named queries. |
| WebRTC media | Supported | Buyer WHEP and seller WHIP clients are present; Compose exposes MediaMTX WebRTC and TURN paths. |
| npm workspace monorepo | Supported | Root `package.json` declares `apps/*`, `libs/*`, and `libs/papergrid/*` workspaces. |
| SPA + modular API | Supported | `apps/web/src/App.tsx` is one URL-routed React SPA; API modules sit behind one Nest application. |
| Server-authoritative trust model | Qualified | Accurate for event inventory, auctions, policies, Stripe settlement, and guarded actions. Qualify it because the legacy generic cart accepts client price/title (`cart.controller.ts`, `cart.service.ts`). |
| Immutable containers | Supported | `deploy/deploy.sh`, both Dockerfiles, and per-SHA image tags implement immutable release artifacts. |
| Buyer uses “Web + native mobile” | **Incorrect** | Only `apps/web` ships. `docs/PRD.md` lists mobile-native clients as a non-goal; `AppDownloadButtons.tsx` labels `.ipa`/`.apk` URLs as stubs before signed artifacts exist. Say **responsive web**. |
| Responsive Studio | Supported | `SellerTab.tsx`, `SellerMobileStudio.tsx`, seller dock layouts, and responsive CSS provide desktop and compact web layouts. |
| Operator Tests + History | Supported | `SystemTestsTab.tsx` and `BuildHistoryTab.tsx` are routed application surfaces. |
| React SPA uses shared Papercusp packages | Supported | Web dependencies and imports use sync, SSE, grid-core, Scout chat, cart/drawer, and UI packages. Git submodule pins identify concrete library revisions. |
| MediaMTX + coturn: WHIP, WHEP, direct ICE + TURN | Supported | `docker-compose.prod.yml` wires MediaMTX, coturn, direct UDP ICE, and authenticated TURNS/TCP fallback. |
| Postgres + Typesense are data authorities | Supported | Postgres owns records; Typesense is a derived discovery index. |
| Stripe + EasyPost integration | Supported | Stripe Payment Element/provider/webhook and EasyPost shipment-rate adapter are production-wired. |
| Deepgram + model provider | Supported | Deepgram grant/token and web transcription paths ship; OpenAI/model configuration is optional with a deterministic fallback. |
| Traefik terminates TLS; only `/api` and `/healthz` reach API | Supported | Production Compose API router matches exactly those paths and does not publish the API port. |
| Media and TURN use dedicated hosts/protocols | Supported | `media.<host>` serves WHIP/WHEP; `turn.<host>` uses SNI-routed TURNS on 443. |

## 02 · Runtime flows

| Page claim | Verdict | Source evidence and correction |
|---|---|---|
| Seller publishes WHIP video; buyers receive WHEP video | Supported | Seller publisher and Buyer streaming client use the MediaMTX base URL and WHIP/WHEP endpoints. |
| Deepgram yields live transcript | Supported | Seller obtains a short-lived grant and opens the Deepgram WebSocket; final moments are written through chat transcript seams. |
| “Product focus + room chat ground a turn” | **Qualified** | `SideStageGroundingRetriever` reads event action items, catalog search, relevant transcript moments, and policy. The current queued chat message supplies the question, but room-message history and a separate focus record are not grounding collections. |
| Copilot proposes reply or action | Supported | `GroundedCopilotPipeline` returns grounded replies and normalized action proposals. |
| Policy guard + seller approval gate delivery | Supported | Reply approval re-fetches context, re-runs the guard/judge, and writes through ChatService; actions use confirm/guarded execution. Auto-action policy can execute without seller review, so keep “when required.” |
| Catalog availability is derived | Supported | `storefront_product."availableQty"` is generated from `qty - reserved_qty`; reservation triggers recompute `reserved_qty`. |
| Holds/auctions create idempotent reservations | Supported | `inventory_reservation` is unique by source+variant; reserve/release/commit functions and auction/cart services make retries source-idempotent. |
| Cart snapshots quantity and price | Supported | cart items and checkout source snapshots persist quantity and price. For legacy generic carts, the source value comes from the client, which is why the global authority claim needs qualification. |
| API creates Stripe PaymentIntent | Supported | `stripe-payment.provider.ts` creates/updates PaymentIntents with idempotency keys and order metadata. |
| Stripe webhook authoritatively settles order | Supported | Signed webhook events map provider state into checkout transitions; success commits the source and records paid state. |
| Inventory commits/releases; EasyPost quotes shipping | Supported | `CheckoutSourceService` commits/releases cart/auction/offer sources; `ShippingService` box-packs then requests/aggregates EasyPost rates. |
| React requests named sync queries | Supported | Production surfaces use `useSyncQuery` / `useSyncMutate`; the current data-surface census lists authority and consumers. |
| API registry maps query names to reads | Supported | `SyncQueryRegistry` modules register named resolvers for event, catalog, cart, orders, chat, auction, actions, config, and operations. |
| REST batch returns initial snapshots | Supported | `POST /sync/rest-query-batch` is index-aligned and the shared fetcher batches queries. |
| Domain writes publish scoped invalidations | Supported | Domain services call `SyncInvalidationService.invalidate(name,args,context)` after authoritative changes. |
| SSE reconnects and refreshes affected queries | Supported | shared SSE transport uses resilient event source plus query invalidation; polling remains its safety floor. |
| Dedicated auction streams preserve server ordering | **Qualified** | `auction.controller.ts` emits a dedicated stream with event IDs and `auction.ts` can parse it, but current Buyer/Auction/Run-of-Show components consume `event.auction.active` through sync. Describe the dedicated stream as an available protocol, not the active UI path. |

## 03 · Application layers

| Page claim | Verdict | Source evidence and correction |
|---|---|---|
| Watch includes video, chat, product rail, holds, auctions, checkout | Supported | `BuyerTab.tsx` composes these surfaces and BuyerCheckoutProvider owns cart/checkout. |
| Orders are buyer-scoped purchases and product moments | Supported | `OrdersTab.tsx` reads `orders.byBuyer`; API joins orders/offers/auctions and video snapshots under buyer identity. |
| Studio owns event, lineup, inventory, transcript, copilot, stage controls | Supported | Seller/Studio modules and dock panel registry implement the listed functions. |
| History shows plans, work items, commits, verification evidence | Supported | `BuildHistoryTab.tsx` renders exactly those snapshot entities. |
| Tests provide rehearsals, load, judge, acceptance | Qualified | Rehearsal/load/judge surfaces exist. Acceptance UI/ledger exists, but the deployed worker executes only Actions today. |
| Shared packages list is real | Supported | All named packages/directories exist; “Drawer packages” accurately groups cart, Scout, and drawer-stack packages. |
| API domain list is real | Supported | Corresponding modules exist under `apps/api/src`; “Operations” spans build history, rehearsals, sync, health, and system tests. |
| Data-store lists are real | Supported | Catalog, event/chat/config, commerce, automation/policy, and system-test tables exist in `db/schema.sql`. |

## 04 · Data and trust

| Page claim | Verdict | Source evidence and correction |
|---|---|---|
| PostgreSQL authoritative; Typesense accelerates discovery | Supported | Catalog reads prefer Typesense and fall back to Postgres; writes and ownership remain in Postgres. |
| “Redis is disposable cache infrastructure” | **Incorrect as runtime description** | Redis services/volumes exist, including an acceptance prerequisite, but production API dependencies/env/source contain no Redis client. Label **configured, currently unused** or remove it from the active map. |
| Event owns lineup/config/run-of-show/auctions/proposals/chat/transcript | Supported | Foreign keys and event-scoped stores anchor these records to `event`. |
| Storefront variant owns price, stock, reservations | Supported | `storefront_product` stores price/qty; reservations reference variant+seller and drive derived availability. |
| Buyer identity scopes carts, orders, Scout transcripts | Supported | cart payload writes are owner-checked; checkout rows have immutable buyer IDs; Scout session queries require buyer ID and DB owner trigger. |
| Reservations carry sources and are idempotent | Supported | source kind/id/variant uniqueness plus reserve/commit/release functions implement the invariant. |
| Ownership is immutable across event/inventory/auction/order/Scout records | Supported | composite FKs, immutable-owner triggers, principal-scoped stores, guards, and checkout immutable-owner/source triggers cover the named records. |
| Typesense degrades to Postgres full-text/trigram | Supported | `pg_trgm`, `search_tsv`, catalog SQL, and Typesense fallback logic implement the path. |
| Provider secrets remain server-side; Deepgram token is short-lived | Supported | production secrets are server env only; grant validation caps Deepgram expiry at one hour. |
| Stripe owns raw payment details | Supported | browser mounts Stripe Payment Element and confirms through Stripe; SideStage persists provider IDs/order state, not card fields. |
| Copilot actions are normalized, authorized, recorded, reversible before success | **Qualified** | Normalization, policy guards, audit rows, and rollback endpoint exist. `GuardedActionService.applyOnce` writes item state before `recordAudit`, and swap rollback does not snapshot the secondary item. Say **guarded, audited, and rollback-capable**; do not promise universal atomic audit-before-success/reversibility. |
| System tests use a trusted isolated worker and fixture leases, never live commerce | **Qualified** | Runner code validates isolated Compose resources and rejects production identifiers. The production worker lacks the provisioner/env and installs only Actions, so unsupported runs block safely rather than exercise isolated environments. |

## 05 · Operations

| Page claim | Verdict | Source evidence and correction |
|---|---|---|
| Source tree is npm workspaces across apps/libs/db/deploy | Supported | Repository layout and root scripts match. |
| Typecheck + Vitest gate | Supported | root `check` runs workspace typecheck and tests; deploy tests cover release scripts. |
| Clean-clone verification | Supported | CI starts from a checkout and runs install/check flows; clean-clone success is a documented acceptance target. Do not imply `deploy.sh` itself clones—it snapshots the working tree. |
| Per-SHA API/web containers | Supported | Compose image tags and deploy build args use `SIDESTAGE_SHA`. |
| Compose rollout, health probes, previous-SHA rollback | Supported | `deploy.sh` probes public/internal health and auto-rolls back; `rollback.sh` verifies the served SHA. |
| db is repeatable schema + deterministic seed | Supported | `db/schema.sql` is convergent and `db/seed/demo.sql` is checked-in deterministic fixture data. |
| Production services include Redis as cache | **Incorrect as active role** | Redis container exists but has no application consumer. Separate **deployed services** from **active application dependencies**. |
| Unit and integration coverage | Supported | Vitest suites cover pure services/UI plus Postgres adapters, sync contracts, provider seams, and deployment scripts. |
| Rehearsal has actions/auction/checkout/injection/load/judge | Supported | rehearsal implementations and manifests cover the six named suite areas. |
| Acceptance ledger has artifacts, retries, cancellation, cleanup | Supported | system-test schema/store defines run/case/artifact/transition/cancellation/retention/cleanup/fixture tables and state transitions. Runtime suite coverage remains qualified as above. |
| Health probes and rollback preserve availability | Supported as mechanism | The scripts fail closed, verify SHA, and roll back to the previous image. “Preserve” is a design objective, not proof of zero downtime. |
| Realtime may be optimistic; commerce/ownership/policy/automation are always authoritative and auditable | **Qualified** | The named authoritative paths are substantial, but “always” is false for legacy client-priced generic cart input and too broad for the action audit ordering. Scope the rule to **event commerce and guarded automation paths**. |

## Recommended replacement copy

Use these short, falsifiable statements on the production page:

- **Clients:** “Responsive web app for buyers, sellers, and operators. Native install links are placeholders until signed apps ship.”
- **Redis:** “Provisioned service; no current application consumer.”
- **Copilot grounding:** “A buyer question is grounded against the event lineup, catalog, relevant transcript moments, and effective seller policy.”
- **Auction state:** “The UI reads the shared `event.auction.active` query; a dedicated ordered SSE endpoint remains available for direct consumers.”
- **Guarded actions:** “Actions are normalized, policy-checked, audited, and rollback-capable. Seller confirmation is required by policy.”
- **Acceptance:** “The durable acceptance ledger and isolated-runner substrate ship; the deployed worker currently executes the Actions suite.”
- **Authority rule:** “Event commerce, ownership, policy, payment settlement, and guarded automation are server-authoritative. Legacy product-only cart inputs remain a compatibility path.”


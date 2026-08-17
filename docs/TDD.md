# SideStage — Technical Design Document

One npm-workspaces monorepo, clean-clone runnable: a NestJS API, a Vite/React
SPA, pinned shared Papercusp libraries, and a Docker Compose data plane.

## Topology

```
apps/api    NestJS (:3100)  — domain modules, one per commerce concern
apps/web    Vite/React SPA (:5173 dev; nginx static in prod)
libs/*      pinned shared libraries (grid-core/papergrid, sync, sse,
            ui-primitives, token-kit, typesense, …)
libs/zero   the Zero contract package — table/column/relationship schema
            shared by the client, zero-cache, and the replication publication
db/         schema.sql (ported production-grade commerce schema) + demo seed,
            zero-publication.sql (the logical-replication publication)
docker-compose.yml        dev data plane: Postgres (logical replication on),
                          Typesense, Redis, MediaMTX, zero-cache
docker-compose.prod.yml   production stack + Traefik routing labels
infra/zero/               zero-cache image + operational notes
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

- **Chat** — room chat over the shared `@papercusp/sync` layer, with presence
  and message triage; buyer and seller render the same `EventChat` component.
  Postgres is the sole authority for chat state: messages, presence, and
  moderation are durable rows, and moderation is a soft delete (`moderated_at`)
  so the audit trail and the idempotency index both survive. Presence expiry is
  a property of the store, swept on a timer — not a side effect of a read —
  because a client reading the replicated table directly never issues that read.
- **Auctions** — server-ordered bids; the server remains the ordering authority
  regardless of which transport carries the fan-out.

### Sync transport ladder

`SyncProvider` mounts one transport and degrades through three, so a blocked
network path costs freshness rather than function. The table below is the
DESIGNED ladder; which rung actually carries traffic is decided at runtime by
the probe described under it.

| Rung | Mechanism | Selected when |
| --- | --- | --- |
| 1. WebSockets | Rocicorp Zero client against zero-cache | the up-front WS handshake probe reaches the zero origin (`wsHealthy === true`) |
| 2. SSE | `@Sse('sse')` invalidation stream, heartbeats, Last-Event-ID-ready | the WS probe fails, or Zero stays down past `fallbackDelayMs` (10s) |
| 3. Polling | batched REST fetch on an interval (10s) | the SSE stream itself errors |

**Today every client runs on rung 2.** Rung 1 is reachable only when a
zero-cache is actually listening at the configured origin — in a deployed build
`${window.location.origin}/zero` (`apps/web/src/catalog.ts:76-81`). Nothing
serves that origin in the current deployment, so the handshake probe fails
within `WS_PROBE_MS` (1.5s) and the provider steps straight to SSE
(`libs/sync/src/SyncProvider.tsx:296-299`). `syncType="WEBSOCKETS"` at
`apps/web/src/main.tsx:41` states the PREFERENCE; it does not assert that the
WebSocket rung carries traffic.

Selection runs in two stages. An up-front WebSocket handshake probe
(`probeWebSocket`, budget `WS_PROBE_MS` = 1500ms, cached once per
browser+server pair for the session) resolves `wsHealthy`: `null` while the
probe is in flight — children render under an empty passthrough rather than
starting REST polls — `true` mounts the Zero client, `false` steps down. A
failed probe is a definitive verdict on rung 1, so it bypasses the debounce and
renders SSE immediately rather than serving ~10s of REST polling first.
Thereafter `useTransportFallback` owns the descent
(`WEBSOCKETS → SSE → POLLING`, debounced by `fallbackDelayMs`) from errors the
adapters report under the rung they are actually rendering. An earlier
mechanism polled `zero.connection.state` every 3s; that property is not a
stable public API and produced false positives, so it was removed
(`libs/sync/src/transports/websocket/WebSocketAdapter.tsx:171-177`) and Zero's
own reconnection handling is trusted instead.

**zero-cache does not read Postgres directly.** It subscribes to the
`zero_publication` logical-replication publication and maintains its own SQLite
replica from the change stream. The publication's table list must equal the set
declared in the Zero contract package (`libs/zero/src/schema.ts`, each table's
`.from('<pg_name>')`); parity tests hold the two in sync, since a table present
in one and absent from the other fails silently — queries simply return nothing.

**Writes do not ride the read path.** The Zero custom-mutator dispatcher is
WebSocket-only; when it is absent every write takes the REST fallback to the
API, so the guardrail gate below stays on the write path at every rung of the
ladder.
- **Streaming** — MediaMTX WHIP/WHEP WebRTC: seller publishes, buyers view;
  the API exchanges its server-only Deepgram project key for a short-lived JWT
  after seller authentication, and the publisher browser uses that JWT for one
  direct live-transcription session. Buyers consume the shared event transcript
  and never create their own transcription sessions.

## Guardrails and the depth area (agentic-write safety)

Every copilot reply and action passes a deterministic server-side gate before
send: grounding present, price within policy (markdown cap, per-product price
floors), availability claims backed by live inventory, tone constraints. The
guardrail settings saved in Studio DERIVE the enforced `CopilotPolicy` — the
toggle is the policy. Guarded actions (markdown, price-adjust, targeted-offer, …) are
auditable and reversible. Two rehearsal instruments prove the property:

- **Reply judge** — deterministic four-dimension grading (grounding, policy,
  price correctness, tone) with per-case rationales and a pass threshold.
- **Load simulator** — deterministic N-user × M-msg/s scripted traffic across
  seven scenario kinds (price, shipping, policy, variant, stock, offer, bid),
  with coverage accounting.

## Latency budgets

- **On-demand product research: < 2s** end to end. The catalog API enforces
  this budget structurally: the Typesense adapter requests ranking keys only
  (`includeFields: ['id', 'groupId']`) because returning full search documents
  blows the 2s research budget before hydration begins; Postgres hydration is
  bounded by the GIN/trigram indexes.
- **Reply suggestion**: chat-message-to-suggested-reply is measured by the
  load rehearsal (N users × M msg/s across seven scenario kinds); the
  deterministic judge grades every reply, so latency is never bought by
  skipping the gate.
- **Guardrail gate**: deterministic, in-process, no provider round-trip —
  policy checks add no meaningful latency to a send.
- **Realtime propagation**: Zero WebSocket sync (chat, auction bids, sync
  queries) against zero-cache's local replica, so a query is answered from
  SQLite rather than a round-trip to Postgres. The budget is set by the
  *slowest rung the client can land on*, not the fastest: a client that has
  fallen back absorbs up to `fallbackDelayMs` (10s) of WS retry before the SSE
  stream takes over, and a further poll interval (10s) if SSE also fails.
  Freshness therefore degrades in bounded steps rather than failing, and
  replication lag from the `zero_publication` change stream is an additional
  term on the WS rung that the SSE rung does not carry. WebRTC media latency
  is unchanged: MediaMTX direct-UDP first, TURN/TLS fallback.

## Marketplace integrations

Integration follows the same seam pattern as storage (injection tokens, two
implementations), so a marketplace is an adapter, not a rewrite:

- **Shipped provider seams**: Stripe (payment intents + webhook settlement),
  EasyPost (rates behind the box-packing estimator), Deepgram (short-lived
  transcription JWTs), Typesense (search), MediaMTX/coturn (media).
- **Chat ingestion is transport-agnostic**: the copilot pipeline consumes a
  message stream + room context; the shipped source is SideStage room chat,
  and an external platform chat (Whatnot, TikTok Shop Live, eBay Live)
  plugs in at the same boundary as a reader adapter.
- **Listing/inventory actions are marketplace-shaped**: guarded actions
  (push, swap, markdown, stock adjust) operate on the catalog seam
  (`CATALOG_SOURCE`), so pointing the executor at a marketplace listings API
  means implementing that seam against their API while keeping the policy
  gate, audit, and rollback unchanged — the safety property travels with the
  executor, not the backend.

## Web architecture

Small files by design: the app shell (`App.tsx`) routes the pages (Watch,
Orders, Studio, History, Tests, Architecture) held in the URL; each page is
its own component; shared behavior lives in hooks
(`useStreamSession`, `useCopyState`, `useCatalog`). Product surfaces render
from the one catalog source; grids use the shared `RichGrid`
(`@papercusp/grid-core`). A density token system (compact / console / roomy)
implements the approved design mockups per tab. The reasoning behind each
surface is recorded in the next section; the primary design evidence lives
in-repo under `design/` (one dated directory per design pass, each with its
mockups, UI-IR specs, and QA records).

## UI design rationale — why the surfaces are shaped the way they are

Every UI direction in this app was chosen through an explicit design pass:
registry search first, standalone preview mockups (never production edits),
validated UI-IR specs, a written comparison, then implementation. The passes
are committed under `design/*` as the audit trail, and the decisions they
produced are cited as `D-NNN` comments at the exact code they govern. The
ones that shaped the product:

**One site, two work groups.** SideStage is one identity with two audiences:
buyer work (Watch, Orders) and operator work (Studio, History, Tests,
Architecture). The 2026-08-14 page-redesign pass set the shared rules every
page follows: one obvious next action per page; status is always text plus
color, never color alone; below 760px, one active work panel at a time
instead of a compressed desktop grid. The shipped palette is the R3 "Ticket"
system (cream canvas, white paper surfaces, ink text, red primary action,
yellow attention, green success) from the red/yellow retheme plan, and
`styles.css` `:root` is the single token authority every surface — including
third-party grid theming — derives from (`grid-theme-bridge.ts` D-002).

**Watch lands you where the sidebar points.** One live directory (the
Channel Guide) powers the site-wide What's-On rail, and the "active" event is
app state, not a hard pin (P-118 / D-019, `App.tsx`). Landing precedence is:
the URL's `?event=`, else the guide's FIRST row, else a pre-directory seed
(D-001, `event-identity.ts`). The middle term is the point: the server
already orders the guide (live by viewers, then soonest-scheduled, then most
recently ended) and the sidebar paints that order, so the room a visitor
lands in is the top row they can see. This replaced a hard-coded default
event that had drifted from the live directory — the app opened a room the
sidebar could not even list.

**One video-owned engagement overlay, not stacked panels.** Captions,
expandable transcript history, product context, and Event Chat compose into
a single overlay owned by the video surface, for buyer and seller alike —
both roles render the same `EventChat` component. Chat stays mounted while
collapsed so its subscription and message state survive view changes.
Captions update through a polite atomic live region; chat and transcript
toggles are wired with `aria-controls`/`aria-expanded`. The earlier
stacked-panel layouts and three seller reply-workflow concepts (Answer
Queue, Conversation + Focus, Live Pulse) are retained in
`design/sidestage-event-chat-mockups-2026-08-14/` as future research.

**Auction: the Panel is product, the Board is presentation.** The landing
pass built a marketing "Board" animation and then compared it side-by-side
against the shipping `AuctionPanel` under one simulation
(`design/sidestage-landing-2026-08-14/`). The verdict: graft the Board's
presentation onto the Panel, never replace it — the server stays the bid
ordering authority, and a scripted animation must not masquerade as bidding.

**Studio navigation names the event lifecycle.** The event-list study
compared three information architectures and chose four peer tabs —
Inventory · Create Event · Events · Active Event — because each lifecycle
job gets a stable, plainly named destination: "what can I sell?", "how do I
start?", "where is the event I own?", "how do I run the room now?". The
extra tab is a visible cost accepted deliberately, rather than hiding
creation inside a generic hub or nesting the event list in an already-dense
manager. ("Active Event" means the event this studio session is operating —
it is being hardened to surface the event's lifecycle status inline so a
draft can never be mistaken for a published listing.)

**Studio panels are a dock workbench with a strict layout/state boundary.**
Seller surfaces mount as Dockview panels over the shared `@papercusp`
workbench store, and the persisted layout carries panel IDs and geometry
ONLY (D-006/D-007, `seller-dock-layout.ts`, `seller-dock-store.ts`); live
props reach panels through React context, never through serialized panel
params (D-009). Rationale: a saved layout must restore *arrangement*,
not resurrect stale application state.

**Run of Show: pacing over alarms, server truth over local guesses.** The
lineup study merged the event Lineup and the run-of-show planner into one
seller workspace (drag-and-drop ordering plus explicit Move up / Move down
for keyboard and touch). The stage clock advances on the event's
server-authoritative STAGED product, not a local timer (D-005), and timing
is presented as pacing guidance rather than alarms (D-001) — a live seller
needs a nudge, not a deadline. In the markdown flow the previewed price IS
the sent price (D-006), because an authoritative-looking wrong number is
worse than none (D-003).

**Copilot: density must not hide why an action is safe.** The compact-layout
study's constraint was that tightening the proposal review pane may not drop
the evidence: buyer identity, the question, cited sources, the guarded
action, and explicit guardrail language survive every density level, and
wide layouts collapse into one readable column instead of clipped
miniatures. This is the UI half of the server-side guardrail gate above —
the seller approves from evidence, so the evidence is non-negotiable chrome.

**Demo identity is a feature, not a gap.** Buyer identity is a deliberately
auth-free, switchable demo seam (D-013, `buyer-identity.ts`,
`BuyerIdentityControl.tsx`): reviewers and pilot sellers can flip between
buyer personas instantly to exercise carts, offers, and chat presence.
Real authentication is an explicit non-goal of this build (PRD).

**The Architecture tab is audited, not aspirational.** Because the app
explains itself to reviewers, its claims are held to the same standard as
code: the 2026-08-15 audit checked `ArchitectureTab.tsx` claim-by-claim
against the source tree, and the chosen "Authority map" direction renders
ownership and runtime truth without presenting configured-but-unused
infrastructure as active. The Tests tab exposes the same rehearsal
instruments the Guardrails section describes (reply judge, load simulator)
so a reviewer can run the safety story, not just read it.

## Testing

Vitest across both workspaces (`npm test`; `npm run check` adds typechecks and
builds). Unit tests use the in-memory store fakes; integration-grade coverage
comes from the judge + load-simulator rehearsals and live smokes against the
running stack. CI runs the exact reviewer commands from a clean clone.

## Deployment

The stack carries one service the earlier SSE-only topology did not need:
**zero-cache** (`infra/zero/`), which holds the SQLite replica the WebSocket
rung serves queries from. It requires Postgres to run with logical replication
enabled — set in `docker-compose.yml` as the base the acceptance overlay
inherits, so an acceptance run cannot pass vacuously against a publication that
could never stream.

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

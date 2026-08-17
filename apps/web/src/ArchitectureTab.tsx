import { TabHeader } from './components/TabHeader';
import './architecture.css';

interface ArchitectureNodeProps {
  eyebrow?: string;
  title: string;
  copy: string;
  tone?: 'blue' | 'cyan' | 'green' | 'yellow' | 'red' | 'violet';
  links?: ReadonlyArray<{ label: string; href: string }>;
}

function ArchitectureNode({ eyebrow, title, copy, tone = 'blue', links }: ArchitectureNodeProps) {
  return (
    <div className={`architecture-node architecture-node--${tone}`}>
      {eyebrow ? <span>{eyebrow}</span> : null}
      <strong>{title}</strong>
      <small>{copy}</small>
      {links?.length ? (
        <nav className="architecture-node-links" aria-label={`${title} links`}>
          {links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

function FlowArrow({ label }: { label: string }) {
  return (
    <div className="architecture-arrow" aria-label={label}>
      <span>{label}</span>
      <b aria-hidden="true">→</b>
    </div>
  );
}

const WEB_SURFACES = [
  ['Watch', 'Video, chat, product rail, holds, auctions, checkout'],
  ['Orders', 'Buyer-scoped purchases and product moments'],
  ['Studio', 'Event, lineup, inventory, transcript, copilot, stage controls'],
  ['History', 'Plans, work items, commits, and verification evidence'],
  ['Tests', 'Isolated rehearsals, load simulation, judge, acceptance runs'],
  ['Architecture', 'This living system map'],
] as const;

const API_DOMAINS = [
  ['Events & config', 'Event ownership, guide, lineup, run of show, settings, policy resolution'],
  ['Catalog & inventory', 'Product groups, variants, search, availability, holds and reservations'],
  ['Commerce', 'Cart, auctions, Stripe checkout, orders, EasyPost rates and box packing'],
  ['Engagement', 'Room chat, presence, transcript moments, product focus and event statistics'],
  ['Intelligence', 'Copilot pipeline, Scout sessions and memory, research, judge and guardrails'],
  ['Operations', 'Health, build history, rehearsals, sync registry and system-test ledger'],
] as const;

const DATA_STORES = [
  ['Catalog', 'product_catalog · storefront_product · option axes and values'],
  ['Live event', 'event · lineup · run of show · config · chat · presence · transcript'],
  ['Commerce', 'inventory_reservation · cart · auction_state · checkout_order'],
  ['Automation', 'copilot_proposal · policy revisions and audit · Scout sessions and memory'],
  ['Verification', 'system-test runs, suites, cases, artifacts, transitions and fixture leases'],
] as const;

const SHARED_PACKAGES = [
  ['@papercusp/sidestage-zero', 'Shared Zero contract: schema, relationships and typed queries imported by client and server alike'],
  ['@papercusp/sync', 'Query registry, typed subscriptions, server-authoritative mutators, WebSocket-first transport with stepped fallback'],
  ['@papercusp/sse', 'Resilient event-stream transport and reconnect behavior—the first rung below WebSockets'],
  ['@papercusp/grid-core', 'Virtualized catalog and inventory grids'],
  ['@papercusp/scout-chat', 'Reusable buyer assistant and streaming chat UI'],
  ['Drawer packages', 'Cart, Scout and composable drawer-stack behavior'],
  ['UI + test contracts', 'Plan document primitives and browser-safe test protocol'],
] as const;

export function ArchitectureTab() {
  return (
    <article className="tab-layout architecture-page" aria-labelledby="architecture-title">
      <header className="architecture-hero">
        <div>
          <TabHeader
            eyebrow="System design · source-backed"
            title="Architecture"
            copy="How SideStage turns a live room into a safe commerce system—from browser and native clients through realtime services, guarded intelligence, durable data, and production operations."
          />
          <p className="architecture-source-note">
            Current implementation map · React 19 + Vite · NestJS · PostgreSQL · Typesense · Zero sync (WebSocket → SSE) · WebRTC
          </p>
        </div>
        <dl className="architecture-snapshot" aria-label="Architecture snapshot">
          <div><dt>Shape</dt><dd>npm workspace monorepo</dd></div>
          <div><dt>Runtime</dt><dd>SPA + modular API</dd></div>
          <div><dt>Trust model</dt><dd>Server-authoritative</dd></div>
          <div><dt>Delivery</dt><dd>Immutable containers</dd></div>
        </dl>
      </header>

      <div className="architecture-layout">
        <nav className="architecture-jump-nav" aria-label="Architecture sections">
          <span className="architecture-jump-nav-label" aria-hidden="true">On this page</span>
          <a href="#system-map">System map</a>
          <a href="#runtime-flows">Runtime flows</a>
          <a href="#llm-pipeline">LLM pipeline</a>
          <a href="#search">Search</a>
          <a href="#data-sync">Data syncing</a>
          <a href="#checkout">Checkout</a>
          <a href="#data-model">Data model</a>
          <a href="#application-layers">Application layers</a>
          <a href="#mobile-apps">Mobile apps</a>
          <a href="#data-safety">Data &amp; safety</a>
          <a href="#testing">Testing</a>
          <a href="#operations">Operations</a>
        </nav>

        <div className="architecture-content">

      <section className="architecture-section" id="system-map" aria-labelledby="system-map-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">01 · Context</p>
          <h2 id="system-map-title">The whole system at a glance</h2>
          <p>One product surface, one public API boundary, and specialized infrastructure behind it.</p>
        </div>
        <div className="architecture-context-diagram" role="img" aria-label="Clients connect through Traefik to the SideStage web application, API and media plane, which use durable data and external providers">
          <div className="architecture-context-column">
            <span className="architecture-column-label">People &amp; clients</span>
            <ArchitectureNode
              eyebrow="Buyer"
              title="Web + native mobile"
              copy="Watch, chat, buy, bid, track orders. Native Android + iOS apps: shared Rust core, UniFFI Kotlin/Swift bindings, thin native UIs"
              tone="cyan"
              links={[
                { label: 'Mobile v1.0.0 (APK + AAB + unsigned IPA)', href: 'https://github.com/Papercusp/sidestage-mobile/releases/tag/v1.0.0' },
                { label: 'Mobile source', href: 'https://github.com/Papercusp/sidestage-mobile' },
              ]}
            />
            <ArchitectureNode eyebrow="Seller" title="Responsive Studio" copy="Run the room, stage products, approve actions" tone="violet" />
            <ArchitectureNode eyebrow="Operator" title="Tests + History" copy="Verify readiness and inspect delivery evidence" tone="yellow" />
          </div>
          <FlowArrow label="HTTPS · WebSocket → SSE · WebRTC" />
          <div className="architecture-context-column architecture-context-column--core">
            <span className="architecture-column-label">SideStage</span>
            <ArchitectureNode eyebrow="Presentation" title="React single-page app" copy="URL-routed surfaces and shared Papercusp UI packages" tone="red" />
            <ArchitectureNode eyebrow="Application" title="NestJS modular API" copy="Domain services, policies, sync and provider adapters" tone="blue" />
            <ArchitectureNode eyebrow="Media" title="MediaMTX + coturn" copy="WHIP publish, WHEP playback, direct ICE + TURN fallback" tone="green" />
          </div>
          <FlowArrow label="Private service network" />
          <div className="architecture-context-column">
            <span className="architecture-column-label">Data &amp; providers</span>
            <ArchitectureNode title="PostgreSQL + Typesense" copy="System of record and searchable product index" tone="blue" />
            <ArchitectureNode title="Stripe + EasyPost" copy="Payment intents, webhook settlement and shipping rates" tone="green" />
            <ArchitectureNode title="Deepgram + model provider" copy="Short-lived transcription access and grounded generation" tone="violet" />
          </div>
        </div>
        <p className="architecture-caption"><strong>Edge boundary:</strong> Traefik terminates TLS. The web container serves static assets; only <code>/api</code> and <code>/healthz</code> reach the API. Media and TURN use dedicated hostnames and protocols.</p>
      </section>

      <section className="architecture-section" id="runtime-flows" aria-labelledby="runtime-flows-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">02 · Behavior</p>
          <h2 id="runtime-flows-title">Three flows define the runtime</h2>
          <p>SideStage keeps fast media, synchronized application state, and durable commerce on separate paths.</p>
        </div>
        <div className="architecture-flow-grid">
          <section className="architecture-flow-card">
            <header><span>Live room</span><h3>Signal → context → guarded response</h3></header>
            <ol className="architecture-flow-line">
              <li><b>1</b><span>Seller publishes WHIP video</span></li>
              <li><b>2</b><span>Deepgram yields live transcript</span></li>
              <li><b>3</b><span>Product focus + room chat ground a turn</span></li>
              <li><b>4</b><span>Copilot proposes reply or action</span></li>
              <li><b>5</b><span>Policy guard + seller approval gate delivery</span></li>
              <li><b>6</b><span>Buyers receive WHEP video + synced room state</span></li>
            </ol>
          </section>
          <section className="architecture-flow-card">
            <header><span>Commerce</span><h3>Intent → reservation → settlement</h3></header>
            <ol className="architecture-flow-line">
              <li><b>1</b><span>Catalog variant exposes derived availability</span></li>
              <li><b>2</b><span>Hold or auction creates an idempotent reservation</span></li>
              <li><b>3</b><span>Cart snapshots quantity and price</span></li>
              <li><b>4</b><span>API creates the Stripe payment intent</span></li>
              <li><b>5</b><span>Stripe webhook authoritatively settles the order</span></li>
              <li><b>6</b><span>Inventory commits or releases; EasyPost quotes shipping</span></li>
            </ol>
          </section>
          <section className="architecture-flow-card">
            <header><span>Application state</span><h3>Subscribe → replicate → stream</h3></header>
            <ol className="architecture-flow-line">
              <li><b>1</b><span>React subscribes to named sync queries</span></li>
              <li><b>2</b><span>One shared Zero contract types every query</span></li>
              <li><b>3</b><span>zero-cache tails Postgres logical replication</span></li>
              <li><b>4</b><span>Subscribers receive incremental row deltas</span></li>
              <li><b>5</b><span>Server-authoritative mutators commit every write</span></li>
              <li><b>6</b><span>Dedicated auction streams preserve server ordering</span></li>
            </ol>
          </section>
        </div>
      </section>

      <section className="architecture-section" id="llm-pipeline" aria-labelledby="llm-pipeline-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">03 · Intelligence</p>
          <h2 id="llm-pipeline-title">How the LLM pipeline works</h2>
          <p>Every model turn runs the same four stages: gather verifiable signals, ground them in real inventory, generate a schema-locked draft, and deliver it only through policy guards.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="Buyer signals are grounded in catalog and transcript context, generated as structured drafts, then guarded by policy before delivery">
          <ArchitectureNode eyebrow="1 · Signals" title="Ingest + classify" copy="Room chat, live transcript moments and deterministic product-focus classification scope the turn" tone="cyan" />
          <FlowArrow label="grounding retrieval" />
          <ArchitectureNode eyebrow="2 · Grounding" title="Context assembly" copy="Event items, catalog products, transcript moments and web findings gathered in parallel under a latency budget" tone="blue" />
          <FlowArrow label="provider-neutral seam" />
          <ArchitectureNode eyebrow="3 · Generation" title="Schema-locked draft" copy="Strict JSON output: reply, citations, confidence, tone and an optional action proposal" tone="violet" />
          <FlowArrow label="policy decision" />
          <ArchitectureNode eyebrow="4 · Guarded delivery" title="Ladder + audit" copy="Relevance, price, inventory and tone guards; suggest → confirm → auto; audited executor" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Model surfaces</h3><dl>
            <div><dt>Seller Copilot</dt><dd>Grounded replies and guarded action proposals in the Studio review queue</dd></div>
            <div><dt>Buyer Scout</dt><dd>Streaming shopping assistant with durable per-buyer session memory</dd></div>
            <div><dt>Judge</dt><dd>Rehearsal grader behind the same model seam—deterministic today, hosted-model ready</dd></div>
            <div><dt>Transcription</dt><dd>Deepgram speech-to-text feeding transcript moments into grounding</dd></div>
          </dl></section>
          <section><h3>Grounding contract</h3><dl>
            <div><dt>Sources</dt><dd>Staged event items, catalog products, transcript moments and capped web findings</dd></div>
            <div><dt>Citations</dt><dd>Every draft cites its source ids; an unsupported question gets an honest no-answer</dd></div>
            <div><dt>Budgets</dt><dd>Research runs in parallel under a sub-two-second budget with p50 and p95 tracking</dd></div>
            <div><dt>Relevance</dt><dd>A draft only ships when retrieved sources actually support the question asked</dd></div>
          </dl></section>
          <section><h3>Safety posture</h3><dl>
            <div><dt>Structured output</dt><dd>Strict JSON schema—malformed or uncited drafts never reach buyers</dd></div>
            <div><dt>Automation ladder</dt><dd>suggest → confirm → auto per action kind, with a ceiling for review-queue drafts</dd></div>
            <div><dt>Outcomes</dt><dd>Executed, awaiting-confirmation, suggested or blocked—each recorded and auditable</dd></div>
            <div><dt>Degradation</dt><dd>No provider configured means a deterministic grounded reply, never a silent failure</dd></div>
          </dl></section>
        </div>
        <p className="architecture-caption"><strong>Provider seam:</strong> generation is provider-neutral—the API binds a hosted model through server-side configuration, secrets never reach the browser, and every stage degrades deterministically.</p>
      </section>

      <section className="architecture-section" id="search" aria-labelledby="search-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">04 · Discovery</p>
          <h2 id="search-title">How search works</h2>
          <p>One typo-tolerant, meaning-aware search stack serves buyers, sellers and Scout alike—and the same queries keep answering from Postgres when the index is away.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="Catalog writes are mirrored into a region-scoped Typesense collection, queried with hybrid keyword and semantic ranking, faceted exactly, and served from Postgres when the index is unavailable">
          <ArchitectureNode eyebrow="1 · Index" title="Region-scoped collection" copy="Typesense mirrors the Postgres catalog per region; documents carry name, description, brand, price, condition, stock and an embedding field" tone="cyan" />
          <FlowArrow label="typed query" />
          <ArchitectureNode eyebrow="2 · Match" title="Hybrid rank fusion" copy="Keyword match with a per-field typo budget (name and description 2, brand 1) fused with semantic vector recall for paraphrased intent" tone="blue" />
          <FlowArrow label="multi_search" />
          <ArchitectureNode eyebrow="3 · Facets" title="Exact disjunctive counts" copy="Category, condition, price-bucket and in-stock counts each computed with that facet's own filter excluded—counts answer what would I get if I toggled this" tone="violet" />
          <FlowArrow label="index unavailable" />
          <ArchitectureNode eyebrow="4 · Degrade" title="Postgres fallback" copy="The same queries serve from full-text (tsvector) and trigram indexes in Postgres—search never goes dark, it gets simpler" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Where search runs</h3><dl>
            <div><dt>Storefront</dt><dd>Buyer product search and type-ahead—semantic recall on, typo budget clamped for latency</dd></div>
            <div><dt>Studio inventory</dt><dd>Seller-scoped owned-item search through the identical stack, so sellers get the same typo tolerance buyers do</dd></div>
            <div><dt>Scout</dt><dd>The shopping assistant's product-search tool queries the same index with consumer-intent matching</dd></div>
          </dl></section>
          <section><h3>Semantic layer</h3><dl>
            <div><dt>Embeddings</dt><dd>OpenAI text-embedding-3-small declared in the collection schema, with a local MiniLM model as the no-key fallback</dd></div>
            <div><dt>When it's skipped</dt><dd>Professional exact-match surfaces (wholesale procurement, SKU lookup) skip the embedding round-trip—pure latency cost there</dd></div>
            <div><dt>Rank fusion</dt><dd>Keyword and vector scores merge into one ranking, so a paraphrase and an exact title both find the product</dd></div>
          </dl></section>
          <section><h3>Correctness guarantees</h3><dl>
            <div><dt>Filter honesty</dt><dd>Facet counts are computed against the full filtered corpus, so a category click never surfaces vector neighbours absent from results</dd></div>
            <div><dt>Availability</dt><dd>In-stock filtering reads the same derived availability the cart enforces</dd></div>
            <div><dt>Truth lives in Postgres</dt><dd>The index is derived state—writes land in the database first and are mirrored forward</dd></div>
          </dl></section>
        </div>
        <p className="architecture-caption"><strong>Degradation contract:</strong> Typesense unavailability is logged and absorbed—the catalog API answers every query either way, so a search-index outage is a relevance regression, never an outage.</p>
      </section>

      <section className="architecture-section" id="data-sync" aria-labelledby="data-sync-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">05 · State</p>
          <h2 id="data-sync-title">How data syncing works</h2>
          <p>Every screen subscribes to named queries; every write is a server-authoritative mutator. Postgres stays the source of truth—clients render replicated state, they never invent it. <em>Transport is a ladder, not a switch: the client asks for one multiplexed WebSocket, then steps down to the SSE invalidation stream and finally bounded polling wherever a zero-cache origin isn't reachable. SSE is the rung serving today.</em></p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="The shared Zero contract declares schema and queries, zero-cache replicates Postgres over logical replication, clients subscribe over one WebSocket, and writes flow through server-authoritative mutators back into Postgres">
          <ArchitectureNode eyebrow="1 · Declare" title="Zero contract package" copy="Schema, relationships and typed queries live in @papercusp/sidestage-zero—one shared contract the client, the server and the parity tests all import" tone="cyan" />
          <FlowArrow label="logical replication" />
          <ArchitectureNode eyebrow="2 · Replicate" title="zero-cache" copy="A dedicated cache tails Postgres over logical replication and materializes each client's subscribed queries so hot-path reads never queue behind the API—provisioned in the Compose stack, not yet running on the public instance" tone="blue" />
          <FlowArrow label="one WebSocket" />
          <ArchitectureNode eyebrow="3 · Subscribe" title="Live queries" copy="Clients subscribe by query name and receive incremental deltas—first paint from local cache, updates stream in as rows change" tone="violet" />
          <FlowArrow label="custom mutators" />
          <ArchitectureNode eyebrow="4 · Mutate" title="Server-authoritative writes" copy="Writes go through API-side mutators that enforce policy and guardrails—Postgres commits, replication fans the change to every subscriber" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Transport</h3><dl>
            <div><dt>WebSockets first</dt><dd>The client asks for one multiplexed WebSocket to carry every query subscription, so incremental deltas can replace whole-snapshot re-fetches</dd></div>
            <div><dt>Fallback ladder</dt><dd>A single session probe decides the rung: WebSocket, else the SSE invalidation stream, else bounded polling as the floor—sync gets simpler, never dark</dd></div>
            <div><dt>Resilience</dt><dd>Reconnect resumes subscriptions from the local cache and catches up on deltas—an offline gap is a catch-up, not a reload</dd></div>
          </dl></section>
          <section><h3>The contract</h3><dl>
            <div><dt>Shared contract</dt><dd>@papercusp/sidestage-zero defines the schema and typed queries; the parity suite pins it against the SSE-era resolvers so the two transports cannot drift apart</dd></div>
            <div><dt>Write discipline</dt><dd>Mutators are ordinary authenticated API calls—policy and guardrails run server-side before any commit, so a client can only propose</dd></div>
            <div><dt>Durable authority</dt><dd>Every client-visible domain—chat, actions, offers, audits, rehearsal state—lands in durable Postgres tables with stable keys and versions before it syncs anywhere</dd></div>
          </dl></section>
          <section><h3>Why WebSockets</h3><dl>
            <div><dt>Latency where it counts</dt><dd>Live bidding, chat and stage state want sub-second push—deltas over an open socket beat invalidate-then-refetch round trips</dd></div>
            <div><dt>Less to re-send</dt><dd>Row-level deltas replace whole-snapshot re-fetches, so a busy auction doesn't re-ship the product rail on every bid</dd></div>
            <div><dt>Built on shared rails</dt><dd>The shared sync library carries the Rocicorp Zero engine used across Papercusp products—SideStage adopts it rather than building its own</dd></div>
          </dl></section>
        </div>
        <p className="architecture-caption"><strong>State split:</strong> user-meaningful state (tab, event, selection) lives in the URL; server state flows through sync queries. A shared link reproduces the same view because the two never mix.</p>
      </section>

      <section className="architecture-section" id="checkout" aria-labelledby="checkout-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">06 · Commerce</p>
          <h2 id="checkout-title">How checkout works</h2>
          <p>Reservation before payment, webhook before trust: the checkout path is built so no two buyers can buy the same unit and no order is marked paid on the client's word.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="A hold reserves inventory, the API creates a Stripe payment intent, the signed webhook settles the order, and fulfilment quotes shipping while releasing or committing stock">
          <ArchitectureNode eyebrow="1 · Reserve" title="Idempotent hold" copy="A hold or auction win writes an inventory_reservation keyed by source kind, source id and variant—retries can't double-reserve" tone="cyan" />
          <FlowArrow label="cart snapshot" />
          <ArchitectureNode eyebrow="2 · Intent" title="Stripe PaymentIntent" copy="The API creates the intent server-side and pins its id to the order; card details go to Stripe, never through SideStage" tone="blue" />
          <FlowArrow label="buyer confirms" />
          <ArchitectureNode eyebrow="3 · Settle" title="Webhook authority" copy="Only Stripe's signed webhook marks an order paid—signature verified, payment-intent id cross-checked, mismatches rejected and logged" tone="violet" />
          <FlowArrow label="paid" />
          <ArchitectureNode eyebrow="4 · Fulfil" title="Ship or release" copy="A paid order commits its reservation and gets EasyPost rates over a box-packed parcel; failure or expiry releases the stock" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Order lifecycle</h3><dl>
            <div><dt>States</dt><dd>checkout_order moves pending → paid or failed—a database CHECK constraint makes a fourth state unrepresentable</dd></div>
            <div><dt>Availability</dt><dd>availableQty is a generated column (quantity minus reserved), so no code path can sell stock the database says is held</dd></div>
            <div><dt>Idempotency</dt><dd>Webhook retries and duplicate confirmations converge on the same final state</dd></div>
          </dl></section>
          <section><h3>Auctions</h3><dl>
            <div><dt>One aggregate</dt><dd>auction_state keeps bids, lifecycle, the inventory hold and the winner's order in a single transaction-owned document</dd></div>
            <div><dt>Settlement</dt><dd>Closing an auction, holding the unit and creating the winner's order commit together or not at all</dd></div>
            <div><dt>Control</dt><dd>Seller auction actions authenticate with signed tokens, separate from buyer identity</dd></div>
          </dl></section>
          <section><h3>Shipping</h3><dl>
            <div><dt>Box packing</dt><dd>A packer fits ordered items into real parcel dimensions before asking for rates</dd></div>
            <div><dt>Rates</dt><dd>EasyPost quotes carriers against the warehouse origin configured server-side</dd></div>
            <div><dt>Provider seam</dt><dd>Stripe and EasyPost sit behind adapters—the domain logic never imports a vendor SDK directly</dd></div>
          </dl></section>
        </div>
        <p className="architecture-caption"><strong>Money truth lives at Stripe:</strong> SideStage stores provider identifiers and derived state. Settlement is asynchronous by design—which is why webhook delivery health is monitored, not assumed.</p>
      </section>

      <section className="architecture-section" id="data-model" aria-labelledby="data-model-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">07 · Schema</p>
          <h2 id="data-model-title">The data model</h2>
          <p>Thirty-six tables in one repeatable schema, organized around four anchors. Constraints live in the database, so invariants hold no matter which code path writes.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="Catalog tables flow into commerce tables, event tables own live-room records, and automation tables audit every guarded action">
          <ArchitectureNode eyebrow="Catalog" title="product_catalog → storefront_product" copy="Catalog truth feeds sellable variants; option axes and values model variant dimensions; a composite (group_id, region) key ties them" tone="blue" />
          <FlowArrow label="reservation FK" />
          <ArchitectureNode eyebrow="Commerce" title="cart → checkout_order · auction_state" copy="Reservation-backed carts settle into CHECK-constrained orders; auctions persist as whole aggregates with lifted hot columns" tone="green" />
          <FlowArrow label="event_id FK" />
          <ArchitectureNode eyebrow="Live event" title="event → lineup · run of show · chat" copy="The event row owns lineup items, config, run-of-show, chat messages, presence and transcript moments" tone="violet" />
          <FlowArrow label="audited writes" />
          <ArchitectureNode eyebrow="Automation" title="proposals · policy · Scout memory" copy="copilot_proposal, seller policy revisions, audit entries, an outbox and idempotency keys record every guarded effect" tone="cyan" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Column patterns</h3><dl>
            <div><dt>Money</dt><dd>Integer cents everywhere—price_cents integer CHECK (&gt;= 0), never floats</dd></div>
            <div><dt>Derived stock</dt><dd>"availableQty" integer GENERATED ALWAYS AS (GREATEST(0, qty − reserved_qty)) STORED—availability is computed by Postgres, not application code</dd></div>
            <div><dt>Guarded documents</dt><dd>jsonb payload columns carry CHECK (jsonb_typeof = 'object'/'array') so a malformed document can't be inserted</dd></div>
            <div><dt>Closed enums</dt><dd>Status and condition columns are text with CHECK constraints—pending/paid/failed is the entire order-state universe</dd></div>
          </dl></section>
          <section><h3>Integrity mechanics</h3><dl>
            <div><dt>Composite keys</dt><dd>FOREIGN KEY (group_id, region) ON UPDATE CASCADE keeps regional catalogs consistent; UNIQUE (slug, region) makes URLs unambiguous</dd></div>
            <div><dt>Reservations</dt><dd>State plus expiry columns with partial indexes—an abandoned hold expires instead of leaking stock</dd></div>
            <div><dt>Exactly-once effects</dt><dd>policy_outbox_event and policy_idempotency make guarded automation deliverable exactly once, restart-safe</dd></div>
            <div><dt>Search columns</dt><dd>A tsvector column with a GIN index and pg_trgm trigram indexes back the fallback search path</dd></div>
          </dl></section>
          <section><h3>Backing technology</h3><dl>
            <div><dt>PostgreSQL 16</dt><dd>The system of record (postgres:16-alpine), with the pg_trgm extension enabled at schema apply</dd></div>
            <div><dt>Typesense 27</dt><dd>Derived, rebuildable search index—never the source of truth</dd></div>
            <div><dt>Redis 7</dt><dd>Disposable cache and coordination—losing it costs latency, not data</dd></div>
            <div><dt>Graceful absence</dt><dd>Every store degrades to in-memory when Postgres is unreachable, so a clean clone boots and demos with zero infrastructure</dd></div>
          </dl></section>
        </div>
        <p className="architecture-caption"><strong>Schema is code:</strong> one idempotent <code>db/schema.sql</code> (CREATE TABLE IF NOT EXISTS plus convergence blocks) is applied on deploy and reviewed like any other change—no hand-run migrations, no drift.</p>
      </section>

      <section className="architecture-section" id="application-layers" aria-labelledby="application-layers-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">08 · Composition</p>
          <h2 id="application-layers-title">Application layers</h2>
          <p>Composition stays app-specific; reusable transport and interface behavior lives in pinned workspace libraries.</p>
        </div>
        <div className="architecture-layer-stack" role="img" aria-label="SideStage application layers from user surfaces through shared frontend libraries, API domains, infrastructure adapters and data stores">
          <div className="architecture-layer architecture-layer--surface">
            <span>Experience layer</span>
            <div>{WEB_SURFACES.map(([title, copy]) => <ArchitectureNode title={title} copy={copy} tone="red" key={title} />)}</div>
          </div>
          <div className="architecture-layer architecture-layer--shared">
            <span>Shared frontend capabilities</span>
            <div>{SHARED_PACKAGES.map(([title, copy]) => <ArchitectureNode title={title} copy={copy} tone="cyan" key={title} />)}</div>
          </div>
          <div className="architecture-layer architecture-layer--api">
            <span>NestJS domain boundary</span>
            <div>{API_DOMAINS.map(([title, copy]) => <ArchitectureNode title={title} copy={copy} tone="blue" key={title} />)}</div>
          </div>
          <div className="architecture-layer architecture-layer--data">
            <span>Durable state and integrations</span>
            <div>{DATA_STORES.map(([title, copy]) => <ArchitectureNode title={title} copy={copy} tone="green" key={title} />)}</div>
          </div>
        </div>
      </section>

      <section className="architecture-section" id="mobile-apps" aria-labelledby="mobile-apps-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">09 · Native apps</p>
          <h2 id="mobile-apps-title">How the mobile apps are built</h2>
          <p>One Rust core carries the domain logic for both platforms; each OS gets a thin native shell. The apps speak the same API and sync contracts as the web client.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="A shared Rust core is compiled per platform, UniFFI generates Kotlin and Swift bindings, and thin native shells render on Android and iOS against the production API">
          <ArchitectureNode eyebrow="1 · Core" title="Shared Rust core" copy="Domain logic, API client and sync live in one set of crates—both platforms ship the same behavior because they ship the same code" tone="cyan" />
          <FlowArrow label="UniFFI bindgen" />
          <ArchitectureNode eyebrow="2 · Bindings" title="Generated Kotlin + Swift" copy="UniFFI generates the language bindings over the core; checksum symbols are verified at build time so bindings and binary cannot drift" tone="blue" />
          <FlowArrow label="native shells" />
          <ArchitectureNode eyebrow="3 · Android" title="Kotlin app" copy="Single-activity Kotlin UI; cargo-ndk cross-compiles the core for all four ABIs with 16 KB-aligned libraries; min SDK 33, target SDK 36" tone="green" />
          <FlowArrow label="same core" />
          <ArchitectureNode
            eyebrow="4 · iOS"
            title="SwiftUI shell"
            copy="A SwiftUI shell over the identical core—v1.0.0 ships an unsigned IPA built with Xcode 16.4 (a build artifact, not installable without re-signing under an Apple Developer certificate)"
            tone="violet"
            links={[
              { label: 'Mobile v1.0.0 (APK + AAB + unsigned IPA)', href: 'https://github.com/Papercusp/sidestage-mobile/releases/tag/v1.0.0' },
              { label: 'Source: sidestage-mobile', href: 'https://github.com/Papercusp/sidestage-mobile' },
            ]}
          />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Distribution</h3><dl>
            <div><dt>Release artifacts</dt><dd>Android v1.0.0 ships as a signed APK (sideload) and AAB (Play bundle); iOS ships as an unsigned IPA awaiting an Apple Developer certificate—all with a provenance manifest recording the source commit and artifact hashes</dd></div>
            <div><dt>Reviewer-reachable</dt><dd>Builds live on the public companion repo's GitHub release page—the same place the app badges on this site point</dd></div>
          </dl></section>
          <section><h3>Backend</h3><dl>
            <div><dt>Production targets baked</dt><dd>The release build pins the live API and media hostnames at compile time—no in-app environment switcher to misconfigure</dd></div>
            <div><dt>Same contracts</dt><dd>The Rust API client speaks the same authenticated REST and sync surface as the web app—one server contract, three clients</dd></div>
          </dl></section>
          <section><h3>Why this shape</h3><dl>
            <div><dt>One core, two shells</dt><dd>Domain behavior is written and tested once in Rust; the platform layers stay thin enough to review in an afternoon</dd></div>
            <div><dt>Drift is a build failure</dt><dd>Binding checksums and packaged-ABI verification run inside the build—an inconsistent artifact fails instead of shipping</dd></div>
          </dl></section>
        </div>
      </section>

      <section className="architecture-section architecture-two-column" id="data-safety" aria-labelledby="data-safety-title">
        <div>
          <div className="architecture-section-heading">
            <p className="eyebrow">10 · Persistence</p>
            <h2 id="data-safety-title">Data is organized around ownership and invariants</h2>
            <p>PostgreSQL is authoritative. Typesense accelerates discovery; Redis is disposable cache infrastructure.</p>
          </div>
          <div className="architecture-data-map" role="img" aria-label="Event, catalog and buyer identities anchor related SideStage records">
            <ArchitectureNode eyebrow="Seller anchor" title="event" copy="Owns lineup, configuration, run of show, auctions, proposals, chat and transcript" tone="violet" />
            <ArchitectureNode eyebrow="Catalog anchor" title="storefront_product" copy="Sellable variant owns price, stock and source-tracked reservations" tone="blue" />
            <ArchitectureNode eyebrow="Buyer anchor" title="buyer identity" copy="Scopes carts, orders and persistent Scout session transcripts" tone="cyan" />
          </div>
          <ul className="architecture-principles">
            <li><strong>Availability is derived.</strong> Trigger-maintained reserved quantity prevents independent stock counters from drifting.</li>
            <li><strong>Reservations carry sources.</strong> A hold is idempotent by source kind, source id and variant, then committed or released.</li>
            <li><strong>Ownership is immutable.</strong> Database constraints and guards prevent event, inventory, auction, order or Scout records from crossing principals.</li>
            <li><strong>Search degrades safely.</strong> Typesense serves typo-tolerant discovery; Postgres full-text and trigram search remain the fallback.</li>
          </ul>
        </div>
        <aside className="architecture-trust-card" aria-labelledby="trust-title">
          <p className="eyebrow">Trust boundary</p>
          <h3 id="trust-title">The browser proposes. The server decides.</h3>
          <div className="architecture-gate-diagram">
            <span>Generated reply or action</span><b aria-hidden="true">↓</b>
            <span>Grounding + relevance</span><b aria-hidden="true">↓</b>
            <span>Price · inventory · tone · policy guard</span><b aria-hidden="true">↓</b>
            <span>Seller approval when required</span><b aria-hidden="true">↓</b>
            <span>Audited executor</span><b aria-hidden="true">↓</b>
            <span>Buyer-visible effect</span>
          </div>
          <ul>
            <li>Provider secrets remain server-side; Deepgram receives a short-lived token.</li>
            <li>Stripe owns raw payment details; SideStage stores provider identifiers and order state.</li>
            <li>Copilot actions are normalized, authorized, recorded and reversible before success is reported.</li>
            <li>System tests use a trusted, isolated worker and fixture leases—never live commerce data.</li>
          </ul>
        </aside>
      </section>

      <section className="architecture-section" id="testing" aria-labelledby="testing-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">11 · Verification</p>
          <h2 id="testing-title">How the test framework works</h2>
          <p>Four layers, all deterministic: focused unit specs, contract parity, in-app rehearsal, and a rule-based judge. No LLM sits in any gate—every verdict is reproducible.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="Focused Vitest specs feed contract parity checks, in-app rehearsals simulate load, and a deterministic judge grades replies before anything ships">
          <ArchitectureNode eyebrow="1 · Unit" title="Focused Vitest specs" copy="Colocated *.test.ts specs across the web, API and deploy workspaces—npm test runs the deploy project first, then the app suites" tone="cyan" />
          <FlowArrow label="shared contracts" />
          <ArchitectureNode eyebrow="2 · Contract" title="Parity + census suites" copy="The sync census enumerates every registered read surface, and the Zero parity suite pins the WebSocket contract against the SSE-era resolvers" tone="blue" />
          <FlowArrow label="in-app Tests tab" />
          <ArchitectureNode eyebrow="3 · Rehearsal" title="Load + injection rehearsal" copy="The Tests surface runs scripted load—price, shipping, policy, variant, stock, offer and bid prompts—plus prompt-injection rehearsal against the copilot" tone="violet" />
          <FlowArrow label="graded output" />
          <ArchitectureNode eyebrow="4 · Judge" title="Deterministic reply judge" copy="A rule-based judge grades grounding, citations and tone with reproducible verdicts—the same input always gets the same grade" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Where tests live</h3><dl>
            <div><dt>Beside the code</dt><dd>Every module keeps its spec next to the source—guardrail.test.ts beside guardrail.ts—so a change and its proof travel in one diff</dd></div>
            <div><dt>Deploy scripts too</dt><dd>The deploy tooling is itself under test: rollback, deploy-lock, release positive-controls and probe hygiene each have focused suites</dd></div>
          </dl></section>
          <section><h3>What gates a ship</h3><dl>
            <div><dt>One command</dt><dd>npm run check runs the workspace typecheck and the full Vitest matrix—the same gate a clean clone runs for reviewers</dd></div>
            <div><dt>Health-checked deploys</dt><dd>Production deploys verify the public health contract after cutover and roll back automatically on failure</dd></div>
          </dl></section>
          <section><h3>Determinism</h3><dl>
            <div><dt>No model in the loop</dt><dd>Gates never ask an LLM for a verdict—the judge is rules, fixtures are seeded, and rehearsal prompts are scripted</dd></div>
            <div><dt>Focused-fail workflow</dt><dd>A red run is isolated into a focused spec, fixed, then re-run through the suite—the workflow that caught the malformed tone regex before ship</dd></div>
          </dl></section>
        </div>
      </section>

      <section className="architecture-section" id="operations" aria-labelledby="operations-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">12 · Operations</p>
          <h2 id="operations-title">From source tree to production</h2>
          <p>The repository, verification gate and deployment topology are part of the architecture—not afterthoughts.</p>
        </div>
        <div className="architecture-delivery-diagram" role="img" aria-label="Source changes pass through workspace verification, immutable builds, container deployment, routing and health-checked rollback">
          <ArchitectureNode eyebrow="Source" title="npm workspaces" copy="apps/web · apps/api · libs · db · deploy" tone="cyan" />
          <FlowArrow label="typecheck + Vitest" />
          <ArchitectureNode eyebrow="Gate" title="Clean-clone verification" copy="API, web, deploy, contract and integration coverage" tone="yellow" />
          <FlowArrow label="snapshot + build" />
          <ArchitectureNode eyebrow="Artifact" title="Per-SHA containers" copy="NestJS node image + Vite/nginx image" tone="violet" />
          <FlowArrow label="Compose rollout" />
          <ArchitectureNode eyebrow="Production" title="Traefik-routed stack" copy="Health probes, isolated volumes and previous-SHA rollback" tone="green" />
        </div>
        <div className="architecture-operations-grid">
          <section><h3>Repository map</h3><dl><div><dt><code>apps/web</code></dt><dd>React SPA and browser adapters</dd></div><div><dt><code>apps/api</code></dt><dd>NestJS domain modules and provider boundaries</dd></div><div><dt><code>libs</code></dt><dd>Pinned reusable Papercusp packages</dd></div><div><dt><code>db</code></dt><dd>Repeatable schema and deterministic seed</dd></div><div><dt><code>deploy</code></dt><dd>Snapshot, probe, rollout and rollback scripts</dd></div></dl></section>
          <section><h3>Production services</h3><dl><div><dt>web</dt><dd>Static nginx container</dd></div><div><dt>api</dt><dd>Unpublished internal port behind Traefik</dd></div><div><dt>system-test-worker</dt><dd>Trusted acceptance queue consumer</dd></div><div><dt>postgres · typesense · redis</dt><dd>Durable record, search and cache</dd></div><div><dt>mediamtx · turn</dt><dd>Low-latency media and restrictive-network fallback</dd></div></dl></section>
          <section><h3>Verification strategy</h3><dl><div><dt>Unit</dt><dd>Pure policies, stores, controllers and UI behavior</dd></div><div><dt>Integration</dt><dd>Database adapters, sync contracts and provider seams</dd></div><div><dt>Rehearsal</dt><dd>Actions, auction, checkout, injection, load and judge</dd></div><div><dt>Acceptance</dt><dd>Dedicated ledger, artifacts, retries, cancellation and cleanup</dd></div><div><dt>Operations</dt><dd>Health probes and release rollback preserve availability</dd></div></dl></section>
        </div>
      </section>

          <footer className="architecture-page-footer">
            <strong>Architectural rule of thumb</strong>
            <p>Realtime transport may be optimistic; commerce, ownership, policy and automation outcomes are always server-authoritative and durably auditable.</p>
          </footer>
        </div>
      </div>
    </article>
  );
}

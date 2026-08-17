import { TabHeader } from './components/TabHeader';
import './architecture.css';

interface ArchitectureNodeProps {
  eyebrow?: string;
  title: string;
  copy: string;
  tone?: 'blue' | 'cyan' | 'green' | 'yellow' | 'red' | 'violet';
}

function ArchitectureNode({ eyebrow, title, copy, tone = 'blue' }: ArchitectureNodeProps) {
  return (
    <div className={`architecture-node architecture-node--${tone}`}>
      {eyebrow ? <span>{eyebrow}</span> : null}
      <strong>{title}</strong>
      <small>{copy}</small>
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
  ['@papercusp/sync', 'Query registry, batched reads, mutations, SSE invalidation'],
  ['@papercusp/sse', 'Resilient event-stream transport and reconnect behavior'],
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
            Current implementation map · React 19 + Vite · NestJS · PostgreSQL · Typesense · SSE · WebRTC
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
          <a href="#application-layers">Application layers</a>
          <a href="#data-safety">Data &amp; safety</a>
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
            <ArchitectureNode eyebrow="Buyer" title="Web + native mobile" copy="Watch, chat, buy, bid, track orders" tone="cyan" />
            <ArchitectureNode eyebrow="Seller" title="Responsive Studio" copy="Run the room, stage products, approve actions" tone="violet" />
            <ArchitectureNode eyebrow="Operator" title="Tests + History" copy="Verify readiness and inspect delivery evidence" tone="yellow" />
          </div>
          <FlowArrow label="HTTPS · SSE · WebRTC" />
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
              <li><b>6</b><span>Buyers receive WHEP video + SSE state</span></li>
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
            <header><span>Application state</span><h3>Query → invalidate → reconcile</h3></header>
            <ol className="architecture-flow-line">
              <li><b>1</b><span>React requests named sync queries</span></li>
              <li><b>2</b><span>API registry maps names to domain reads</span></li>
              <li><b>3</b><span>REST batch returns initial snapshots</span></li>
              <li><b>4</b><span>Domain writes publish scoped invalidations</span></li>
              <li><b>5</b><span>SSE reconnects and refreshes affected queries</span></li>
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

      <section className="architecture-section" id="application-layers" aria-labelledby="application-layers-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">04 · Composition</p>
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

      <section className="architecture-section architecture-two-column" id="data-safety" aria-labelledby="data-safety-title">
        <div>
          <div className="architecture-section-heading">
            <p className="eyebrow">05 · Persistence</p>
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

      <section className="architecture-section" id="operations" aria-labelledby="operations-title">
        <div className="architecture-section-heading">
          <p className="eyebrow">06 · Operations</p>
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

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BuyerTab } from './BuyerTab';
import { CopilotPanel } from './CopilotPanel';
import { type ProductTone } from './components/ProductCard';
import { EventChat } from './EventChat';
import { TranscriptPane, type TranscriptProductOption } from './TranscriptPane';
import EventManager from './events/EventManager';
import { simulateLoad, type LoadSimulationResult } from './load-simulator';
import {
  connectPublisher,
  createEventRoom,
  type EventRoom,
  type PublisherSession,
} from './streaming';

export type TabId = 'buyer' | 'seller' | 'config' | 'test';

export const TABS: ReadonlyArray<{ id: TabId; label: string; description: string }> = [
  { id: 'buyer', label: 'Buyer', description: 'Browse the live catalog' },
  { id: 'seller', label: 'Seller', description: 'Run the stage' },
  { id: 'config', label: 'Config', description: 'Set event guardrails' },
  { id: 'test', label: 'Test', description: 'Check your setup' },
];

export interface CatalogProduct {
  id: string;
  name: string;
  price: string;
  compareAt?: string;
  description: string;
  badge?: string;
  stockLabel: string;
  tone: ProductTone;
  glyph: string;
}

export const DEMO_PRODUCTS: ReadonlyArray<CatalogProduct> = [
  {
    id: 'aurora-cup',
    name: 'Aurora ceramic cup',
    price: '$28',
    compareAt: '$36',
    description: 'Hand-glazed stoneware with a soft blue frost finish.',
    badge: 'Featured',
    stockLabel: '18 available',
    tone: 'cyan',
    glyph: '◒',
  },
  {
    id: 'cloud-knit',
    name: 'Cloudline knit',
    price: '$64',
    compareAt: '$78',
    description: 'A lightweight layer that reads beautifully on camera.',
    badge: 'Best seller',
    stockLabel: '7 available',
    tone: 'violet',
    glyph: '⌁',
  },
  {
    id: 'ember-kit',
    name: 'Ember ritual kit',
    price: '$42',
    description: 'Three small-batch scents packed for a slow unboxing.',
    stockLabel: '31 available',
    tone: 'amber',
    glyph: '◌',
  },
];

export const TRANSCRIPT_PRODUCTS: ReadonlyArray<TranscriptProductOption> = [
  { id: 'aurora-cup', label: 'Aurora ceramic cup', aliases: ['aurora cup', 'ceramic cup'] },
  { id: 'cloud-knit', label: 'Cloudline knit', aliases: ['cloudline', 'knit layer'] },
  { id: 'ember-kit', label: 'Ember ritual kit', aliases: ['ember kit', 'ritual kit'] },
];

type StreamState = 'idle' | 'connecting' | 'live' | 'error';

const DEFAULT_EVENT_ID = 'sunday-drop';
const DEFAULT_EVENT_TITLE = 'Sunday vintage drop';

function mediaBaseUrl(): string | undefined {
  return import.meta.env.VITE_MEDIAMTX_URL;
}

function browserEventId(): string {
  if (typeof window === 'undefined') return DEFAULT_EVENT_ID;
  const eventId = new URLSearchParams(window.location.search).get('event');
  return chatEventId(eventId ?? '');
}

function chatEventId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : DEFAULT_EVENT_ID;
}

function streamLabel(state: StreamState): string {
  return state === 'live'
    ? 'Live now'
    : state === 'connecting'
      ? 'Connecting…'
      : state === 'error'
        ? 'Stream unavailable'
        : 'Preview ready';
}

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

function urlFor(value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>): URL {
  if (value instanceof URL) return new URL(value.href);
  if (typeof value === 'string') return new URL(value, 'https://sidestage.local');
  return new URL(`${value.pathname}${value.search}${value.hash}`, 'https://sidestage.local');
}

/** Resolve the active tab from URL state, accepting both query and path URLs. */
export function getTabFromUrl(value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>): TabId {
  const url = urlFor(value);
  const queryTab = url.searchParams.get('tab');
  if (isTabId(queryTab)) return queryTab;

  const pathTab = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return isTabId(pathTab) ? pathTab : 'buyer';
}

export function tabHref(tab: TabId, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', tab);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

function useUrlTab(): [TabId, (tab: TabId) => void] {
  const read = () => (typeof window === 'undefined' ? 'buyer' : getTabFromUrl(window.location));
  const [tab, setTab] = useState<TabId>(read);

  useEffect(() => {
    const onPopState = () => setTab(read());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (nextTab: TabId) => {
    if (typeof window === 'undefined') return;
    window.history.pushState({ tab: nextTab }, '', tabHref(nextTab, window.location.href));
    setTab(nextTab);
  };

  return [tab, navigate];
}

function TabHeader({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <div className="tab-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="tab-copy">{copy}</p>
    </div>
  );
}

function SellerTab({
  selectedProduct,
  selectedProductId,
  onActiveProductChange,
}: {
  selectedProduct: CatalogProduct | null;
  selectedProductId: string | null;
  onActiveProductChange: (productId: string | null) => void;
}) {
  const [eventId, setEventId] = useState(DEFAULT_EVENT_ID);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [room, setRoom] = useState<EventRoom | null>(null);
  const sessionRef = useRef<PublisherSession | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void session.stop();
    };
  }, []);

  const startEvent = async () => {
    if (sessionRef.current || streamState === 'connecting') return;
    let nextRoom: EventRoom;
    try {
      nextRoom = createEventRoom(eventId);
    } catch (error) {
      setStreamState('error');
      setStreamError(error instanceof Error ? error.message : 'Choose a valid event room id.');
      return;
    }

    setRoom(nextRoom);
    setStreamState('connecting');
    setStreamError(null);
    try {
      const session = await connectPublisher({ room: nextRoom, mediaBaseUrl: mediaBaseUrl() });
      sessionRef.current = session;
      setStreamState('live');
      if (videoRef.current) videoRef.current.srcObject = session.localStream;
    } catch (error) {
      setStreamState('error');
      setStreamError(error instanceof Error ? error.message : 'The camera and microphone could not be connected.');
    }
  };

  const stopEvent = () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setStreamState('idle');
    if (videoRef.current) videoRef.current.srcObject = null;
    if (session) void session.stop();
  };

  const copyShareUrl = async () => {
    if (!room) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(room.shareUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    globalThis.setTimeout(() => setCopyState('idle'), 1800);
  };

  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Seller view / stage control"
        title="Keep the room moving."
        copy="Your live context stays one glance away: what is on deck, what buyers are asking, and what the copilot can safely suggest."
      />
      <div className="seller-grid">
        <section className="stage-panel stage-primary" aria-labelledby="stage-status-title">
          <div className="panel-kicker"><span className="live-dot" /> Live console <span className="panel-status">{streamLabel(streamState)}</span></div>
          <h2 id="stage-status-title">{DEFAULT_EVENT_TITLE}</h2>
          <p>Start the event when your camera and catalog are ready. SideStage publishes one room path that buyers can join with a share link.</p>
          <div className="seller-stream-preview">
            <video ref={videoRef} className="stream-video" autoPlay muted playsInline aria-label="Seller camera preview" />
            <div className="stream-video-overlay">
              <span className="live-badge">{room?.eventId ?? 'room not started'}</span>
              <p>{streamError ?? (streamState === 'live' ? 'Your camera and microphone are live.' : 'Camera preview appears here after you start the event.')}</p>
            </div>
          </div>
          <label className="field-label" htmlFor="seller-event-id">Event room id</label>
          <input
            id="seller-event-id"
            className="text-input"
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            disabled={streamState === 'connecting' || streamState === 'live'}
            aria-describedby="seller-event-help"
          />
          <p className="field-help" id="seller-event-help">Lowercase letters, numbers, and hyphens become the buyer share-link slug.</p>
          <div className="stage-actions">
            {sessionRef.current ? (
              <button className="button secondary" type="button" onClick={stopEvent}>End event</button>
            ) : (
              <button className="button primary" type="button" onClick={() => void startEvent()} disabled={streamState === 'connecting'}>
                {streamState === 'connecting' ? 'Starting…' : 'Start event'}
              </button>
            )}
            <button className="button secondary" type="button" onClick={() => void copyShareUrl()} disabled={!room}>
              {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share room'}
            </button>
          </div>
        </section>
        <TranscriptPane
          className="seller-transcript"
          mediaStream={sessionRef.current?.localStream}
          deepgramToken={import.meta.env.VITE_DEEPGRAM_TOKEN}
          products={TRANSCRIPT_PRODUCTS}
          activeProductId={selectedProductId}
          onActiveProductChange={onActiveProductChange}
        />
        <section className="stage-panel" aria-labelledby="on-deck-title">
          <div className="panel-kicker">On deck <span className="panel-status">1 slot</span></div>
          {selectedProduct ? (
            <div className="on-deck-product">
              <div className={`mini-product-mark tone-${selectedProduct.tone}`}>{selectedProduct.glyph}</div>
              <div><h3 id="on-deck-title">{selectedProduct.name}</h3><p>{selectedProduct.price} · {selectedProduct.stockLabel}</p></div>
            </div>
          ) : (
            <div className="empty-state"><span className="empty-state-icon">＋</span><h3 id="on-deck-title">Choose a product</h3><p>Use the Buyer tab to place the first item on stage.</p></div>
          )}
        </section>
        <section className="stage-panel insight-panel" aria-labelledby="copilot-note-title">
          <div className="panel-kicker">Copilot note <span className="confidence-pill">Grounded</span></div>
          <h3 id="copilot-note-title">“Lead with the glaze detail.”</h3>
          <p>The product description and event policy support this suggestion. Nothing is sent without your approval.</p>
        </section>
        <CopilotPanel apiBaseUrl={import.meta.env.VITE_API_URL} />
        <EventChat
          eventId={room?.eventId ?? chatEventId(eventId)}
          role="seller"
          userId="seller-demo"
          displayName="Host"
          eventTitle={DEFAULT_EVENT_TITLE}
          apiBaseUrl={import.meta.env.VITE_API_URL}
        />
        <EventManager />
      </div>
    </div>
  );
}

function ConfigTab() {
  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Config / event guardrails"
        title="Make the safe choice easy."
        copy="Set the defaults your copilot should respect before the first buyer joins the room."
      />
      <div className="config-grid">
        <section className="settings-panel" aria-labelledby="event-settings-title">
          <div className="panel-kicker">Event settings</div>
          <h2 id="event-settings-title">Sunday vintage drop</h2>
          <label className="field-label" htmlFor="event-name">Event name</label>
          <input id="event-name" className="text-input" defaultValue="Sunday vintage drop" />
          <label className="field-label" htmlFor="reply-tone">Reply tone</label>
          <select id="reply-tone" className="text-input" defaultValue="warm">
            <option value="warm">Warm and concise</option>
            <option value="playful">Playful and bright</option>
            <option value="minimal">Minimal and direct</option>
          </select>
        </section>
        <section className="settings-panel" aria-labelledby="guardrails-title">
          <div className="panel-kicker">Guardrails</div>
          <h2 id="guardrails-title">Always ask before send</h2>
          <label className="toggle-row"><input type="checkbox" defaultChecked /> <span><strong>Price changes</strong><small>Never invent a discount or bundle.</small></span></label>
          <label className="toggle-row"><input type="checkbox" defaultChecked /> <span><strong>Inventory claims</strong><small>Use the latest catalog quantity only.</small></span></label>
          <label className="toggle-row"><input type="checkbox" defaultChecked /> <span><strong>Buyer-sensitive topics</strong><small>Keep uncertain replies in review.</small></span></label>
        </section>
      </div>
      <button className="button primary config-save" type="button">Save event defaults</button>
    </div>
  );
}

export function TestTab() {
  const checks = [
    ['Catalog connection', 'Ready', 'success'],
    ['Copilot grounding', 'Ready', 'success'],
    ['Stream input', 'Not connected', 'muted'],
    ['Reply approval', 'Required', 'warning'],
  ] as const;
  const [users, setUsers] = useState('3');
  const [messagesPerSecond, setMessagesPerSecond] = useState('2');
  const [durationSeconds, setDurationSeconds] = useState('4');
  const [simulation, setSimulation] = useState<LoadSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  const runLoadRehearsal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = simulateLoad({
        users: Number(users),
        messagesPerSecond: Number(messagesPerSecond),
        durationSeconds: Number(durationSeconds),
      });
      setSimulation(result);
      setSimulationError(null);
    } catch (error) {
      setSimulation(null);
      setSimulationError(error instanceof Error ? error.message : 'Enter positive whole numbers for each field.');
    }
  };

  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Test / launch readiness"
        title="Know before you go live."
        copy="Run a quick rehearsal of the hand-offs that matter. A green check means the seam is ready for a real event."
      />
      <section className="readiness-panel" aria-labelledby="readiness-title">
        <div className="panel-kicker">Preflight <span className="panel-status">3 of 4 ready</span></div>
        <h2 id="readiness-title">Sunday vintage drop</h2>
        <div className="readiness-list">
          {checks.map(([label, value, tone]) => <div className="readiness-row" key={label}><span>{label}</span><strong className={`status-${tone}`}>{value}</strong></div>)}
        </div>
        <button className="button secondary" type="button">Run rehearsal</button>
      </section>
      <section className="load-simulator-panel" aria-labelledby="load-simulator-title">
        <div className="panel-kicker">Load rehearsal <span className="panel-status">{simulation ? 'Completed' : 'Not run'}</span></div>
        <h2 id="load-simulator-title">Pressure-test the copilot seam.</h2>
        <p className="load-simulator-copy">Schedule deterministic websocket-client traffic locally before you open the room. This rehearsal checks the scripted price, shipping, policy, variant, stock, offer, and bid prompts without sending anything to buyers.</p>
        <form className="load-simulator-form" onSubmit={runLoadRehearsal}>
          <div className="load-simulator-fields">
            <label className="field-label" htmlFor="load-users">Simulated users
              <input id="load-users" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={users} onChange={(event) => setUsers(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-messages-per-second">Messages / user / sec
              <input id="load-messages-per-second" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={messagesPerSecond} onChange={(event) => setMessagesPerSecond(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-duration">Duration (seconds)
              <input id="load-duration" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} />
            </label>
          </div>
          <button className="button primary" type="submit">Run load rehearsal</button>
        </form>
        {simulationError ? <p className="load-simulator-error" role="alert">{simulationError}</p> : null}
        {simulation ? (
          <div className="load-simulator-result" aria-live="polite">
            <div className="load-simulator-stats">
              <div><strong>{simulation.totalMessages}</strong><span>scheduled messages</span></div>
              <div><strong>{simulation.clients.length}</strong><span>simulated clients</span></div>
              <div><strong>{simulation.request.durationSeconds}s</strong><span>rehearsal duration</span></div>
            </div>
            <div className="load-coverage">
              <div className="load-coverage-heading"><span>Scripted corpus coverage</span><strong>{simulation.coverage.observedKinds.length}/{simulation.coverage.expectedKinds.length} scenarios</strong></div>
              <div className="load-coverage-list">
                {simulation.coverage.expectedKinds.map((kind) => <span className={'coverage-chip' + (simulation.coverage.observedKinds.includes(kind) ? ' covered' : '')} key={kind}>{kind} · {simulation.coverage.counts[kind] ?? 0}</span>)}
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <div className="test-note"><span className="feature-icon cyan">⌁</span><p>Tip: connect your stream when you are ready. You can still rehearse catalog and copilot flows without a camera.</p></div>
    </div>
  );
}

export function App() {
  const [tab, navigate] = useUrlTab();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const selectedProduct = DEMO_PRODUCTS.find((product) => product.id === selectedProductId) ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href={tabHref('buyer')} onClick={(event) => { event.preventDefault(); navigate('buyer'); }} aria-label="SideStage home">
          <span className="wordmark-mark" aria-hidden="true">✦</span>
          SideStage
        </a>
        <nav className="tab-nav" aria-label="Primary navigation">
          {TABS.map((item) => (
            <a
              className={`nav-link${tab === item.id ? ' active' : ''}`}
              href={tabHref(item.id)}
              aria-current={tab === item.id ? 'page' : undefined}
              key={item.id}
              onClick={(event) => { event.preventDefault(); navigate(item.id); }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <span className="connection-pill"><span className="connection-dot" /> Ready for your next event</span>
      </header>

      <main className="content">
        {tab === 'buyer' ? (
          <BuyerTab
            eventId={browserEventId()}
            eventTitle={DEFAULT_EVENT_TITLE}
            mediaBaseUrl={mediaBaseUrl()}
          />
        ) : null}
        {tab === 'seller' ? (
          <SellerTab
            selectedProduct={selectedProduct}
            selectedProductId={selectedProductId}
            onActiveProductChange={setSelectedProductId}
          />
        ) : null}
        {tab === 'config' ? <ConfigTab /> : null}
        {tab === 'test' ? <TestTab /> : null}
        <footer className="footer"><span>SideStage preview</span><span>Built for the live-selling floor</span></footer>
      </main>
    </div>
  );
}

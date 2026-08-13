import { useEffect, useState } from 'react';
import { ProductCard, type ProductTone } from './components/ProductCard';

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

function BuyerTab({ onAddToStage, selectedProduct }: { onAddToStage: (id: string) => void; selectedProduct: string | null }) {
  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Buyer view / live catalog"
        title="Find your next favorite."
        copy="See the products your seller can put in front of you, with the details that make a confident decision easier."
      />
      <div className="catalog-toolbar" aria-label="Catalog tools">
        <span className="toolbar-label">Sunday vintage drop</span>
        <span className="toolbar-count">3 products · prices verified</span>
      </div>
      <div className="product-grid">
        {DEMO_PRODUCTS.map((product) => (
          <ProductCard key={product.id} {...product} selected={product.id === selectedProduct} onSelect={onAddToStage} />
        ))}
      </div>
    </div>
  );
}

function SellerTab({ selectedProduct }: { selectedProduct: CatalogProduct | null }) {
  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Seller view / stage control"
        title="Keep the room moving."
        copy="Your live context stays one glance away: what is on deck, what buyers are asking, and what the copilot can safely suggest."
      />
      <div className="seller-grid">
        <section className="stage-panel stage-primary" aria-labelledby="stage-status-title">
          <div className="panel-kicker"><span className="live-dot" /> Live console <span className="panel-status">Ready</span></div>
          <h2 id="stage-status-title">Sunday vintage drop</h2>
          <p>Start the event when your camera and catalog are ready. SideStage will keep the active product in view.</p>
          <div className="stage-actions"><button className="button primary" type="button">Start event</button><button className="button secondary" type="button">Preview room</button></div>
        </section>
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

function TestTab() {
  const checks = [
    ['Catalog connection', 'Ready', 'success'],
    ['Copilot grounding', 'Ready', 'success'],
    ['Stream input', 'Not connected', 'muted'],
    ['Reply approval', 'Required', 'warning'],
  ] as const;

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
        {tab === 'buyer' ? <BuyerTab onAddToStage={setSelectedProductId} selectedProduct={selectedProductId} /> : null}
        {tab === 'seller' ? <SellerTab selectedProduct={selectedProduct} /> : null}
        {tab === 'config' ? <ConfigTab /> : null}
        {tab === 'test' ? <TestTab /> : null}
        <footer className="footer"><span>SideStage preview</span><span>Built for the live-selling floor</span></footer>
      </main>
    </div>
  );
}

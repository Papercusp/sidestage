import { useCallback, useMemo, useState } from 'react';
import { TABS, tabHref, useUrlTab } from './app-routing';
import { AppDownloadButtons } from './components/AppDownloadButtons';
import { BuyerTab } from './BuyerTab';
import { ConfigTab } from './ConfigTab';
import { browserEventId, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { OrdersTab } from './OrdersTab';
import { SellerTab } from './SellerTab';
import {
  useSellerCatalog,
  variantToSellerProduct,
  variantToTranscriptOption,
} from './seller-products';
import { TestTab } from './TestTab';

// Test-compat re-exports: the app shell remains the public face of these.
export { getTabFromUrl, tabHref, TABS, type TabId } from './app-routing';
export { variantToSellerProduct, variantToTranscriptOption, type CatalogProduct } from './seller-products';
export { TestTab } from './TestTab';

export function App() {
  const [tab, navigate] = useUrlTab();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  /* P-118 / D-019: the active event is app state, not a hard-pin. It seeds
     from ?event= so existing share links keep resolving, and the Channel Guide
     moves it. */
  const [activeEventId, setActiveEventId] = useState(browserEventId);

  const selectEvent = useCallback((nextEventId: string) => {
    setActiveEventId(nextEventId);
    if (typeof window === 'undefined') return;
    // Keep ?event= in step with what the buyer is watching. replaceState, not
    // push: switching rooms in a guide is not a navigation a Back press should
    // walk through one room at a time. The share button reads the same id, so
    // a link copied after a switch points at the room actually on screen.
    const url = new URL(window.location.href);
    url.searchParams.set('event', nextEventId);
    window.history.replaceState({}, '', url);
  }, []);
  const sellerVariants = useSellerCatalog();
  const sellerProducts = useMemo(
    () => sellerVariants.map((variant, index) => variantToSellerProduct(variant, index)),
    [sellerVariants],
  );
  const transcriptProducts = useMemo(
    () => sellerVariants.map(variantToTranscriptOption),
    [sellerVariants],
  );
  const selectedProduct = sellerProducts.find((product) => product.id === selectedProductId) ?? null;

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
            eventId={activeEventId}
            eventTitle={DEFAULT_EVENT_TITLE}
            mediaBaseUrl={mediaBaseUrl()}
            onEventChange={selectEvent}
          />
        ) : null}
        {tab === 'orders' ? <OrdersTab /> : null}
        {tab === 'seller' ? (
          <SellerTab
            selectedProduct={selectedProduct}
            selectedProductId={selectedProductId}
            transcriptProducts={transcriptProducts}
            onActiveProductChange={setSelectedProductId}
          />
        ) : null}
        {tab === 'config' ? <ConfigTab /> : null}
        {tab === 'test' ? <TestTab /> : null}
        <footer className="footer">
          <span>SideStage preview</span>
          <AppDownloadButtons />
          <span>Built for the live-selling floor</span>
        </footer>
      </main>
    </div>
  );
}

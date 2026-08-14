import { useCallback, useMemo, useState } from 'react';
import { TAB_GROUPS, tabHref, type TabId, useUrlTab } from './app-routing';
import { AppDownloadButtons } from './components/AppDownloadButtons';
import { BuildHistoryTab } from './BuildHistoryTab';
import { BuyerTab } from './BuyerTab';
import { BuyerCheckoutProvider } from './BuyerCheckout';
import { browserEventId, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { OrdersTab } from './OrdersTab';
import { SellerTab } from './SellerTab';
import {
  useSellerCatalog,
  variantToSellerProduct,
  variantToTranscriptOption,
} from './seller-products';
import { SystemTestsTab } from './SystemTestsTab';
import { TestTab } from './TestTab';

// Test-compat re-exports: the app shell remains the public face of these.
export { getTabFromUrl, TAB_GROUPS, tabHref, TABS, type TabId } from './app-routing';
export { variantToSellerProduct, variantToTranscriptOption, type CatalogProduct } from './seller-products';
export { SystemTestsTab } from './SystemTestsTab';
export { TestTab } from './TestTab';

export function appLayoutForTab(tab: TabId) {
  const isSeller = tab === 'seller';
  return {
    shellClassName: `app-shell${isSeller ? ' app-shell--seller' : ''}`,
    contentClassName: `content${isSeller ? ' content-seller' : ''}`,
    showFooter: !isSeller,
  };
}

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
  const layout = appLayoutForTab(tab);

  return (
    <div className={layout.shellClassName}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href={tabHref('buyer')} onClick={(event) => { event.preventDefault(); navigate('buyer'); }} aria-label="SideStage home">
            <span className="wordmark-mark" aria-hidden="true">S</span>
            <span className="wordmark-copy">
              <strong>SideStage</strong>
              <small>Live commerce</small>
            </span>
          </a>
          <nav className="tab-nav" aria-label="SideStage pages">
            {TAB_GROUPS.map((group) => (
              <span className="nav-cluster" role="group" aria-label={group.label} key={group.id}>
                {group.tabs.map((item) => (
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
              </span>
            ))}
          </nav>
          <span className="connection-pill"><span className="connection-dot" /> Ready for your next event</span>
        </div>
      </header>

      <main className={layout.contentClassName} id="main-content" tabIndex={-1}>
        {tab === 'buyer' ? (
          <BuyerCheckoutProvider eventId={activeEventId}>
            <BuyerTab
              eventId={activeEventId}
              eventTitle={DEFAULT_EVENT_TITLE}
              mediaBaseUrl={mediaBaseUrl()}
              onEventChange={selectEvent}
            />
          </BuyerCheckoutProvider>
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
        {tab === 'history' ? <BuildHistoryTab /> : null}
        {tab === 'test' ? <SystemTestsTab /> : null}
        {layout.showFooter ? (
          <footer className="footer">
            <span>SideStage preview</span>
            <AppDownloadButtons />
            <span>Built for the live-selling floor</span>
          </footer>
        ) : null}
      </main>
    </div>
  );
}

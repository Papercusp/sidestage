import { useCallback, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { TAB_GROUPS, tabHref, type TabId, useUrlTab } from './app-routing';
import { AppDownloadButtons } from './components/AppDownloadButtons';
import { BuildHistoryTab } from './BuildHistoryTab';
import { BuyerTab } from './BuyerTab';
import { BuyerCheckoutProvider } from './BuyerCheckout';
import { browserEventId, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import type { GuideEvent } from './events/api';
import { ChannelGuide } from './events/ChannelGuide';
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
export { eventWatchHref, getTabFromUrl, TAB_GROUPS, tabHref, TABS, type TabId } from './app-routing';
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

  /* P-118 / D-019: one live directory powers the site-wide guide. Keeping the
     query at this shell boundary means the drawer and its data remain mounted as
     the user moves among Watch, Orders, Studio, Releases, and Tests. */
  const guideQuery = useSyncQuery<GuideEvent>({
    queryName: 'events.guide',
    args: {},
    pollIntervalMs: 15_000,
  });
  const guideEvents = guideQuery.data ?? [];
  const guideError = guideQuery.error ? 'Could not load the event guide.' : null;

  const selectEvent = useCallback((nextEventId: string) => {
    setActiveEventId(nextEventId);
    if (typeof window === 'undefined') return;
    // From another page, first create the Watch history entry. Within Watch,
    // room switches replace the current entry so Back does not walk through a
    // stack of guide clicks. Either way the semantic row href stays copyable.
    if (tab !== 'buyer') navigate('buyer');
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'buyer');
    url.searchParams.set('event', nextEventId);
    window.history.replaceState({ tab: 'buyer', event: nextEventId }, '', url);
  }, [navigate, tab]);
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
        <ChannelGuide
          events={guideEvents}
          currentEventId={activeEventId}
          onSelect={selectEvent}
          loading={guideQuery.loading}
          error={guideError}
        />

        {tab === 'buyer' ? (
          <BuyerCheckoutProvider eventId={activeEventId}>
            <BuyerTab
              eventId={activeEventId}
              eventTitle={DEFAULT_EVENT_TITLE}
              mediaBaseUrl={mediaBaseUrl()}
              guideEvents={guideEvents}
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

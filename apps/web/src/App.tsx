import { useCallback, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { TAB_GROUPS, tabHref, type TabId, useUrlTab } from './app-routing';
import { ArchitectureTab } from './ArchitectureTab';
import { AppDownloadButtons } from './components/AppDownloadButtons';
import { DemoIdentityControl } from './BuyerIdentityControl';
import { BuildHistoryTab } from './BuildHistoryTab';
import { BuyerTab } from './BuyerTab';
import { BuyerCheckoutProvider, useBuyerCheckout } from './BuyerCheckout';
import { useDemoIdentity } from './buyer-identity';
import {
  DEFAULT_EVENT_TITLE,
  mediaBaseUrl,
  resolveActiveEventId,
  urlEventId,
} from './event-identity';
import type { GuideEvent } from './events/api';
import { ChannelGuide } from './events/ChannelGuide';
import { OrdersTab } from './OrdersTab';
import { SellerTab } from './SellerTab';
import {
  useSellerCatalog,
  variantsToTranscriptOptions,
  variantToSellerProduct,
} from './seller-products';
import { SystemTestsTab } from './SystemTestsTab';
import { TestTab } from './TestTab';

// Test-compat re-exports: the app shell remains the public face of these.
export { eventWatchHref, getTabFromUrl, TAB_GROUPS, tabHref, TABS, type TabId } from './app-routing';
export { variantsToTranscriptOptions, variantToSellerProduct, type CatalogProduct } from './seller-products';
export { SystemTestsTab } from './SystemTestsTab';
export { TestTab } from './TestTab';

export function appLayoutForTab(tab: TabId) {
  const isSeller = tab === 'seller';
  const isBuyerSurface = tab === 'buyer' || tab === 'orders';
  return {
    shellClassName: `app-shell${isSeller ? ' app-shell--seller' : ''}`,
    contentClassName: `content${isSeller ? ' content-seller' : ''}`,
    showFooter: !isSeller,
    showBuyerScout: isBuyerSurface,
  };
}

function TopbarHeldItemsButton() {
  const checkout = useBuyerCheckout();
  if (!checkout) return null;
  return (
    <button className="button secondary topbar-held-items" type="button" onClick={checkout.openHeldItems}>
      Held items <span aria-label={`${checkout.heldItemCount} held items`}>{checkout.heldItemCount}</span>
    </button>
  );
}

export function App() {
  const [tab, navigate] = useUrlTab();
  const { userId, impersonate } = useDemoIdentity();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  /* P-118 / D-019: the active event is app state, not a hard-pin. It seeds
     from ?event= so existing share links keep resolving, and the Channel Guide
     moves it. `null` means "the URL named no room and the buyer has not picked
     one" — an honest absence the guide resolves below, never a constant. */
  const [pinnedEventId, setPinnedEventId] = useState<string | null>(urlEventId);

  /* P-118 / D-019: one live directory powers the site-wide guide. Keeping the
     query at this shell boundary means the rail and its data remain mounted as
     the user moves among Watch, Orders, Studio, History, and Tests. */
  const guideQuery = useSyncQuery<GuideEvent>({
    queryName: 'events.guide',
    args: {},
    pollIntervalMs: 15_000,
  });
  const guideEvents = guideQuery.data ?? [];
  const guideError = guideQuery.error ? 'Could not load the event guide.' : null;

  /* D-001: with no ?event= in the URL, the landing room is the guide's FIRST
     row — literally the top of the sidebar the buyer is looking at, since both
     read this one already-ordered directory. */
  const activeEventId = resolveActiveEventId(pinnedEventId, guideEvents);

  const selectEvent = useCallback((nextEventId: string) => {
    setPinnedEventId(nextEventId);
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
    () => variantsToTranscriptOptions(sellerVariants),
    [sellerVariants],
  );
  const selectedProduct = sellerProducts.find((product) => product.id === selectedProductId) ?? null;
  const layout = appLayoutForTab(tab);

  return (
    <BuyerCheckoutProvider eventId={activeEventId} showScout={layout.showBuyerScout}>
      <div className={layout.shellClassName}>
      <ChannelGuide
        events={guideEvents}
        currentEventId={activeEventId}
        onSelect={selectEvent}
        loading={guideQuery.loading}
        error={guideError}
      />

      <div className="app-site-column">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <header className="topbar">
          <div className="topbar-inner">
            <div className="topbar-brand-group">
              <a className="wordmark" href={tabHref('buyer')} onClick={(event) => { event.preventDefault(); navigate('buyer'); }} aria-label="SideStage home">
                <span className="wordmark-mark" aria-hidden="true">S</span>
                <span className="wordmark-copy">
                  <strong>SideStage</strong>
                  <small>Live commerce</small>
                </span>
              </a>
              <div className="topbar-install-and-identity">
                <AppDownloadButtons />
                <div className="topbar-demo-user">
                  <DemoIdentityControl
                    userId={userId}
                    onImpersonate={impersonate}
                    inputId="global-demo-user-id"
                  />
                </div>
              </div>
            </div>
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
              <span className="nav-cluster project-links" role="group" aria-label="Project links">
                <a
                  className="nav-link"
                  href="https://github.com/Papercusp/sidestage"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="SideStage on GitHub (opens in a new tab)"
                >
                  GitHub <span aria-hidden="true">↗</span>
                </a>
              </span>
              <span className="nav-cluster papercusp-links" role="group" aria-label="Built by Papercusp">
                <a
                  className="papercusp-attribution"
                  href="https://papercusp.com/"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Built by Papercusp — Give your agents life (opens in a new tab)"
                >
                  <span className="papercusp-built-by" aria-hidden="true">Built by</span>
                  <img
                    className="papercusp-cup-mark"
                    src="/brand/papercusp-cup.svg"
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="papercusp-logo-lockup" aria-hidden="true">
                    <span className="papercusp-wordmark">
                      <span className="papercusp-paper">Paper</span>
                      <span className="papercusp-cusp">
                        C
                        <svg className="papercusp-cup-letter" viewBox="0 0 15 16">
                          <path d="M5.3 1.2q1.4 1.1 0 2.5" fill="none" stroke="#159e91" strokeWidth="1.25" strokeLinecap="round" />
                          <path d="M8.4.9q1.4 1.1 0 2.5" fill="none" stroke="#159e91" strokeWidth="1.25" strokeLinecap="round" />
                          <path d="M11.7 6.4Q15 6.9 15 8.8t-3.7 2.3" fill="none" stroke="#17324a" strokeWidth="1.7" strokeLinecap="round" />
                          <path d="M2.2 5h9.7l-.9 7.4q-.25 1.8-3.95 1.8t-3.95-1.8Z" fill="#17324a" />
                          <ellipse cx="7.05" cy="5.15" rx="4.55" ry="1.05" fill="#178db8" />
                        </svg>
                        sp
                      </span>
                    </span>
                    <span className="papercusp-tagline">Give your agents <strong>life.</strong></span>
                  </span>
                </a>
              </span>
            </nav>
            <div className="topbar-status-group">
              <TopbarHeldItemsButton />
            </div>
          </div>
        </header>

        <main className={layout.contentClassName} id="main-content" tabIndex={-1}>
          {tab === 'buyer' ? (
              <BuyerTab
                eventId={activeEventId}
                eventTitle={DEFAULT_EVENT_TITLE}
                mediaBaseUrl={mediaBaseUrl()}
                guideEvents={guideEvents}
              />
            ) : null}
            {tab === 'orders' ? <OrdersTab /> : null}
            {tab === 'seller' ? (
              <SellerTab
                selectedProduct={selectedProduct}
                selectedProductId={selectedProductId}
                sellerProducts={sellerProducts}
                transcriptProducts={transcriptProducts}
                onActiveProductChange={setSelectedProductId}
              />
            ) : null}
            {tab === 'history' ? <BuildHistoryTab /> : null}
            {tab === 'test' ? <SystemTestsTab /> : null}
            {tab === 'architecture' ? <ArchitectureTab /> : null}
          {layout.showFooter ? (
              <footer className="footer">
                <span>SideStage preview</span>
                <span>Built for the live-selling floor</span>
              </footer>
          ) : null}
        </main>
      </div>
      </div>
    </BuyerCheckoutProvider>
  );
}

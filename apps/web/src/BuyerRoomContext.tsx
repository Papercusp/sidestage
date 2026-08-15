import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { formatBuyerPrice, type BuyerProduct, type BuyerStats } from './buyer';

export type BuyerRoomTab = 'chat' | 'details' | 'seller';

export interface BuyerRoomSeller {
  id: string;
  name: string;
  status: 'live' | 'scheduled' | 'ended' | 'unknown';
}

export interface BuyerRoomContextProps {
  chat: ReactNode;
  currentProduct: BuyerProduct | null;
  eventTitle: string;
  productCount: number;
  seller: BuyerRoomSeller;
  stats: BuyerStats;
}

const TABS: readonly BuyerRoomTab[] = ['chat', 'details', 'seller'];

function displayAttribute(value?: string): string {
  if (!value) return 'Not specified';
  return value
    .toLocaleLowerCase()
    .replace(/(^|[_\s-])\p{L}/gu, (match) => match.toLocaleUpperCase());
}

function sellerInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join('') || 'SS';
}

export function BuyerRoomContext({
  chat,
  currentProduct,
  eventTitle,
  productCount,
  seller,
  stats,
}: BuyerRoomContextProps) {
  const [selectedTab, setSelectedTab] = useState<BuyerRoomTab>('chat');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setSelectedTab('chat');
  }, [seller.id]);

  const selectTab = (tab: BuyerRoomTab, focus = false) => {
    setSelectedTab(tab);
    if (focus) tabRefs.current[TABS.indexOf(tab)]?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(TABS[nextIndex], true);
  };

  const productVariant = currentProduct
    ? [currentProduct.size, currentProduct.color].filter(Boolean).join(' · ') || currentProduct.subtitle
    : 'Waiting for the seller';
  const sellerStatus = seller.status === 'unknown'
    ? 'Event host'
    : seller.status === 'live'
      ? 'Hosting live'
      : seller.status === 'scheduled'
        ? 'Event scheduled'
        : 'Event ended';

  return (
    <section className="buyer-room-context" aria-label="Room information">
      <div className="buyer-room-tablist" role="tablist" aria-label="Room information">
        {TABS.map((tab, index) => (
          <button
            key={tab}
            ref={(node) => { tabRefs.current[index] = node; }}
            id={`buyer-room-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={selectedTab === tab}
            aria-controls={`buyer-room-panel-${tab}`}
            tabIndex={selectedTab === tab ? 0 : -1}
            onClick={() => selectTab(tab)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {tab === 'chat' ? 'Chat' : tab === 'details' ? 'Details' : 'Seller'}
          </button>
        ))}
      </div>

      <div className="buyer-room-panels">
        <section
          id="buyer-room-panel-chat"
          className="buyer-room-panel buyer-room-chat"
          role="tabpanel"
          aria-labelledby="buyer-room-tab-chat"
          tabIndex={0}
          hidden={selectedTab !== 'chat'}
        >
          {chat}
        </section>

        <section
          id="buyer-room-panel-details"
          className="buyer-room-panel"
          role="tabpanel"
          aria-labelledby="buyer-room-tab-details"
          tabIndex={0}
          hidden={selectedTab !== 'details'}
        >
          <header className="buyer-room-panel-header">
            <div>
              <span>Current item</span>
              <h3>{currentProduct?.title ?? 'The next item is almost ready'}</h3>
            </div>
            <span>{currentProduct ? `${currentProduct.availableQty} available` : 'Waiting'}</span>
          </header>
          {currentProduct ? (
            <>
              <div className="buyer-room-detail-grid">
                <div><span>Condition</span><strong>{displayAttribute(currentProduct.condition)}</strong></div>
                <div><span>Variant</span><strong>{productVariant}</strong></div>
                <div><span>Brand</span><strong>{currentProduct.brand ?? 'Not specified'}</strong></div>
                <div>
                  <span>Fulfillment</span>
                  <strong>{currentProduct.handlingDays === undefined ? 'Shown at checkout' : `Ships in about ${currentProduct.handlingDays} ${currentProduct.handlingDays === 1 ? 'day' : 'days'}`}</strong>
                </div>
              </div>
              <p className="buyer-room-detail-story">{currentProduct.description ?? currentProduct.subtitle}</p>
              <div className="buyer-room-info-banner" role="note">
                <strong>Live-sale terms:</strong> bidding closes with the timer, and auction outcomes remain pending until the server confirms them. Current offer: {formatBuyerPrice(currentProduct.priceCents)}.
              </div>
            </>
          ) : (
            <p className="muted">Item details will appear when the seller brings a product on stage.</p>
          )}
        </section>

        <section
          id="buyer-room-panel-seller"
          className="buyer-room-panel"
          role="tabpanel"
          aria-labelledby="buyer-room-tab-seller"
          tabIndex={0}
          hidden={selectedTab !== 'seller'}
        >
          <header className="buyer-room-panel-header">
            <div><span>Who you’re buying from</span><h3>Meet the seller</h3></div>
            <span>{sellerStatus}</span>
          </header>
          <div className="buyer-room-seller-profile">
            <span aria-hidden="true">{sellerInitials(seller.name)}</span>
            <div><strong>{seller.name}</strong><p>@{seller.id} · SideStage event host</p></div>
          </div>
          <div className="buyer-room-seller-stats" aria-label="Seller room activity">
            <div><span>Room status</span><strong>{sellerStatus}</strong></div>
            <div><span>Watching</span><strong>{stats.viewers}</strong></div>
            <div><span>Event sales</span><strong>{stats.itemsSold}</strong></div>
          </div>
          <p className="buyer-room-seller-bio">Hosting {eventTitle} with {productCount} {productCount === 1 ? 'item' : 'items'} in this published event lineup.</p>
        </section>
      </div>
    </section>
  );
}

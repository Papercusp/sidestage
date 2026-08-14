import '@papercusp/scout-chat/styles.css';
import {
  ScoutChat,
  ScoutChatDrawer,
  createChatConversationCache,
  type ScoutChatStrings,
} from '@papercusp/scout-chat';
import type { BuyerProduct } from './buyer';
import { BuyerProductRail } from './BuyerProductRail';
import {
  createSideStageScoutTransport,
  scoutProductToBuyerProduct,
  type SideStageScoutPageContext,
} from './scout-transport';

const transport = createSideStageScoutTransport();
const conversation = createChatConversationCache();

export const SIDE_STAGE_SCOUT_STRINGS: ScoutChatStrings = {
  kicker: 'Ask Scout',
  title: 'Shopping assistant',
  tagline: 'Search the live catalog and continue shopping from this device.',
  inputPlaceholder: 'What are you looking for?',
  thinking: 'Scout is checking SideStage',
  newConversation: 'New',
  newConversationAria: 'Start a new Scout conversation',
  closeAria: 'Close Scout',
  closeWithCompanionAria: 'Close Scout and show held items',
  sendAria: 'Send message',
  emptyFallback: "Scout couldn't put together a response just now. Please try again.",
  errorPrefix: 'Scout could not continue: ',
  workingStatus: 'Checking SideStage…',
};

const TOOL_STATUS: Record<string, string> = {
  search_catalog: 'Searching the live catalog…',
  get_cart: 'Checking your held items…',
};

export function handleBuyerScoutAppEvent(
  event: Record<string, unknown>,
  openHeldItems: () => void,
): void {
  if (event.type === 'cart_mutate') openHeldItems();
  if (event.type === 'open_drawer' && (event.which === undefined || event.which === 'cart')) {
    openHeldItems();
  }
}

export interface BuyerScoutDrawerProps {
  eventId: string;
  cartId?: string;
  heldProductIds: readonly string[];
  onHoldProduct: (product: BuyerProduct) => void | Promise<void>;
  onOpenHeldItems: () => void;
}

export function BuyerScoutDrawer({
  eventId,
  cartId,
  heldProductIds,
  onHoldProduct,
  onOpenHeldItems,
}: BuyerScoutDrawerProps) {
  const pageContext: SideStageScoutPageContext = { eventId, ...(cartId ? { cartId } : {}) };
  const renderProducts = (products: unknown[]) => {
    const mapped = products
      .map(scoutProductToBuyerProduct)
      .filter((product): product is BuyerProduct => product !== null);
    return (
      <BuyerProductRail
        products={mapped}
        heldProductIds={heldProductIds}
        onHold={(product) => {
          if (heldProductIds.includes(product.id)) onOpenHeldItems();
          else void onHoldProduct(product);
        }}
      />
    );
  };

  return (
    <ScoutChatDrawer
      id="sidestage-scout"
      priority={10}
      width="var(--sc-drawer-width)"
      launcherAriaLabel="Open Scout shopping assistant"
      title="Scout shopping assistant"
      description="Search SideStage's live catalog and check held items."
      launcher={(
        <>
          <span aria-hidden="true">✦</span>
          <span>Ask Scout</span>
        </>
      )}
    >
      {({ close, otherOpen }) => (
        <ScoutChat
          transport={transport}
          cache={conversation}
          variant="drawer"
          onClose={close}
          companionOpen={otherOpen}
          getPageContext={() => pageContext}
          toolStatus={TOOL_STATUS}
          sessionStorageKey="sidestage-scout-session-id"
          strings={SIDE_STAGE_SCOUT_STRINGS}
          icon={<span aria-hidden="true">✦</span>}
          headerBadges={(
            <>
              <span>Live catalog</span>
              <span>Continues on this device</span>
            </>
          )}
          emptyState={(send) => (
            <>
              <strong>What are you shopping for?</strong>
              <p>Scout can search verified products and picks up where you left off on this device.</p>
              <button type="button" className="button secondary" onClick={() => send('Show me what is live now')}>
                Browse live products
              </button>
            </>
          )}
          renderProducts={renderProducts}
          onAppEvent={(event) => handleBuyerScoutAppEvent(event, onOpenHeldItems)}
        />
      )}
    </ScoutChatDrawer>
  );
}

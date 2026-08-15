import { useCallback, useState } from 'react';
import { useSyncMutate, useSyncPrincipal } from '@papercusp/sync';
import type { CatalogRow, EventItemDraft } from './event-creation/catalog';
import { EventCreationPanel } from './event-creation/EventCreationPanel';
import {
  onboardInventory,
  saveInventory,
  type InventoryOnboardMutation,
  type InventoryOnboardResult,
  type InventorySaveMutation,
  type InventorySaveResult,
} from './inventory-api';

export type InventoryMode = 'owned' | 'catalog';

export interface InventoryPanelProps {
  apiBaseUrl?: string;
  catalog?: readonly CatalogRow[];
  principal?: string;
  initialMode?: InventoryMode;
}

export function InventoryPanel({ apiBaseUrl, catalog, principal: principalProp, initialMode = 'owned' }: InventoryPanelProps) {
  const principal = useSyncPrincipal() ?? principalProp;
  const [mode, setMode] = useState<InventoryMode>(initialMode);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const fallback = useCallback(
    (input: InventorySaveMutation) => saveInventory(input, apiBaseUrl, principal ?? undefined),
    [apiBaseUrl, principal],
  );
  const mutateSave = useSyncMutate<InventorySaveMutation, InventorySaveResult>(
    'inventory.save',
    fallback,
  );
  const onboardFallback = useCallback(
    (input: InventoryOnboardMutation) => onboardInventory(input, apiBaseUrl, principal ?? undefined),
    [apiBaseUrl, principal],
  );
  const mutateOnboard = useSyncMutate<InventoryOnboardMutation, InventoryOnboardResult>(
    'inventory.onboard',
    onboardFallback,
  );

  const handleSave = async (drafts: readonly EventItemDraft[]) => {
    setConfirmation(null);
    await Promise.all(drafts.map((draft) => mode === 'owned'
      ? mutateSave({
        productId: draft.catalogId,
        quantity: draft.quantityLimit,
        priceCents: draft.eventPriceCents,
      })
      : mutateOnboard({
        sourceProductId: draft.catalogId,
        quantity: draft.quantityLimit,
        priceCents: draft.eventPriceCents,
      })));
    const quantity = drafts.reduce((sum, draft) => sum + draft.quantityLimit, 0);
    setConfirmation(mode === 'owned'
      ? `Saved ${quantity} total ${quantity === 1 ? 'unit' : 'units'} across ${drafts.length} ${drafts.length === 1 ? 'variant' : 'variants'}.`
      : `Added ${drafts.length} ${drafts.length === 1 ? 'listing' : 'listings'} with ${quantity} total ${quantity === 1 ? 'unit' : 'units'} to your inventory.`);
  };

  return (
    <div className="studio-inventory">
      <div className="inventory-mode-tabs" role="tablist" aria-label="Inventory source">
        <button type="button" role="tab" aria-selected={mode === 'owned'} onClick={() => { setMode('owned'); setConfirmation(null); }}>
          My inventory
        </button>
        <button type="button" role="tab" aria-selected={mode === 'catalog'} onClick={() => { setMode('catalog'); setConfirmation(null); }}>
          Add from catalog
        </button>
      </div>
      <EventCreationPanel
        key={mode}
        purpose="inventory"
        inventoryMode={mode === 'catalog' ? 'onboard' : 'edit'}
        catalogScope={mode === 'catalog' ? 'public' : 'seller'}
        catalog={catalog}
        title={mode === 'catalog' ? 'Add from catalog' : 'Edit inventory'}
        copy={mode === 'catalog'
          ? 'Choose public catalog variants, then set the stock and price for your new seller-owned listings. Source listings remain unchanged.'
          : 'Search your inventory, select one or more variants, then set total Qty and unit price. Active holds stay reserved, so Qty cannot be lower than Reserved.'}
        submitLabel={mode === 'catalog' ? 'Add to inventory' : 'Save inventory'}
        onSaveInventory={handleSave}
      />
      {confirmation ? <p className="inventory-confirmation" role="status">{confirmation}</p> : null}
    </div>
  );
}

export default InventoryPanel;

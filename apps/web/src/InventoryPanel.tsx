import { useCallback, useState } from 'react';
import { useSyncMutate, useSyncPrincipal } from '@papercusp/sync';
import type { CatalogRow, EventItemDraft } from './event-creation/catalog';
import { EventCreationPanel } from './event-creation/EventCreationPanel';
import { saveInventory, type InventorySaveMutation, type InventorySaveResult } from './inventory-api';

export interface InventoryPanelProps {
  apiBaseUrl?: string;
  catalog?: readonly CatalogRow[];
  principal?: string;
}

export function InventoryPanel({ apiBaseUrl, catalog, principal: principalProp }: InventoryPanelProps) {
  const principal = useSyncPrincipal() ?? principalProp;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const fallback = useCallback(
    (input: InventorySaveMutation) => saveInventory(input, apiBaseUrl, principal ?? undefined),
    [apiBaseUrl, principal],
  );
  const mutateSave = useSyncMutate<InventorySaveMutation, InventorySaveResult>(
    'inventory.save',
    fallback,
  );

  const handleSave = async (drafts: readonly EventItemDraft[]) => {
    setConfirmation(null);
    await Promise.all(drafts.map((draft) => mutateSave({
      productId: draft.catalogId,
      quantity: draft.quantityLimit,
      priceCents: draft.eventPriceCents,
    })));
    const quantity = drafts.reduce((sum, draft) => sum + draft.quantityLimit, 0);
    setConfirmation(`Saved ${quantity} total ${quantity === 1 ? 'unit' : 'units'} across ${drafts.length} ${drafts.length === 1 ? 'variant' : 'variants'}.`);
  };

  return (
    <div className="studio-inventory">
      <EventCreationPanel
        purpose="inventory"
        catalog={catalog}
        title="Edit inventory"
        copy="Search your catalog, select one or more variants, then set total Qty and unit price. Active holds stay reserved, so Qty cannot be lower than Reserved."
        submitLabel="Save inventory"
        onSaveInventory={handleSave}
      />
      {confirmation ? <p className="inventory-confirmation" role="status">{confirmation}</p> : null}
    </div>
  );
}

export default InventoryPanel;

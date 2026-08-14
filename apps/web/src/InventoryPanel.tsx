import { useCallback, useState } from 'react';
import { useSyncMutate } from '@papercusp/sync';
import type { CatalogRow, EventItemDraft } from './event-creation/catalog';
import { EventCreationPanel } from './event-creation/EventCreationPanel';
import { restockInventory, type InventoryRestockMutation, type InventoryRestockResult } from './inventory-api';

export interface InventoryPanelProps {
  apiBaseUrl?: string;
  catalog?: readonly CatalogRow[];
}

export function InventoryPanel({ apiBaseUrl, catalog }: InventoryPanelProps) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const fallback = useCallback(
    (input: InventoryRestockMutation) => restockInventory(input, apiBaseUrl),
    [apiBaseUrl],
  );
  const mutateRestock = useSyncMutate<InventoryRestockMutation, InventoryRestockResult>(
    'inventory.restock',
    fallback,
  );

  const handleRestock = async (drafts: readonly EventItemDraft[]) => {
    setConfirmation(null);
    await Promise.all(drafts.map((draft) => mutateRestock({
      productId: draft.catalogId,
      quantity: draft.quantityLimit,
      priceCents: draft.eventPriceCents,
    })));
    const quantity = drafts.reduce((sum, draft) => sum + draft.quantityLimit, 0);
    setConfirmation(`Added ${quantity} ${quantity === 1 ? 'unit' : 'units'} across ${drafts.length} ${drafts.length === 1 ? 'variant' : 'variants'}.`);
  };

  return (
    <div className="studio-inventory">
      <EventCreationPanel
        purpose="inventory"
        catalog={catalog}
        title="Add inventory"
        copy="Search your catalog, select one or more variants, then enter the quantity arriving and adjust the unit price when needed. Active holds stay reserved."
        submitLabel="Add to inventory"
        onRestock={handleRestock}
      />
      {confirmation ? <p className="inventory-confirmation" role="status">{confirmation}</p> : null}
    </div>
  );
}

export default InventoryPanel;

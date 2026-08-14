import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InventoryPanel } from './InventoryPanel';

describe('InventoryPanel', () => {
  it('reuses the catalog picker with intake-specific labels and sold-out stock available for selection', () => {
    const markup = renderToStaticMarkup(<InventoryPanel catalog={[{
      id: 'mug', groupId: 'cups', title: 'Studio mug', brand: 'Kiln', productType: 'HOME', sku: 'MUG-BLUE',
      color: 'Blue', condition: 'NEW', handlingDays: 1, priceCents: 1_200, reservedQty: 3, availableQty: 0,
    }]} />);

    expect(markup).toContain('Add inventory');
    expect(markup).toContain('Add to inventory');
    expect(markup).toContain('Unit price');
    expect(markup).toContain('Add qty');
    expect(markup).toContain('Reserved');
    expect(markup).toContain('aria-label="3 reserved"');
    expect(markup).toContain('0 on hand');
    expect(markup).not.toContain('Event name');
  });
});

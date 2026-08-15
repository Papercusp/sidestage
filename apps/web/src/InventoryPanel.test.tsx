import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InventoryPanel } from './InventoryPanel';

describe('InventoryPanel', () => {
  it('reuses the catalog picker with total-stock save semantics and a reservation floor', () => {
    const markup = renderToStaticMarkup(<InventoryPanel catalog={[{
      id: 'mug', groupId: 'cups', title: 'Studio mug', brand: 'Kiln', productType: 'HOME', sku: 'MUG-BLUE',
      color: 'Blue', condition: 'NEW', handlingDays: 1, priceCents: 1_200, qty: 3, reservedQty: 3, availableQty: 0,
    }]} />);

    expect(markup).toContain('Edit inventory');
    expect(markup).toContain('Save inventory');
    expect(markup).toContain('Unit price');
    expect(markup).toContain('>Qty<');
    expect(markup).toContain('value="3"');
    expect(markup).toContain('min="3"');
    expect(markup).toContain('Reserved');
    expect(markup).toContain('aria-label="3 reserved"');
    expect(markup).toContain('class="quantity-stock">0</span>');
    expect(markup).not.toContain('available now');
    expect(markup).not.toContain('Add qty');
    expect(markup).not.toContain('Event name');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEMO_CATALOG,
  clampQuantity,
  createEventPayload,
  draftFromCatalog,
  filterCatalog,
  formatPrice,
  parsePriceCents,
} from './catalog';

describe('event creation catalog helpers', () => {
  it('searches across product title, brand, type, sku, and colour', () => {
    expect(filterCatalog(DEMO_CATALOG, 'northstar', 'all', 'all')).toHaveLength(2);
    expect(filterCatalog(DEMO_CATALOG, 'BH-ESP-200-CRM', 'all', 'all')[0]?.color).toBe('Cream');
    // Colour is the variant axis, so a seller searching it must land on the one
    // colorway rather than on both rows of the product group (WI-38716).
    expect(filterCatalog(DEMO_CATALOG, 'walnut', 'all', 'all').map((row) => row.id))
      .toEqual(['demo-desk-walnut']);
    expect(filterCatalog(DEMO_CATALOG, 'camera', 'CAMERA', 'in-stock')).toHaveLength(2);
  });

  it('clamps event quantity to a positive available-stock limit', () => {
    expect(clampQuantity(0, 4)).toBe(1);
    expect(clampQuantity(99, 4)).toBe(4);
    expect(clampQuantity(-1, 4)).toBe(1);
    expect(clampQuantity(3.9, 4)).toBe(3);
    expect(clampQuantity(1, 0)).toBe(0);
  });

  it('parses currency without floating-point cents drift', () => {
    expect(parsePriceCents('499.99')).toBe(49999);
    expect(parsePriceCents('$12')).toBe(1200);
    expect(parsePriceCents('12.5')).toBe(1250);
    expect(parsePriceCents('12.345')).toBeNull();
    expect(formatPrice(109999)).toBe('$1099.99');
  });

  it('builds a trimmed event payload from selected item drafts', () => {
    const draft = draftFromCatalog(DEMO_CATALOG[0]);
    draft.eventPriceCents = 47500;
    draft.quantityLimit = 99;
    expect(createEventPayload('  Sunday drop  ', [draft])).toEqual({
      name: 'Sunday drop',
      items: [{
        catalogId: 'demo-espresso-matte-black',
        groupId: 'demo-espresso-machine',
        eventPriceCents: 47500,
        quantityLimit: 12,
      }],
    });
    expect(createEventPayload(' ', [draft])).toBeNull();
    expect(createEventPayload('Sunday drop', [])).toBeNull();
  });

  it('carries a thumbnail when one is picked and omits the key entirely when not', () => {
    const draft = draftFromCatalog(DEMO_CATALOG[0]);
    const url = 'data:image/png;base64,iVBORw0KGgo=';

    expect(createEventPayload('Sunday drop', [draft], `  ${url}  `)?.thumbnailUrl).toBe(url);

    // Absent is the ONLY no-thumbnail state — a blank string must not survive as
    // an "empty but present" second one, or the API's tri-state merge reads it
    // as an explicit clear and every renderer needs a second falsy check.
    for (const blank of [undefined, '', '   ']) {
      const payload = createEventPayload('Sunday drop', [draft], blank);
      expect(payload?.thumbnailUrl).toBeUndefined();
      expect(payload && 'thumbnailUrl' in payload).toBe(false);
    }
  });
});

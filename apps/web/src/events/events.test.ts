import { describe, expect, it } from 'vitest';
import {
  addCatalogItems,
  applyMarkdown,
  createEmptyEvent,
  eventItemFromCatalog,
  formatMarkdown,
  markdownPercent,
  updateEventItem,
} from './events';
import { DEMO_CATALOG } from '../event-creation/catalog';

/**
 * DEMO_EVENTS was removed from ./events; these cases build the same shape the
 * way the rest of the suite does, so they exercise the real construction path
 * rather than a fixture that can drift away from it.
 */
function demoEvent() {
  return addCatalogItems(
    createEmptyEvent('Studio sale', '2026-08-16T18:00:00.000Z'),
    DEMO_CATALOG,
    [DEMO_CATALOG[0].id],
  );
}

describe('seller event helpers', () => {
  it('maps a catalog row into an event item with the event identity', () => {
    const item = eventItemFromCatalog(DEMO_CATALOG[0], 'studio-sale');

    expect(item.id).toBe('studio-sale:demo-espresso-new');
    expect(item.basePriceCents).toBe(49999);
    expect(item.priceCents).toBe(49999);
    expect(item.quantity).toBe(1);
  });

  it('adds only available catalog items and skips existing event items', () => {
    const event = createEmptyEvent('Studio sale', '2026-08-16T18:00:00.000Z');
    const withFirst = addCatalogItems(event, DEMO_CATALOG, [DEMO_CATALOG[0].id]);
    const withDuplicate = addCatalogItems(withFirst, DEMO_CATALOG, [DEMO_CATALOG[0].id]);

    expect(withFirst.items).toHaveLength(1);
    expect(withDuplicate.items).toHaveLength(1);
  });

  it('updates price and quantity while enforcing event inventory bounds', () => {
    const event = demoEvent();
    const item = event.items[0];
    const result = updateEventItem(event, item.id, { priceCents: 1200, quantity: 2 });
    const invalid = updateEventItem(event, item.id, { quantity: item.availableQty + 1 });

    expect(result.error).toBeUndefined();
    expect(result.event.items[0]).toMatchObject({ priceCents: 1200, quantity: 2 });
    expect(invalid.error).toContain(`between 1 and ${item.availableQty}`);
    expect(invalid.event).toBe(event);
  });

  it('applies markdowns and rejects values above the event guardrail', () => {
    const event = demoEvent();
    const item = event.items[0];
    const result = applyMarkdown(event, item.id, 10);
    const invalid = applyMarkdown(event, item.id, event.maxMarkdownPercent + 1);

    expect(markdownPercent(item.basePriceCents, result.event.items[0].priceCents)).toBe(10);
    expect(formatMarkdown(item.basePriceCents, result.event.items[0].priceCents)).toBe('10.0%');
    expect(invalid.error).toContain(`${event.maxMarkdownPercent}% event limit`);
  });
});

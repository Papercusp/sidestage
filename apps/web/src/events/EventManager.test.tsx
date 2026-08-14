import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventManager } from './EventManager';
import type { SellerEventItem } from './api';

const ITEMS: SellerEventItem[] = [{
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:espresso',
  productId: 'espresso',
  title: 'Barista Pro Espresso Machine',
  priceCents: 47_500,
  availableQty: 12,
  quantity: 3,
  onStage: true,
  attributes: { brand: 'BrewHaus', sku: 'BH-ESP-200-NEW', basePriceCents: 49_999 },
}];

describe('EventManager', () => {
  it('renders the real guarded lineup through RichGrid', () => {
    const markup = renderToStaticMarkup(
      <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Sunday drop" initialItems={ITEMS} />,
    );

    expect(markup).toContain('Sunday drop');
    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('Push');
    expect(markup).toContain('Swap');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Stock');
    expect(markup).toContain('Auction quantity for Barista Pro Espresso Machine');
    expect(markup).toContain('Offer quantity for Barista Pro Espresso Machine');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(markup).toContain('Event queue');
    expect(markup).toContain('Manage lineup');
  });

  it('renders the reservation-backed setup picker for an empty event', () => {
    const markup = renderToStaticMarkup(
      <EventManager actorId="seller-27" eventId="new-event" eventName="New event" initialItems={[]} />,
    );

    expect(markup).toContain('Build the live lineup.');
    expect(markup).toContain('Create event');
    expect(markup).toContain('source-tracked event reservations');
  });
});

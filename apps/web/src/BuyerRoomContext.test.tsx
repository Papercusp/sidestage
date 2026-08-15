/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuyerProduct } from './buyer';
import { BuyerRoomContext } from './BuyerRoomContext';

const PRODUCT: BuyerProduct = {
  id: 'varsity-jacket',
  title: 'Varsity jacket',
  subtitle: 'Red · Medium',
  description: 'A lightly worn team jacket from the seller’s archive.',
  brand: 'SideStage Athletics',
  color: 'Red',
  size: 'M',
  condition: 'USED_GOOD',
  handlingDays: 2,
  priceCents: 8_800,
  availableQty: 2,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('BuyerRoomContext', () => {
  it('switches Chat, Details, and Seller with accessible tabs and real room data', async () => {
    const onViewItems = vi.fn();
    await act(async () => root.render(
      <BuyerRoomContext
        chat={<p>Room message</p>}
        currentProduct={PRODUCT}
        eventTitle="Friday varsity drop"
        productCount={4}
        seller={{ id: 'studio-27', name: 'Studio 27', status: 'live' }}
        stats={{ viewers: 42, itemsSold: 3, totalRaisedCents: 14_500 }}
        onViewItems={onViewItems}
      />,
    ));

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const [chatTab, detailsTab, sellerTab] = tabs;
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Chat', 'Details', 'Seller']);
    expect(chatTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#buyer-room-panel-chat')?.textContent).toContain('Room message');

    await act(async () => detailsTab?.click());
    expect(detailsTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#buyer-room-panel-details')?.textContent).toContain('SideStage Athletics');
    expect(container.querySelector('#buyer-room-panel-details')?.textContent).toContain('Ships in about 2 days');
    expect(container.querySelector('#buyer-room-panel-details')?.textContent).toContain('$88.00');

    await act(async () => {
      detailsTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(sellerTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sellerTab);
    expect(container.querySelector('#buyer-room-panel-seller')?.textContent).toContain('Studio 27');
    expect(container.querySelector('#buyer-room-panel-seller')?.textContent).toContain('42');

    const followButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Follow seller');
    await act(async () => followButton?.click());
    expect(followButton?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('You’re following Studio 27.');

    const itemsButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'View 4 event items');
    await act(async () => itemsButton?.click());
    expect(onViewItems).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing all 4 event items.');
  });
});

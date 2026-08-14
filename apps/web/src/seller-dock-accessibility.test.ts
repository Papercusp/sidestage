// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  observeSellerDockAccessibility,
  syncSellerDockAccessibility,
} from './seller-dock-accessibility';

function dockFixture(): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="dv-groupview">
      <div class="dv-tabs-and-actions-container">
        <div class="dv-tabs-container">
          <div class="dv-tab dv-active-tab" tabindex="0">
            <div class="dv-default-tab-content">Event manager</div>
          </div>
          <div class="dv-tab dv-inactive-tab" tabindex="0">
            <div class="dv-default-tab-content">Run of show</div>
          </div>
        </div>
      </div>
      <div class="dv-content-container" tabindex="-1"></div>
    </div>
  `;
  return root;
}

describe('syncSellerDockAccessibility', () => {
  it('connects Dockview tabs to their selected tab panel', () => {
    const root = dockFixture();
    syncSellerDockAccessibility(root, 'seller-event-manager');

    const tabList = root.querySelector<HTMLElement>('.dv-tabs-container')!;
    const tabs = root.querySelectorAll<HTMLElement>('.dv-tab');
    const panel = root.querySelector<HTMLElement>('.dv-content-container')!;

    expect(tabList.getAttribute('role')).toBe('tablist');
    expect(tabList.getAttribute('aria-label')).toBe('Dock panels');
    expect(tabs[0]!.getAttribute('role')).toBe('tab');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[0]!.getAttribute('aria-controls')).toBe(panel.id);
    expect(tabs[1]!.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
  });

  it('follows Dockview when the active tab changes', async () => {
    const root = dockFixture();
    const tabs = root.querySelectorAll<HTMLElement>('.dv-tab');
    const stopObserving = observeSellerDockAccessibility(root, 'seller-event-manager');

    tabs[0]!.classList.replace('dv-active-tab', 'dv-inactive-tab');
    tabs[1]!.classList.replace('dv-inactive-tab', 'dv-active-tab');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const panel = root.querySelector<HTMLElement>('.dv-content-container')!;
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1]!.id);
    stopObserving?.();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SIDE_STAGE_SCOUT_STRINGS,
  buyerScoutResources,
  handleBuyerScoutAppEvent,
} from './BuyerScoutDrawer';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

export function rendersBuyerRailDirectly(source: string): boolean {
  return /const renderProducts\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?return\s*\(\s*<BuyerProductRail\b/.test(source);
}

export function productRendererSpansEveryResultColumn(styles: string): boolean {
  const rule = styles.match(/\.sc-products\s*>\s*\.buyer-product-rail\s*\{([^}]*)\}/)?.[1] ?? '';
  return /grid-column\s*:\s*1\s*\/\s*-1\s*;/.test(rule)
    && /min-width\s*:\s*0\s*;/.test(rule);
}

describe('BuyerScoutDrawer contract', () => {
  it('describes device continuity without claiming private per-user memory', () => {
    const copy = JSON.stringify(SIDE_STAGE_SCOUT_STRINGS).toLowerCase();
    expect(copy).toContain('this device');
    expect(copy).not.toContain('private');
    expect(copy).not.toContain('only you');
  });

  it('opens the existing held-items drawer for cart app events only', () => {
    const openHeldItems = vi.fn();
    handleBuyerScoutAppEvent({ type: 'cart_mutate' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'open_drawer', which: 'cart' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'open_drawer', which: 'quote' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'token', content: 'hi' }, openHeldItems);
    expect(openHeldItems).toHaveBeenCalledTimes(2);
  });

  it('gives the existing BuyerProductRail the full Scout result width at every grid breakpoint', () => {
    const drawer = read('./BuyerScoutDrawer.tsx');
    const styles = read('./BuyerProductRail.css');

    expect(rendersBuyerRailDirectly(drawer)).toBe(true);
    expect(productRendererSpansEveryResultColumn(styles)).toBe(true);
  });

  it('restores only the matching buyer conversation across A → B → A switches', () => {
    const buyerA = buyerScoutResources('buyer-switch-a');
    const buyerB = buyerScoutResources('buyer-switch-b');
    buyerA.conversation.sessionId = 'session-a';
    buyerB.conversation.sessionId = 'session-b';

    expect(buyerScoutResources('buyer-switch-a').conversation).toBe(buyerA.conversation);
    expect(buyerScoutResources('buyer-switch-a').conversation.sessionId).toBe('session-a');
    expect(buyerB.conversation).not.toBe(buyerA.conversation);
    expect(buyerB.sessionStorageKey).not.toBe(buyerA.sessionStorageKey);
  });

  it('detects the original one-track regression', () => {
    expect(productRendererSpansEveryResultColumn(`
      .sc-products { display: grid; grid-template-columns: repeat(3, 1fr); }
    `)).toBe(false);
  });
});

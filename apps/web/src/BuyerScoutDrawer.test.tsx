import { describe, expect, it, vi } from 'vitest';
import { SIDE_STAGE_SCOUT_STRINGS, handleBuyerScoutAppEvent } from './BuyerScoutDrawer';

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
});

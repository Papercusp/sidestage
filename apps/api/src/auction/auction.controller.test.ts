import { describe, expect, it, vi } from 'vitest';
import { AuctionController } from './auction.controller';

function controllerWithCurrentAuction(current: unknown) {
  const auctions = {
    getCurrentAuction: vi.fn().mockResolvedValue(current),
  };
  const controller = new AuctionController(auctions as never, {} as never, {} as never, {} as never);
  const response = { json: vi.fn() };
  return { auctions, controller, response };
}

describe('AuctionController active auction response', () => {
  it('writes JSON null when the event has no auction', async () => {
    const { auctions, controller, response } = controllerWithCurrentAuction(null);

    await controller.active('event-without-auction', response);

    expect(auctions.getCurrentAuction).toHaveBeenCalledWith('event-without-auction');
    expect(response.json).toHaveBeenCalledOnce();
    expect(response.json).toHaveBeenCalledWith(null);
  });

  it('writes the authoritative auction snapshot unchanged', async () => {
    const auction = { id: 'auction-1', eventId: 'event-1', status: 'active' };
    const { controller, response } = controllerWithCurrentAuction(auction);

    await controller.active('event-1', response);

    expect(response.json).toHaveBeenCalledWith(auction);
  });

  it('authorizes seller cancellation against the auction event owner', async () => {
    const auction = { id: 'auction-1', eventId: 'event-1', status: 'closed', closeReason: 'seller-cancelled' };
    const auctions = {
      getAuction: vi.fn().mockResolvedValue({ ...auction, status: 'active' }),
      cancelAuction: vi.fn().mockResolvedValue(auction),
    };
    const access = {
      requireSellerPrincipal: vi.fn().mockReturnValue({ sellerId: 'seller-1' }),
      consumeRateLimit: vi.fn(),
    };
    const audit = { record: vi.fn(), reasonCode: vi.fn() };
    const ownership = { requireOwnedForSeller: vi.fn().mockResolvedValue(undefined) };
    const controller = new AuctionController(
      auctions as never,
      access as never,
      audit as never,
      ownership as never,
    );

    await expect(controller.cancel('auction-1', { 'x-sidestage-principal': 'seller-1' }, '127.0.0.1'))
      .resolves.toEqual(auction);
    expect(ownership.requireOwnedForSeller).toHaveBeenCalledWith('event-1', 'seller-1');
    expect(auctions.cancelAuction).toHaveBeenCalledWith('auction-1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auction.cancel',
      outcome: 'accepted',
      reasonCode: 'AUCTION_CANCELLED',
      auctionId: 'auction-1',
      eventId: 'event-1',
    }));
  });
});

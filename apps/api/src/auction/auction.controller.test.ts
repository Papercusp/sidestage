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
});

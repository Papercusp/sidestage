import { describe, expect, it } from 'vitest';
import { runAuctionRehearsal } from './auction-rehearsal';

describe('auction rehearsal', () => {
  it('reports every case as passing against the real auction service', async () => {
    const report = await runAuctionRehearsal();
    const failed = report.cases.filter((entry) => !entry.passed);
    expect(failed.map((entry) => `${entry.caseId}: ${entry.observed}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.kind).toBe('auction');
  });

  it('covers contention, settlement, stock and the clock', async () => {
    const report = await runAuctionRehearsal();
    expect(report.cases.map((entry) => entry.caseId)).toEqual([
      'start-holds-stock',
      'price-only-climbs',
      'under-bid-refused',
      'tie-bid-refused',
      'exactly-one-winner',
      'multi-unit-total',
      'bid-after-close-refused',
      'snipe-after-timer-refused',
      'unsold-releases-stock',
      'second-auction-refused',
      'auction-beyond-stock-refused',
    ]);
  });

  it('settles on the highest bidder and charges for every unit', async () => {
    const report = await runAuctionRehearsal();
    const winner = report.cases.find((entry) => entry.caseId === 'exactly-one-winner');
    expect(winner?.evidence).toMatchObject({ winner: 'dev', price: '$31.00', bidsPlaced: 4, status: 'closed' });
    const multi = report.cases.find((entry) => entry.caseId === 'multi-unit-total');
    expect(multi?.evidence).toMatchObject({ quantity: 2, unitPrice: '$25.00', total: '$50.00' });
  });

  it('holds stock for a live auction and gives it back when nobody bids', async () => {
    const report = await runAuctionRehearsal();
    expect(report.cases.find((entry) => entry.caseId === 'start-holds-stock')?.evidence)
      .toMatchObject({ reserved: 1, available: 2 });
    expect(report.cases.find((entry) => entry.caseId === 'unsold-releases-stock')?.evidence)
      .toMatchObject({ reserved: 0, available: 3 });
  });

  it('shows the price path rather than only the final number', async () => {
    const report = await runAuctionRehearsal();
    expect(report.cases.find((entry) => entry.caseId === 'price-only-climbs')?.observed)
      .toBe('Price moved $25.00 → $26.00 → $27.00.');
  });
}, 20_000);

import { describe, expect, it } from 'vitest';
import { runCheckoutRehearsal } from './checkout-rehearsal';

describe('checkout rehearsal', () => {
  it('reports every case as passing against the real cart, checkout and packer', async () => {
    const report = await runCheckoutRehearsal();
    const failed = report.cases.filter((entry) => !entry.passed);
    expect(failed.map((entry) => `${entry.caseId}: ${entry.observed}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.kind).toBe('checkout');
  });

  it('covers totals, idempotency, failure and packing', async () => {
    const report = await runCheckoutRehearsal();
    expect(report.cases.map((entry) => entry.caseId)).toEqual([
      'totals-add-up',
      'charge-matches-the-order',
      'no-duplicate-order',
      'no-double-charge',
      'declined-is-not-a-sale',
      'empty-cart-refused',
      'client-shipping-refused',
      'combined-shipping-one-box',
      'heavy-order-splits',
      'oversized-ships-alone',
    ]);
  });

  it('proves the money identity with real numbers', async () => {
    const report = await runCheckoutRehearsal();
    // 2 cups @ $28.00 + 1 plate @ $19.50 = $75.50, + $7.95 shipping = $83.45.
    expect(report.cases.find((entry) => entry.caseId === 'totals-add-up')?.evidence)
      .toMatchObject({ subtotal: '$75.50', shipping: '$7.95', total: '$83.45' });
    expect(report.cases.find((entry) => entry.caseId === 'charge-matches-the-order')?.evidence)
      .toMatchObject({ orderTotal: '$83.45', charged: '$83.45' });
  });

  it('proves a second confirm sends no second charge', async () => {
    const report = await runCheckoutRehearsal();
    expect(report.cases.find((entry) => entry.caseId === 'no-double-charge')?.evidence)
      .toMatchObject({ chargesSent: 1, finalStatus: 'paid' });
  });

  it('discloses that the payment provider was stood in for', async () => {
    // A green checkout rehearsal must not be readable as "Stripe is healthy".
    const report = await runCheckoutRehearsal();
    expect(report.caveats).toHaveLength(1);
    expect(report.caveats?.[0]).toContain('stand-in');
  });

  it('packs combined, heavy and oversized orders the way the UI claims', async () => {
    const report = await runCheckoutRehearsal();
    expect(report.cases.find((entry) => entry.caseId === 'combined-shipping-one-box')?.evidence)
      .toMatchObject({ parcels: 1, weightOz: 24 });
    const heavy = report.cases.find((entry) => entry.caseId === 'heavy-order-splits')?.evidence;
    expect(Number(heavy?.parcels)).toBeGreaterThan(1);
    expect(Number(heavy?.heaviest)).toBeLessThanOrEqual(800);
    expect(report.cases.find((entry) => entry.caseId === 'oversized-ships-alone')?.evidence)
      .toMatchObject({ parcels: 1, box: 'custom dimensions' });
  });
});

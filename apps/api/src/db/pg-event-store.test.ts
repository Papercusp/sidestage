import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgEventStore } from './pg-event-store';

describe('PgEventStore unpublish', () => {
  it('reads every status for only the requested seller', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await store.listBySeller('seller-probe');

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM event[\s\S]*seller_id = \$1[\s\S]*WHEN 'draft' THEN 2/),
      ['seller-probe'],
    );
  });

  it('drafts only the exact seller-owned event and preserves the row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ event_id: 'wi38795-probe' }] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await expect(store.unpublish('wi38795-probe', 'seller-probe')).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE event[\s\S]*status = 'draft'[\s\S]*event_id = \$1[\s\S]*seller_id = \$2[\s\S]*RETURNING event_id/),
      ['wi38795-probe', 'seller-probe'],
    );
  });

  it('reports a missing or differently owned row without inventing success', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await expect(store.unpublish('missing', 'seller-probe')).resolves.toBe(false);
  });

  it('publishes a withdrawn draft as scheduled without resetting live or ended rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await store.publish({
      eventId: 're-publish-me',
      title: 'Re-publish me',
      sellerId: 'seller-probe',
      sellerName: 'Probe seller',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/CASE[\s\S]*event\.status = 'draft'[\s\S]*THEN 'scheduled'[\s\S]*ELSE event\.status/),
      ['re-publish-me', 'Re-publish me', 'seller-probe', 'Probe seller', null],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    const conflictUpdate = sql.split('DO UPDATE')[1]?.split('WHERE event.seller_id')[0] ?? '';
    expect(conflictUpdate).not.toContain('seller_id');
    expect(sql).toContain('WHERE event.seller_id = EXCLUDED.seller_id');
  });

  it('reports a foreign id collision as false instead of transferring ownership', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await expect(store.publish({
      eventId: 'owned-by-alpha',
      title: 'Forged update',
      sellerId: 'seller-beta',
      sellerName: 'Beta',
    })).resolves.toBe(false);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE event.seller_id = EXCLUDED.seller_id'),
      ['owned-by-alpha', 'Forged update', 'seller-beta', 'Beta', null],
    );
  });

  it('owner-checks direct lookups in the database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool);

    await expect(store.findOwned('event-1', 'seller-alpha')).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE event_id = \$1[\s\S]*AND seller_id = \$2/),
      ['event-1', 'seller-alpha'],
    );
  });
});

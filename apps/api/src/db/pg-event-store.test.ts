import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgEventStore } from './pg-event-store';

describe('PgEventStore unpublish', () => {
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
  });
});

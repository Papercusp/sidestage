import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgScoutSessionStore } from './pg-scout-session-store';

const ROW = {
  id: 'session-a',
  buyer_id: 'buyer-a',
  messages: [{ role: 'user' as const, content: 'hi', ts: '2026-08-15T00:00:00.000Z' }],
  last_active_at: '2026-08-15T00:00:00.000Z',
};

describe('PgScoutSessionStore buyer ownership', () => {
  it('owner-scopes transcript reads in the database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [ROW] });
    const store = new PgScoutSessionStore({ query } as unknown as Pool);

    await expect(store.get('buyer-a', 'session-a')).resolves.toMatchObject({
      id: 'session-a',
      buyerId: 'buyer-a',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$1 AND buyer_id = \$2/),
      ['session-a', 'buyer-a'],
    );
  });

  it('writes the explicit owner and updates only when the existing owner matches', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [ROW] });
    const store = new PgScoutSessionStore({ query } as unknown as Pool);
    const messages = [{ role: 'user' as const, content: 'hi', ts: '2026-08-15T00:00:00.000Z' }];

    await store.append('buyer-a', 'session-a', messages);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO scout_session \(id, buyer_id, messages, last_active_at\)[\s\S]*WHERE scout_session\.buyer_id = EXCLUDED\.buyer_id/),
      ['session-a', 'buyer-a', JSON.stringify(messages)],
    );
  });

  it('reports an owner-conflict append like an absent session', async () => {
    const store = new PgScoutSessionStore({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);

    await expect(store.append('buyer-b', 'session-a', []))
      .rejects.toThrow('Scout session not found');
  });
});

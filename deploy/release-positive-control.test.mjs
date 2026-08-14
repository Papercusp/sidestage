import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { verifyReleasePositiveControl } from './release-positive-control.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploySource = readFileSync(path.join(here, 'deploy.sh'), 'utf8');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function realRows(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    id: `restart-product-${index + 1}`,
    title: index === 0 ? 'Studio Monitor Headphones' : `Real product ${index + 1}`,
    availableQty: index + 1,
  }));
}

describe('release catalog + Scout positive control', () => {
  it('passes only after six real in-stock rows and a catalog-derived Scout result', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ rows: realRows() }))
      .mockResolvedValueOnce(json({
        products: [{ productId: 'restart-product-1', title: 'Studio Monitor Headphones' }],
      }));

    await expect(verifyReleasePositiveControl({
      baseUrl: 'https://sidestage.example/',
      fetchImpl,
    })).resolves.toEqual({
      catalogRows: 6,
      scoutProducts: 1,
      query: 'Studio Monitor Headphones',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://sidestage.example/api/scout/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'Studio Monitor Headphones', maxProducts: 6 }),
      }),
    );
  });

  it('rejects a catalog with fewer than six in-stock rows', async () => {
    await expect(verifyReleasePositiveControl({
      fetchImpl: vi.fn().mockResolvedValue(json({ rows: realRows(5) })),
    })).rejects.toThrow('expected at least 6');
  });

  it('rejects curated demo rows even when the count is large enough', async () => {
    const rows = realRows();
    rows[2].id = 'event-demo-200-v1';
    await expect(verifyReleasePositiveControl({
      fetchImpl: vi.fn().mockResolvedValue(json({ rows })),
    })).rejects.toThrow('demo row(s): event-demo-200-v1');
  });

  it('rejects an empty Scout result after the catalog passes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ rows: realRows() }))
      .mockResolvedValueOnce(json({ products: [] }));
    await expect(verifyReleasePositiveControl({ fetchImpl }))
      .rejects.toThrow('Scout returned no verified products');
  });
});

describe('deploy wiring', () => {
  it('runs the positive control before recording the new sha', () => {
    const positiveControl = deploySource.indexOf('release-positive-control.mjs');
    const shaWrite = deploySource.indexOf('> $DEPLOYED_SHA_FILE');
    expect(positiveControl).toBeGreaterThan(-1);
    expect(shaWrite).toBeGreaterThan(positiveControl);
  });

  it('auto-rolls back a healthy release that fails the positive control', () => {
    expect(deploySource).toMatch(/if ! node "\$SCRIPT_DIR\/release-positive-control\.mjs"/);
    expect(deploySource).toMatch(/auto_rollback_failed_release "release positive control" 6/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuildHistorySyncQueries } from './build-history.module';
import { BuildHistoryService, loadBuildHistorySnapshot } from './build-history.service';

describe('BuildHistoryService', () => {
  it('serves the committed SideStage plan projection without a runtime Papercusp call', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const history = loadBuildHistorySnapshot();
    const popupPlan = history.find(({ slug }) => slug === 'sidestage-history-plan-popup-2026-08-14');

    expect(history.length).toBeGreaterThan(0);
    expect(history.every(({ slug }) => slug.startsWith('sidestage-'))).toBe(true);
    expect(popupPlan).toMatchObject({
      title: 'SideStage History tab and full Vditor plan popup',
      snapshot: {
        kind: 'papercusp-plan-export',
        workspace: 'papercusp-workspace',
        harness: 'sidestage',
        planPrefix: 'sidestage-',
        planCount: history.length,
        generator: 'scripts/generate-build-history-snapshot.mjs',
      },
    });
    expect(popupPlan?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(popupPlan?.markdown).toContain('# SideStage History tab and full Vditor plan popup');
    expect(popupPlan?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'P-002', storedStatus: 'todo', effectiveStatus: 'todo' }),
      expect.objectContaining({ id: 'P-003', storedStatus: 'todo', effectiveStatus: 'blocked', blockedBy: ['P-001', 'P-002'] }),
    ]));
    expect(popupPlan?.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'D-002', title: 'History popup is read-only and production-safe', itemRefs: ['P-002', 'P-003'] }),
    ]));
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('registers the committed aggregate on the shared sync query surface', async () => {
    const history = new BuildHistoryService();
    const queries = new SyncQueryRegistry();
    new BuildHistorySyncQueries(history, queries).onModuleInit();

    const rows = await queries.resolve('build.history', {});

    expect(rows).toEqual(loadBuildHistorySnapshot());
    expect(rows[0]).toHaveProperty('snapshot.generatedAt');
    expect(rows[0]).toHaveProperty('markdown');
    expect(rows[0]).toHaveProperty('items');
    expect(rows[0]).toHaveProperty('decisions');
  });
});

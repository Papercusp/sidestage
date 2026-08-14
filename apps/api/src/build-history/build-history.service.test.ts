import { describe, expect, it, vi } from 'vitest';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuildHistorySyncQueries } from './build-history.module';
import { fetchBuildHistory } from './build-history.service';

function toolResponse(data: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BuildHistoryService', () => {
  it('groups completed work items under SideStage plans through projected read tools', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/plans/list')) return toolResponse({ plans: [
        { slug: 'sidestage-checkout', title: 'SideStage checkout', status: 'active', updated: '2026-08-14T01:00:00Z' },
        { slug: 'operator-release', title: 'Operator release', status: 'active' },
      ] });
      if (url.pathname.endsWith('/plans/get')) return toolResponse({ results: [{ items: [
        { id: 'P-001', text: 'Ship checkout — note: ← WI-42 completed (done)', effectiveStatus: 'done' },
      ] }] });
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const history = await fetchBuildHistory({
      baseUrl: 'http://operator.test:3070', workspace: 'papercusp-workspace', harness: 'papercusp',
      planPrefix: 'sidestage-', fetchImpl,
    });

    expect(history).toEqual([expect.objectContaining({
      slug: 'sidestage-checkout',
      completedItems: [expect.objectContaining({ id: 'WI-42', title: 'Ship checkout', state: 'done' })],
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('role')).toBe('operator');
  });

  it('groups explicit plan links and retains the legacy sourcePlanSlug fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/plans/list')) return toolResponse({ plans: [
        { slug: 'sidestage-live-sync', title: 'SideStage live sync', status: 'active' },
        { slug: 'sidestage-checkout', title: 'SideStage checkout', status: 'ready' },
      ] });
      const body = JSON.parse(String(init?.body)) as { slug?: string };
      if (url.pathname.endsWith('/plans/get')) return toolResponse({ results: [{ items: body.slug === 'sidestage-live-sync'
        ? [{ text: 'Live sync — note: ← WI-14 completed (done)', effectiveStatus: 'done' }]
        : [] }] });
      return toolResponse([{
        id: 'WI-legacy', title: 'Legacy relation', state: 'done', sourcePlanSlug: 'sidestage-checkout',
      }]);
    });

    const history = await fetchBuildHistory({
      baseUrl: 'http://operator.test:3070', workspace: 'papercusp-workspace', harness: 'papercusp',
      planPrefix: 'sidestage-', fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(history.map(({ slug, completedItems }) => ({ slug, ids: completedItems.map(({ id }) => id) }))).toEqual([
      { slug: 'sidestage-live-sync', ids: ['WI-14'] },
      { slug: 'sidestage-checkout', ids: ['WI-legacy'] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('registers the aggregate on the shared sync query surface', async () => {
    const rows = [{ slug: 'sidestage-one', completedItems: [] }];
    const history = { list: vi.fn().mockResolvedValue(rows) };
    const queries = new SyncQueryRegistry();
    new BuildHistorySyncQueries(history as never, queries).onModuleInit();
    await expect(queries.resolve('build.history', {})).resolves.toEqual(rows);
  });
});

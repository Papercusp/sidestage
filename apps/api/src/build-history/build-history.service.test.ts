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
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/plans/list')) return toolResponse({ plans: [
        { slug: 'sidestage-checkout', title: 'SideStage checkout', status: 'active', updated: '2026-08-14T01:00:00Z' },
        { slug: 'operator-release', title: 'Operator release', status: 'active' },
      ] });
      return toolResponse([{
        id: 'WI-42', kind: 'feature', title: 'Ship checkout', state: 'done', updatedAt: '2026-08-14T02:00:00Z',
        terminalCompletionRef: 'Checkout verification passed.',
        terminalCompletionEvidence: { testsRun: 'npm test', testResult: 'passed' },
        completionAuthority: 'committed',
      }]);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const history = await fetchBuildHistory({
      baseUrl: 'http://operator.test:3070', workspace: 'papercusp-workspace', harness: 'papercusp',
      planPrefix: 'sidestage-', fetchImpl,
    });

    expect(history).toEqual([expect.objectContaining({
      slug: 'sidestage-checkout',
      completedItems: [expect.objectContaining({ id: 'WI-42', completionAuthority: 'committed' })],
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('role')).toBe('operator');
  });

  it('registers the aggregate on the shared sync query surface', async () => {
    const rows = [{ slug: 'sidestage-one', completedItems: [] }];
    const history = { list: vi.fn().mockResolvedValue(rows) };
    const queries = new SyncQueryRegistry();
    new BuildHistorySyncQueries(history as never, queries).onModuleInit();
    await expect(queries.resolve('build.history', {})).resolves.toEqual(rows);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuildHistoryTab,
  BuildHistoryList,
  filterBuildHistory,
  formatBuildDate,
  historyHref,
  summarizeBuildHistory,
  summarizeBuildItemEvidence,
  type BuildHistoryPlan,
} from './BuildHistoryTab';

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-08-14T12:00:00Z');
const HISTORY: BuildHistoryPlan[] = [{
  slug: 'sidestage-checkout',
  title: 'SideStage checkout',
  status: 'active',
  updatedAt: '2026-08-14T01:00:00Z',
  completedItems: [{
    id: 'WI-42',
    kind: 'feature',
    title: 'Ship checkout',
    state: 'done',
    completedAt: '2026-08-14T02:00:00Z',
    completionAuthority: 'committed',
    completionSummary: 'Checkout verification passed.',
    completionEvidence: {
      testsRun: 'npm test',
      testResult: 'passed',
      changedFiles: ['apps/web/src/BuyerCheckout.tsx', 'apps/web/src/orders.css'],
    },
  }],
}, {
  slug: 'sidestage-theme-r3',
  title: 'R3 Ticket theme',
  status: 'completed',
  updatedAt: '2026-07-01T01:00:00Z',
  completedItems: [],
}];

describe('BuildHistoryList', () => {
  it('shows the release digest while leaving plan work unmounted by default', () => {
    const markup = renderToStaticMarkup(<BuildHistoryList plans={HISTORY} now={NOW} />);
    expect(markup).toContain('Latest verified');
    expect(markup).toContain('Completed this week');
    expect(markup).toContain('SideStage checkout');
    expect(markup).toContain('1 completed item');
    expect(markup).not.toContain('Ship checkout</h3>');
    expect(markup).not.toContain('&quot;testsRun&quot;');
  });

  it('opens a deep-linked plan and item without mounting raw evidence', () => {
    const markup = renderToStaticMarkup(
      <BuildHistoryList
        plans={HISTORY}
        initialTarget={{ plan: 'sidestage-checkout', item: 'WI-42' }}
        now={NOW}
      />,
    );
    expect(markup).toContain('id="history-item-WI-42"');
    expect(markup).toContain('Ship checkout');
    expect(markup).toContain('Checkout verification passed.');
    expect(markup).toContain('Tests run: npm test');
    expect(markup).toContain('Changed files: apps/web/src/BuyerCheckout.tsx · apps/web/src/orders.css');
    expect(markup).toContain('View full evidence');
    expect(markup).not.toContain('&quot;testsRun&quot;');
  });
});

describe('BuildHistoryTab live query', () => {
  it('renders named-query data without a normal refresh or direct fetch path', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const useDataImpl = vi.fn().mockReturnValue({
      data: HISTORY,
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    });

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <BuildHistoryTab />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith({
      queryName: 'build.history',
      args: {},
      pollIntervalMs: 60_000,
      staleTime: 30_000,
    });
    expect(markup).toContain('SideStage checkout');
    expect(markup).toContain('View live site');
    expect(markup).not.toContain('Refresh history');
    expect(markup).not.toContain('Try again');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers retry only when the live query reports an error', () => {
    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{
        transport: 'SSE',
        prefetch: vi.fn(),
        useDataImpl: vi.fn().mockReturnValue({
          data: [],
          loading: false,
          fetching: false,
          transport: 'SSE',
          invalidate: vi.fn(),
          error: new Error('history sync unavailable'),
        }),
      } as never}>
        <BuildHistoryTab />
      </SyncContext.Provider>,
    );

    expect(markup).toContain('Build history is unavailable.');
    expect(markup).toContain('history sync unavailable');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Refresh history');
  });
});

describe('Build History data shaping', () => {
  it('derives metrics only from real plan and completion timestamps', () => {
    const summary = summarizeBuildHistory(HISTORY, NOW);
    expect(summary.latestVerified?.item.id).toBe('WI-42');
    expect(summary.completedThisWeek).toBe(1);
    expect(summary.activePlans).toBe(1);
    expect(summary.lastUpdatedAt).toBe('2026-08-14T02:00:00Z');
  });

  it('searches item evidence and combines status, date, and work-type filters', () => {
    const matches = filterBuildHistory(HISTORY, {
      search: 'buyercheckout',
      status: 'active',
      date: '7d',
      kind: 'feature',
    }, NOW);
    expect(matches.map((plan) => plan.slug)).toEqual(['sidestage-checkout']);
    expect(filterBuildHistory(HISTORY, {
      search: 'missing plan',
      status: 'all',
      date: 'all',
      kind: 'all',
    }, NOW)).toEqual([]);
  });

  it('curates verification and files without hiding the completion summary', () => {
    const summary = summarizeBuildItemEvidence(HISTORY[0].completedItems[0]);
    expect(summary.changed).toEqual(['Checkout verification passed.']);
    expect(summary.verification).toEqual(['Tests run: npm test', 'Test result: passed']);
    expect(summary.files).toEqual(['Changed files: apps/web/src/BuyerCheckout.tsx · apps/web/src/orders.css']);
  });

  it('builds stable plan and item links while preserving existing URL state', () => {
    expect(historyHref('sidestage-checkout', 'WI-42', '/?event=spring')).toBe(
      '/?event=spring&tab=history&plan=sidestage-checkout&item=WI-42#history-item-WI-42',
    );
  });

  it('handles missing or invalid ledger timestamps', () => {
    expect(formatBuildDate(null)).toBe('Date unavailable');
    expect(formatBuildDate('not-a-date')).toBe('Date unavailable');
  });
});

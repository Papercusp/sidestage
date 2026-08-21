import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext, useRestSyncQuery } from '@papercusp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `build.history` is an UNSYNCED query name — the Zero registry deliberately
// has no leaf for it — so this tab reads it through `useRestSyncQuery`, the
// REST/batch path on EVERY transport (WI-39772). That hook resolves its own
// client and never consults the SyncContext's `useDataImpl`, so stub the hook
// itself. Spread the real module so `SyncContext` stays real and a new export
// never silently vanishes from a hand-listed factory.
vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  useRestSyncQuery: vi.fn(),
}));

import {
  BuildHistoryTab,
  BuildHistoryList,
  filterBuildHistory,
  formatBuildDate,
  historyDocumentCloseHref,
  historyDocumentHref,
  historyHref,
  summarizeBuildHistory,
  summarizeBuildItemEvidence,
  type BuildHistoryPlan,
} from './BuildHistoryTab';

const historyCss = readFileSync(new URL('./build-history.css', import.meta.url), 'utf8');

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-08-14T12:00:00Z');
const SNAPSHOT = {
  kind: 'papercusp-plan-export' as const,
  workspace: 'papercusp-workspace',
  harness: 'sidestage',
  planPrefix: null,
  generatedAt: '2026-08-14T03:00:00Z',
  planCount: 2,
  generator: 'papercusp project-history generate',
};
const PROJECT = {
  id: 'sidestage',
  name: 'SideStage',
  repository: {
    provider: 'github' as const,
    url: 'git@github.com:Papercusp/sidestage.git',
    webUrl: 'https://github.com/Papercusp/sidestage',
    defaultBranch: 'main',
  },
};
const HISTORY: BuildHistoryPlan[] = [{
  slug: 'sidestage-checkout',
  title: 'SideStage checkout',
  status: 'active',
  updatedAt: '2026-08-14T01:00:00Z',
  contentHash: 'a'.repeat(64),
  markdown: '# SideStage checkout\n\n- **P-001** `done` Ship checkout',
  frontmatter: { title: 'SideStage checkout', status: 'active' },
  items: [{
    id: 'P-001',
    text: 'Ship checkout',
    storedStatus: 'done',
    effectiveStatus: 'done',
    importance: 'high',
    riskTier: null,
    authority: null,
    blockedBy: [],
    phase: 'Phase — Build',
    lineNumber: 3,
  }],
  decisions: [{
    id: 'D-001',
    title: 'Use the shared checkout',
    body: 'Reuse the existing checkout.',
    date: '2026-08-14',
    itemRefs: ['P-001'],
    lineNumber: 5,
  }],
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
    commits: [{
      sha: 'abc1234def5678',
      url: 'https://github.com/Papercusp/sidestage/commit/abc1234def5678',
      subject: 'feat: ship checkout',
      committedAt: '2026-08-14T02:05:00Z',
      files: ['apps/web/src/BuyerCheckout.tsx'],
      remoteStatus: 'confirmed',
      attribution: 'authoritative',
    }, {
      sha: 'def5678abc1234',
      url: 'https://github.com/Papercusp/sidestage/commit/def5678abc1234',
      subject: 'test: verify checkout',
      committedAt: '2026-08-14T02:04:00Z',
      files: ['apps/web/src/BuyerCheckout.test.tsx'],
      remoteStatus: 'local-only',
      attribution: 'body-reference',
    }],
  }],
  project: PROJECT,
  snapshot: SNAPSHOT,
}, {
  slug: 'sidestage-theme-r3',
  title: 'R3 Ticket theme',
  status: 'shipped',
  updatedAt: '2026-07-01T01:00:00Z',
  contentHash: 'b'.repeat(64),
  markdown: '# R3 Ticket theme',
  frontmatter: { title: 'R3 Ticket theme', status: 'completed' },
  items: [],
  decisions: [],
  completedItems: [],
  project: PROJECT,
  snapshot: SNAPSHOT,
}];

describe('BuildHistoryList', () => {
  it('shows the release digest while leaving plan work unmounted by default', () => {
    const markup = renderToStaticMarkup(<BuildHistoryList plans={HISTORY} now={NOW} />);
    expect(markup).toContain('Latest verified');
    expect(markup).toContain('1 completed this week');
    expect(markup).toContain('SideStage checkout');
    expect(markup).toContain('1 completed item');
    expect(markup).not.toContain('Ship checkout</h3>');
    expect(markup).not.toContain('&quot;testsRun&quot;');
  });

  it('headlines the whole archive, never a count that hides delivered plans', () => {
    // WI-39777. The headline plan metric used to be `activePlans` — NON-terminal
    // plans only — so every shipped plan was excluded from the one number a
    // reader treats as "how much was built". It shrank as the project succeeded
    // (28 shown against 51 real plans in production, owner-reported twice).
    // HISTORY fixture: 'sidestage-checkout' is active, 'sidestage-theme-r3' is
    // shipped — so a headline of 2 can only come from counting BOTH.
    const markup = renderToStaticMarkup(<BuildHistoryList plans={HISTORY} now={NOW} />);
    expect(markup).toContain('<span>Plans</span><strong>2</strong>');
    expect(markup).toContain('1 delivered · 1 in flight');

    // Control: the shipped plan must really be terminal, or "delivered" above
    // would read 1 for reasons unrelated to terminal-state classification.
    const shipped = HISTORY.filter((plan) => plan.status === 'shipped');
    expect(shipped).toHaveLength(1);
  });

  it('headlines total completed work, never the weekly count that resets to its smallest value', () => {
    // EI-20740522648735057. The "Completed work items" tile used to headline
    // `completedThisWeek` — a rolling count that resets every Monday and, on
    // the reported day, read 35 against a real archive of 320+ (an order of
    // magnitude gap). `completedThisWeek` alone can't distinguish "total" from
    // "this week" when every fixture item completed inside the same week, so
    // this fixture adds one completed item OUTSIDE the weekly window: the
    // headline must count both, and the "this week" detail must count only one.
    const plans: BuildHistoryPlan[] = [{
      ...HISTORY[0],
      completedItems: [
        HISTORY[0].completedItems[0],
        { ...HISTORY[0].completedItems[0], id: 'WI-10', completedAt: '2026-07-01T00:00:00Z' },
      ],
    }];
    const markup = renderToStaticMarkup(<BuildHistoryList plans={plans} now={NOW} />);
    expect(markup).toContain('<span>Completed work items</span><strong>2</strong>');
    expect(markup).toContain('1 completed this week');

    const summary = summarizeBuildHistory(plans, NOW);
    expect(summary.completedTotal).toBe(2);
    expect(summary.completedThisWeek).toBe(1);
  });

  it('opens on the full archive rather than a rolling date window', () => {
    // WI-39771. The Date filter used to default to '30d', so the page opened
    // already-filtered and read as the whole archive while hiding most of it
    // (62 plans rendered as 28 in production). 'R3 Ticket theme' last moved
    // 2026-07-01, 44 days before NOW, so it is only visible if the default
    // applies no date cutoff.
    const markup = renderToStaticMarkup(<BuildHistoryList plans={HISTORY} now={NOW} />);
    expect(markup).toContain('R3 Ticket theme');

    // Positive control: prove the fixture really does fall outside a 30-day
    // window. Without this, the assertion above would still pass if every
    // fixture were recent — i.e. it would be measuring nothing.
    const windowed = filterBuildHistory(
      HISTORY,
      { search: '', status: 'all', kind: 'all', date: '30d' },
      NOW,
    );
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.map((plan) => plan.slug)).not.toContain('sidestage-theme-r3');
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
    expect(markup).toContain('View commit ↗');
    expect(markup).toContain('Ledger attribution');
    expect(markup).toContain('Local only');
    expect(markup).toContain('href="https://github.com/Papercusp/sidestage/commit/abc1234def5678"');
    expect(markup).not.toContain('href="https://github.com/Papercusp/sidestage/commit/def5678abc1234"');
    expect(markup).toContain('View full evidence');
    expect(markup).not.toContain('&quot;testsRun&quot;');
  });

  it('keeps nested history grids inside a narrow site column', () => {
    expect(historyCss).toMatch(/\.build-history-page\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*min-width:\s*0;/s);
    expect(historyCss).toMatch(/\.build-plan-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*min-width:\s*0;/s);
  });
});

describe('BuildHistoryTab live query', () => {
  it('renders named-query data without a normal refresh or direct fetch path', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const restQuery = vi.mocked(useRestSyncQuery);
    restQuery.mockReturnValue({
      data: HISTORY,
      loading: false,
      fetching: false,
      transport: 'POLLING',
      invalidate: vi.fn(),
      error: null,
    } as never);

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', prefetch: vi.fn() } as never}>
        <BuildHistoryTab />
      </SyncContext.Provider>,
    );

    expect(restQuery).toHaveBeenCalledWith({
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
    vi.mocked(useRestSyncQuery).mockReturnValue({
      data: [],
      loading: false,
      fetching: false,
      transport: 'POLLING',
      invalidate: vi.fn(),
      error: new Error('history sync unavailable'),
    } as never);

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', prefetch: vi.fn() } as never}>
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
    expect(historyDocumentHref('sidestage-checkout', '/?event=spring&item=WI-old')).toBe(
      '/?event=spring&tab=history&plan=sidestage-checkout&document=sidestage-checkout#history-plan-sidestage-checkout',
    );
    expect(historyDocumentCloseHref(
      '/?event=spring&tab=history&plan=sidestage-checkout&document=sidestage-checkout#history-plan-sidestage-checkout',
    )).toBe('/?event=spring&tab=history&plan=sidestage-checkout#history-plan-sidestage-checkout');
  });

  it('handles missing or invalid ledger timestamps', () => {
    expect(formatBuildDate(null)).toBe('Date unavailable');
    expect(formatBuildDate('not-a-date')).toBe('Date unavailable');
  });
});

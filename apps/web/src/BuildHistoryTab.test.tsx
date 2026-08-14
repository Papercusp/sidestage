import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuildHistoryList, formatBuildDate, type BuildHistoryPlan } from './BuildHistoryTab';

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
    completionEvidence: { testsRun: 'npm test', testResult: 'passed' },
  }],
}];

describe('BuildHistoryList', () => {
  it('groups completed work and verification evidence under its source plan', () => {
    const markup = renderToStaticMarkup(<BuildHistoryList plans={HISTORY} />);
    expect(markup).toContain('SideStage checkout');
    expect(markup).toContain('1</strong><span>completed item');
    expect(markup).toContain('Ship checkout');
    expect(markup).toContain('Checkout verification passed.');
    expect(markup).toContain('tests Run: npm test');
    expect(markup).toContain('committed');
  });

  it('distinguishes an empty ledger from loading state', () => {
    const markup = renderToStaticMarkup(<BuildHistoryList plans={[]} />);
    expect(markup).toContain('No completed builds yet');
    expect(markup).not.toContain('Gathering completed work');
  });

  it('handles missing or invalid ledger timestamps', () => {
    expect(formatBuildDate(null)).toBe('Date unavailable');
    expect(formatBuildDate('not-a-date')).toBe('Date unavailable');
  });
});

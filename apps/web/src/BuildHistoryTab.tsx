import { useMemo } from 'react';
import { useRestSyncQuery } from '@papercusp/sync';
import {
  BuildHistoryList,
  type BuildHistoryPlan,
  type BuildHistoryTarget,
} from '@papercusp/ui-primitives';
import { TabHeader } from './components/TabHeader';
import './build-history.css';

export {
  BuildHistoryList,
  filterBuildHistory,
  formatBuildDate,
  historyDocumentCloseHref,
  historyDocumentHref,
  historyHref,
  historyWorkItemCloseHref,
  historyWorkItemHref,
  planCommits,
  summarizeBuildHistory,
  summarizeBuildItemEvidence,
  type BuildHistoryCommit,
  type BuildHistoryDateFilter,
  type BuildHistoryDecision,
  type BuildHistoryFilters,
  type BuildHistoryPlan,
  type BuildHistoryPlanItem,
  type BuildHistoryProject,
  type BuildHistoryRepository,
  type BuildHistorySnapshotSource,
  type BuildHistoryTarget,
  type BuildHistoryValidationAssertion,
  type BuildHistoryValidationStatus,
  type BuildHistoryValidationSummary,
  type BuildHistoryWorkItem,
} from '@papercusp/ui-primitives';

const LIVE_SITE_URL = 'https://sidestage.papercusp.com';

function readHistoryTarget(): BuildHistoryTarget | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const plan = url.searchParams.get('plan');
  return plan ? { plan, item: url.searchParams.get('item') } : null;
}

function readHistoryDocument(): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('document')?.trim() || null;
}

/** Deep links to one work-item record (`?work-item=`) must open on FIRST load, not
 *  only after a click — otherwise a shared permalink lands on the list (WI-38718). */
function readHistoryWorkItem(): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('work-item')?.trim() || null;
}

/** SideStage owns transport, page chrome, actions, and CSS—not History behavior. */
export function BuildHistoryTab() {
  const query = useRestSyncQuery<BuildHistoryPlan>({
    queryName: 'build.history',
    args: {},
    pollIntervalMs: 60_000,
    staleTime: 30_000,
  });
  const plans = query.data ?? [];
  const initialTarget = useMemo(readHistoryTarget, []);
  const initialDocument = useMemo(readHistoryDocument, []);
  const initialWorkItem = useMemo(readHistoryWorkItem, []);
  const now = useMemo(() => new Date(), [query.data]);

  return (
    <section className="tab-layout density-roomy build-history-page" aria-busy={query.loading}>
      <div className="build-history-hero">
        <TabHeader
          eyebrow="Verified delivery record"
          title="Build history"
          copy="Plans, completed work, commits, and the validation evidence that proves each change."
        />
        <div className="build-history-head-actions">
          <a className="button primary" href={LIVE_SITE_URL} target="_blank" rel="noreferrer">View live site</a>
        </div>
      </div>
      {query.error ? (
        <div className="build-history-error" role="alert">
          <strong>Build history is unavailable.</strong>
          <span>{query.error.message}</span>
          <button className="button small" type="button" onClick={query.invalidate}>Try again</button>
        </div>
      ) : query.loading ? (
        <p className="build-history-loading" role="status">Gathering completed work…</p>
      ) : (
        <BuildHistoryList
          plans={plans}
          initialTarget={initialTarget}
          initialDocument={initialDocument}
          initialWorkItem={initialWorkItem}
          now={now}
        />
      )}
    </section>
  );
}

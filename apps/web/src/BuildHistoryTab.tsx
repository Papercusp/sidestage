import { useSyncQuery } from '@papercusp/sync';
import { TabHeader } from './components/TabHeader';
import './build-history.css';

export interface BuildHistoryWorkItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  completedAt: string | null;
  completionAuthority: string | null;
  completionSummary: string | null;
  completionEvidence: Record<string, unknown> | null;
}

export interface BuildHistoryPlan {
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
  completedItems: BuildHistoryWorkItem[];
}

const buildDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatBuildDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : buildDateFormatter.format(date);
}

function evidenceLines(evidence: Record<string, unknown> | null): string[] {
  if (!evidence) return [];
  return Object.entries(evidence).flatMap(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
      return [`${label}: ${String(value)}`];
    }
    return [];
  }).slice(0, 3);
}

function BuildItem({ item }: { item: BuildHistoryWorkItem }) {
  const evidence = evidenceLines(item.completionEvidence);
  return (
    <li className="build-item">
      <article>
        <header className="build-item-heading">
          <div>
            <span className="build-item-kind">{item.kind}</span>
            <h3>{item.title}</h3>
          </div>
          <time dateTime={item.completedAt ?? undefined}>{formatBuildDate(item.completedAt)}</time>
        </header>
        <div className="build-item-meta">
          <code>{item.id}</code>
          <span className="build-item-state">{item.state}</span>
          {item.completionAuthority ? <span>{item.completionAuthority}</span> : null}
        </div>
        {item.completionSummary ? <p className="build-item-summary">{item.completionSummary}</p> : null}
        {evidence.length > 0 ? (
          <ul className="build-evidence" aria-label={`Completion evidence for ${item.id}`}>
            {evidence.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
      </article>
    </li>
  );
}

export function BuildHistoryList({ plans }: { plans: readonly BuildHistoryPlan[] }) {
  if (plans.length === 0) {
    return (
      <div className="build-history-empty">
        <span aria-hidden="true">◇</span>
        <h2>No completed builds yet</h2>
        <p>Completed SideStage work will appear here with its verification evidence.</p>
      </div>
    );
  }

  return (
    <div className="build-plan-list">
      {plans.map((plan) => (
        <section className="build-plan-card" aria-labelledby={`build-plan-${plan.slug}`} key={plan.slug}>
          <header className="build-plan-heading">
            <div>
              <span className="build-plan-status">{plan.status}</span>
              <h2 id={`build-plan-${plan.slug}`}>{plan.title}</h2>
              <code>{plan.slug}</code>
            </div>
            <div className="build-plan-count">
              <strong>{plan.completedItems.length}</strong>
              <span>{plan.completedItems.length === 1 ? 'completed item' : 'completed items'}</span>
              <time dateTime={plan.updatedAt ?? undefined}>Updated {formatBuildDate(plan.updatedAt)}</time>
            </div>
          </header>
          {plan.completedItems.length > 0 ? (
            <ol className="build-item-list">
              {plan.completedItems.map((item) => <BuildItem item={item} key={item.id} />)}
            </ol>
          ) : (
            <p className="build-plan-empty">This plan has no completed work items yet.</p>
          )}
        </section>
      ))}
    </div>
  );
}

export function BuildHistoryTab() {
  const query = useSyncQuery<BuildHistoryPlan>({
    queryName: 'build.history',
    args: {},
    pollIntervalMs: 60_000,
    staleTime: 30_000,
  });
  const plans = query.data ?? [];

  return (
    <section className="tab-layout density-roomy build-history-page" aria-busy={query.loading}>
      <div className="build-history-hero">
        <TabHeader
          eyebrow="Release ledger"
          title="Build history"
          copy="Every SideStage plan and the completed work behind it, grouped with the evidence that closed each item."
        />
        <button className="button secondary" type="button" onClick={query.invalidate} disabled={query.fetching}>
          {query.fetching ? 'Refreshing…' : 'Refresh history'}
        </button>
      </div>
      {query.error ? (
        <div className="build-history-error" role="alert">
          <strong>Build history is unavailable.</strong>
          <span>{query.error.message}</span>
        </div>
      ) : query.loading ? (
        <p className="build-history-loading" role="status">Gathering completed work…</p>
      ) : (
        <BuildHistoryList plans={plans} />
      )}
    </section>
  );
}

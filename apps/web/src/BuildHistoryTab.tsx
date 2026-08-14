import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
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

export type BuildHistoryDateFilter = '7d' | '30d' | 'all';

export interface BuildHistoryFilters {
  search: string;
  status: string;
  date: BuildHistoryDateFilter;
  kind: string;
}

export interface BuildHistoryTarget {
  plan: string;
  item: string | null;
}

interface EvidenceSummary {
  changed: string[];
  verification: string[];
  files: string[];
}

interface BuildHistorySummary {
  latestVerified: { item: BuildHistoryWorkItem; plan: BuildHistoryPlan } | null;
  completedThisWeek: number;
  activePlans: number;
  lastUpdatedAt: string | null;
}

const LIVE_SITE_URL = 'https://sidestage.buyrestart.com';
const PLAN_PAGE_SIZE = 12;
const ITEM_PAGE_SIZE = 12;
const TERMINAL_PLAN_STATES = new Set(['archived', 'cancelled', 'canceled', 'complete', 'completed', 'done', 'superseded']);
const buildDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatBuildDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : buildDateFormatter.format(date);
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function humanizeEvidenceKey(key: string): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .trim()
    .toLocaleLowerCase();
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : 'Evidence';
}

function evidenceValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((entry) => (
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
  ))) {
    return value.map(String).join(' · ');
  }
  return null;
}

function evidenceLines(evidence: Record<string, unknown> | null): Array<{ key: string; line: string }> {
  if (!evidence) return [];
  return Object.entries(evidence).flatMap(([key, value]) => {
    const readable = evidenceValue(value);
    return readable ? [{ key, line: `${humanizeEvidenceKey(key)}: ${readable}` }] : [];
  });
}

export function summarizeBuildItemEvidence(item: BuildHistoryWorkItem): EvidenceSummary {
  const lines = evidenceLines(item.completionEvidence);
  const files = lines
    .filter(({ key }) => /(artifact|file|output|path)/i.test(key))
    .map(({ line }) => line)
    .slice(0, 3);
  const verification = lines
    .filter(({ key }) => /(build|check|lint|proof|result|test|typecheck|valid|verif)/i.test(key))
    .map(({ line }) => line)
    .slice(0, 3);
  const categorized = new Set([...files, ...verification]);
  const changed = [
    item.completionSummary,
    ...lines.filter(({ line }) => !categorized.has(line)).map(({ line }) => line),
  ].filter((line): line is string => Boolean(line)).slice(0, 3);
  return { changed, verification, files };
}

function planActivityTimestamp(plan: BuildHistoryPlan): number {
  return Math.max(
    timestamp(plan.updatedAt) ?? Number.NEGATIVE_INFINITY,
    ...plan.completedItems.map((item) => timestamp(item.completedAt) ?? Number.NEGATIVE_INFINITY),
  );
}

function sortedItems(plan: BuildHistoryPlan): BuildHistoryWorkItem[] {
  return [...plan.completedItems].sort((left, right) => (
    (timestamp(right.completedAt) ?? 0) - (timestamp(left.completedAt) ?? 0)
  ));
}

function searchablePlanText(plan: BuildHistoryPlan): string {
  return [
    plan.slug,
    plan.title,
    plan.status,
    ...plan.completedItems.flatMap((item) => [
      item.id,
      item.kind,
      item.title,
      item.state,
      item.completionAuthority ?? '',
      item.completionSummary ?? '',
      ...evidenceLines(item.completionEvidence).map(({ line }) => line),
    ]),
  ].join(' ').toLocaleLowerCase();
}

export function filterBuildHistory(
  plans: readonly BuildHistoryPlan[],
  filters: BuildHistoryFilters,
  now = new Date(),
): BuildHistoryPlan[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const cutoff = filters.date === 'all'
    ? Number.NEGATIVE_INFINITY
    : now.getTime() - Number.parseInt(filters.date, 10) * 24 * 60 * 60 * 1_000;

  return plans
    .filter((plan) => !query || searchablePlanText(plan).includes(query))
    .filter((plan) => filters.status === 'all' || plan.status.toLocaleLowerCase() === filters.status)
    .filter((plan) => filters.kind === 'all' || plan.completedItems.some(
      (item) => item.kind.toLocaleLowerCase() === filters.kind,
    ))
    .filter((plan) => planActivityTimestamp(plan) >= cutoff)
    .sort((left, right) => planActivityTimestamp(right) - planActivityTimestamp(left));
}

export function summarizeBuildHistory(
  plans: readonly BuildHistoryPlan[],
  now = new Date(),
): BuildHistorySummary {
  const allItems = plans.flatMap((plan) => plan.completedItems.map((item) => ({ item, plan })));
  const verifiedItems = allItems
    .filter(({ item }) => Boolean(
      item.completionAuthority
      || (item.completionEvidence && Object.keys(item.completionEvidence).length > 0),
    ))
    .sort((left, right) => (
      (timestamp(right.item.completedAt) ?? 0) - (timestamp(left.item.completedAt) ?? 0)
    ));
  const startOfWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayFromMonday = (startOfWeek.getUTCDay() + 6) % 7;
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - dayFromMonday);

  const lastUpdatedAt = plans
    .flatMap((plan) => [plan.updatedAt, ...plan.completedItems.map((item) => item.completedAt)])
    .filter((value): value is string => timestamp(value) !== null)
    .sort((left, right) => (timestamp(right) ?? 0) - (timestamp(left) ?? 0))[0] ?? null;

  return {
    latestVerified: verifiedItems[0] ?? null,
    completedThisWeek: allItems.filter(({ item }) => (
      (timestamp(item.completedAt) ?? Number.NEGATIVE_INFINITY) >= startOfWeek.getTime()
    )).length,
    activePlans: plans.filter((plan) => !TERMINAL_PLAN_STATES.has(plan.status.toLocaleLowerCase())).length,
    lastUpdatedAt,
  };
}

function historyElementId(kind: 'plan' | 'item', value: string): string {
  return `history-${kind}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function historyHref(plan: string, item: string | null = null, currentUrl = '/'): string {
  const url = new URL(currentUrl, 'https://sidestage.local');
  url.searchParams.set('tab', 'history');
  url.searchParams.set('plan', plan);
  if (item) url.searchParams.set('item', item);
  else url.searchParams.delete('item');
  url.hash = historyElementId(item ? 'item' : 'plan', item ?? plan);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

function readHistoryTarget(): BuildHistoryTarget | null {
  if (typeof window === 'undefined') return null;
  const plan = new URL(window.location.href).searchParams.get('plan');
  if (!plan) return null;
  return { plan, item: new URL(window.location.href).searchParams.get('item') };
}

function CopyLinkButton({ href, label = 'Copy link' }: { href: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard) {
      setState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.href).href);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button className="button ghost small" type="button" onClick={copy}>
      {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

function EvidenceBlock({ title, lines, empty }: { title: string; lines: readonly string[]; empty: string }) {
  return (
    <section className="build-evidence-block">
      <h4>{title}</h4>
      {lines.length > 0 ? lines.map((line) => <p key={line}>{line}</p>) : <p className="build-evidence-empty">{empty}</p>}
    </section>
  );
}

function LazyRawEvidence({ item }: { item: BuildHistoryWorkItem }) {
  const [open, setOpen] = useState(false);
  if (!item.completionEvidence) return null;

  return (
    <details className="build-raw-evidence" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>View full evidence</summary>
      {open ? <pre>{JSON.stringify(item.completionEvidence, null, 2)}</pre> : null}
    </details>
  );
}

const BuildItem = memo(function BuildItem({
  item,
  planSlug,
}: {
  item: BuildHistoryWorkItem;
  planSlug: string;
}) {
  const summary = summarizeBuildItemEvidence(item);
  const href = historyHref(planSlug, item.id, typeof window === 'undefined' ? '/' : window.location.href);

  return (
    <li className="build-item" id={historyElementId('item', item.id)}>
      <article>
        <header className="build-item-heading">
          <div>
            <span className="build-item-kind">{item.kind}</span>
            <h3>{item.title}</h3>
          </div>
          <time dateTime={item.completedAt ?? undefined} title={formatBuildDate(item.completedAt)}>
            {formatBuildDate(item.completedAt)}
          </time>
        </header>
        <div className="build-item-meta">
          <code>{item.id}</code>
          <span className="build-item-state">{item.state}</span>
          {item.completionAuthority ? <span>{item.completionAuthority}</span> : null}
          <a href={href}>Permalink</a>
        </div>
        <div className="build-item-evidence-grid">
          <EvidenceBlock title="What changed" lines={summary.changed} empty="No completion summary was attached." />
          <EvidenceBlock title="Verification" lines={summary.verification} empty="No structured verification result was attached." />
          <EvidenceBlock title="Files" lines={summary.files} empty="No changed-file list was attached." />
        </div>
        <LazyRawEvidence item={item} />
      </article>
    </li>
  );
});

function BuildPlanDetails({ plan, targetItem }: { plan: BuildHistoryPlan; targetItem: string | null }) {
  const items = useMemo(() => sortedItems(plan), [plan]);
  const [showItems, setShowItems] = useState(Boolean(targetItem));
  const [itemLimit, setItemLimit] = useState(ITEM_PAGE_SIZE);
  const latest = items[0] ?? null;
  const summaries = items.map(summarizeBuildItemEvidence);
  const changed = latest?.completionSummary
    ? [latest.completionSummary]
    : [`${items.length} completed ${items.length === 1 ? 'work item is' : 'work items are'} recorded for this plan.`];
  const verification = summaries.flatMap((summary) => summary.verification).filter((line, index, all) => all.indexOf(line) === index).slice(0, 3);
  const files = summaries.flatMap((summary) => summary.files).filter((line, index, all) => all.indexOf(line) === index).slice(0, 3);
  const firstItems = items.slice(0, itemLimit);
  const targetedItem = targetItem ? items.find((item) => item.id === targetItem) : null;
  const visibleItems = targetedItem && !firstItems.includes(targetedItem)
    ? [...firstItems, targetedItem]
    : firstItems;
  const planHref = historyHref(plan.slug, null, typeof window === 'undefined' ? '/' : window.location.href);

  return (
    <div className="build-plan-body">
      <div className="build-plan-evidence-grid">
        <EvidenceBlock title="What changed" lines={changed} empty="No completed work is recorded." />
        <EvidenceBlock
          title="Verification"
          lines={verification}
          empty={latest?.completionAuthority ? `Completion authority: ${latest.completionAuthority}` : 'No structured verification result was attached.'}
        />
        <EvidenceBlock title="Files" lines={files} empty="No changed-file list was attached." />
      </div>
      <div className="build-plan-actions">
        <a className="button small" href={planHref}>Open plan link</a>
        <CopyLinkButton href={planHref} />
      </div>
      <details className="build-work-items-disclosure" open={showItems} onToggle={(event) => setShowItems(event.currentTarget.open)}>
        <summary>{showItems ? 'Hide' : 'View'} {items.length} {items.length === 1 ? 'work item' : 'work items'}</summary>
        {showItems ? (
          <>
            {items.length > 0 ? (
              <ol className="build-item-list">
                {visibleItems.map((item) => <BuildItem item={item} planSlug={plan.slug} key={item.id} />)}
              </ol>
            ) : <p className="build-plan-empty">This plan has no completed work items yet.</p>}
            {itemLimit < items.length ? (
              <button className="button ghost small build-show-more" type="button" onClick={() => setItemLimit((limit) => limit + ITEM_PAGE_SIZE)}>
                Show {Math.min(ITEM_PAGE_SIZE, items.length - itemLimit)} more work items
              </button>
            ) : null}
          </>
        ) : null}
      </details>
    </div>
  );
}

function BuildPlanCard({
  plan,
  open,
  targetItem,
  onToggle,
}: {
  plan: BuildHistoryPlan;
  open: boolean;
  targetItem: string | null;
  onToggle: (open: boolean) => void;
}) {
  const latest = sortedItems(plan)[0] ?? null;
  const outcome = latest?.completionSummary
    ?? `${plan.completedItems.length} completed ${plan.completedItems.length === 1 ? 'work item' : 'work items'} recorded.`;

  return (
    <details
      className="build-plan-card"
      id={historyElementId('plan', plan.slug)}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="build-plan-heading">
        <div className="build-plan-title">
          <div className="build-plan-meta-row">
            <span className="build-plan-status">{plan.status}</span>
            <span>{plan.completedItems.length} completed {plan.completedItems.length === 1 ? 'item' : 'items'}</span>
            <time dateTime={plan.updatedAt ?? undefined} title={formatBuildDate(plan.updatedAt)}>
              Updated {formatBuildDate(plan.updatedAt)}
            </time>
          </div>
          <h2>{plan.title}</h2>
          <p>{outcome}</p>
          <code>{plan.slug}</code>
        </div>
        <span className="build-plan-disclosure" aria-hidden="true">{open ? '−' : '+'}</span>
      </summary>
      {open ? <BuildPlanDetails plan={plan} targetItem={targetItem} /> : null}
    </details>
  );
}

function BuildHistoryMetrics({ plans, now }: { plans: readonly BuildHistoryPlan[]; now: Date }) {
  const summary = summarizeBuildHistory(plans, now);
  return (
    <>
      <section className="build-metric-grid" aria-label="Release summary">
        <div className="build-metric">
          <span>Latest verified</span>
          <strong>{summary.latestVerified?.item.title ?? 'None recorded'}</strong>
          <small>{summary.latestVerified ? `${summary.latestVerified.plan.title} · ${formatBuildDate(summary.latestVerified.item.completedAt)}` : 'Waiting for evidence-backed completion'}</small>
        </div>
        <div className="build-metric">
          <span>Completed this week</span>
          <strong>{summary.completedThisWeek}</strong>
          <small>Completed work-item records</small>
        </div>
        <div className="build-metric">
          <span>Active plans</span>
          <strong>{summary.activePlans}</strong>
          <small>Non-terminal plan records</small>
        </div>
        <div className="build-metric">
          <span>Last ledger update</span>
          <strong>{formatBuildDate(summary.lastUpdatedAt)}</strong>
          <small>Newest plan or completion timestamp</small>
        </div>
      </section>
      <div className={`build-verification-banner${summary.latestVerified ? '' : ' is-pending'}`}>
        <span className="build-verification-mark" aria-hidden="true">{summary.latestVerified ? '✓' : '◇'}</span>
        <div>
          <strong>{summary.latestVerified ? 'Verified delivery evidence is attached' : 'No verified delivery is recorded yet'}</strong>
          <p>{summary.latestVerified ? `${summary.latestVerified.item.id} is the newest completed item with evidence or completion authority.` : 'Completed work will appear here when its ledger entry includes evidence or completion authority.'}</p>
        </div>
        <span className="build-verification-status">{summary.latestVerified ? 'Ledger verified' : 'Pending'}</span>
      </div>
    </>
  );
}

export function BuildHistoryList({
  plans,
  initialTarget = null,
  now = new Date(),
}: {
  plans: readonly BuildHistoryPlan[];
  initialTarget?: BuildHistoryTarget | null;
  now?: Date;
}) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState('all');
  const [date, setDate] = useState<BuildHistoryDateFilter>('30d');
  const [kind, setKind] = useState('all');
  const [planLimit, setPlanLimit] = useState(PLAN_PAGE_SIZE);
  const [openPlans, setOpenPlans] = useState<Set<string>>(() => (
    initialTarget ? new Set([initialTarget.plan]) : new Set()
  ));

  const statuses = useMemo(() => [...new Set(plans.map((plan) => plan.status.toLocaleLowerCase()))].sort(), [plans]);
  const kinds = useMemo(() => [...new Set(plans.flatMap((plan) => plan.completedItems.map((item) => item.kind.toLocaleLowerCase())))].sort(), [plans]);
  const matchedPlans = useMemo(() => filterBuildHistory(plans, {
    search: deferredSearch,
    status,
    date,
    kind,
  }, now), [plans, deferredSearch, status, date, kind, now]);
  const matchedSlugs = new Set(matchedPlans.map((plan) => plan.slug));
  const retainedOpenPlans = plans.filter((plan) => openPlans.has(plan.slug) && !matchedSlugs.has(plan.slug));
  const pagedPlans = matchedPlans.slice(0, planLimit);
  const preservedOpenPlans = plans.filter((plan) => openPlans.has(plan.slug) && !pagedPlans.includes(plan));
  const displayedPlans = [...pagedPlans, ...preservedOpenPlans];

  useEffect(() => {
    if (!initialTarget || typeof document === 'undefined') return;
    const targetId = historyElementId(initialTarget.item ? 'item' : 'plan', initialTarget.item ?? initialTarget.plan);
    const frame = window.requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [initialTarget, plans.length]);

  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setDate('30d');
    setKind('all');
    setPlanLimit(PLAN_PAGE_SIZE);
  };

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
    <>
      <BuildHistoryMetrics plans={plans} now={now} />
      <section className="build-history-toolbar" aria-label="Release filters">
        <label className="build-history-search">
          <span className="skip-link">Search build history</span>
          <input
            className="text-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plan, work item, outcome, or file"
            aria-label="Search build history"
          />
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {statuses.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
        <label>
          <span>Date</span>
          <select value={date} onChange={(event) => setDate(event.target.value as BuildHistoryDateFilter)}>
            <option value="30d">Last 30 days</option>
            <option value="7d">Last 7 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <label>
          <span>Work type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All work types</option>
            {kinds.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
        </label>
      </section>

      <div className="build-history-results-heading">
        <div>
          <h2>Recently updated</h2>
          <p aria-live="polite">
            {matchedPlans.length} {matchedPlans.length === 1 ? 'plan matches' : 'plans match'}
            {retainedOpenPlans.length > 0 ? ` · ${retainedOpenPlans.length} open outside the filters` : ''}
          </p>
        </div>
        <button className="button ghost small" type="button" onClick={resetFilters}>Reset filters</button>
      </div>

      {displayedPlans.length > 0 ? (
        <div className="build-plan-list" aria-label="Build plans">
          {displayedPlans.map((plan) => (
            <BuildPlanCard
              plan={plan}
              open={openPlans.has(plan.slug)}
              targetItem={initialTarget?.plan === plan.slug ? initialTarget.item : null}
              onToggle={(open) => setOpenPlans((current) => {
                const next = new Set(current);
                if (open) next.add(plan.slug);
                else next.delete(plan.slug);
                return next;
              })}
              key={plan.slug}
            />
          ))}
          {planLimit < matchedPlans.length ? (
            <button className="button ghost build-show-more" type="button" onClick={() => setPlanLimit((limit) => limit + PLAN_PAGE_SIZE)}>
              Show {Math.min(PLAN_PAGE_SIZE, matchedPlans.length - planLimit)} more plans
            </button>
          ) : null}
        </div>
      ) : (
        <div className="build-history-empty">
          <span aria-hidden="true">⌕</span>
          <h2>No plans match these filters</h2>
          <p>Reset the filters or search for a different plan, work item, outcome, or file.</p>
        </div>
      )}
    </>
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
  const initialTarget = useMemo(readHistoryTarget, []);
  const now = useMemo(() => new Date(), [query.data]);

  return (
    <section className="tab-layout density-roomy build-history-page" aria-busy={query.loading}>
      <div className="build-history-hero">
        <TabHeader
          eyebrow="Verified delivery record"
          title="Build history"
          copy="A release digest first, raw work evidence second. Every result deep-links without expanding the archive by default."
        />
        <div className="build-history-head-actions">
          <button className="button secondary" type="button" onClick={query.invalidate} disabled={query.fetching}>
            {query.fetching ? 'Refreshing…' : 'Refresh history'}
          </button>
          <a className="button primary" href={LIVE_SITE_URL} target="_blank" rel="noreferrer">View live site</a>
        </div>
      </div>
      {query.error ? (
        <div className="build-history-error" role="alert">
          <strong>Build history is unavailable.</strong>
          <span>{query.error.message}</span>
          <button className="button small" type="button" onClick={query.invalidate}>Refresh history</button>
        </div>
      ) : query.loading ? (
        <p className="build-history-loading" role="status">Gathering completed work…</p>
      ) : (
        <BuildHistoryList plans={plans} initialTarget={initialTarget} now={now} />
      )}
    </section>
  );
}

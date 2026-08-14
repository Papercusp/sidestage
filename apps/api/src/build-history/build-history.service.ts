import { Injectable } from '@nestjs/common';

const DEFAULT_OPERATOR_URL = 'http://127.0.0.1:3070';
const DEFAULT_WORKSPACE = 'papercusp-workspace';
const DEFAULT_HARNESS = 'papercusp';
const DEFAULT_PLAN_PREFIX = 'sidestage-';
const MAX_ROWS = 500;

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

export interface BuildHistoryClientOptions {
  baseUrl: string;
  workspace: string;
  harness: string;
  planPrefix: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function options(overrides: Partial<BuildHistoryClientOptions>): BuildHistoryClientOptions {
  return {
    baseUrl: process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL,
    workspace: process.env.PAPERCUSP_OPERATOR_WORKSPACE ?? DEFAULT_WORKSPACE,
    harness: process.env.PAPERCUSP_OPERATOR_HARNESS ?? DEFAULT_HARNESS,
    planPrefix: process.env.PAPERCUSP_BUILD_HISTORY_PREFIX ?? DEFAULT_PLAN_PREFIX,
    timeoutMs: 8_000,
    fetchImpl: fetch,
    ...overrides,
  };
}

async function callTool(path: string, args: Record<string, unknown>, config: BuildHistoryClientOptions): Promise<unknown> {
  const url = new URL(`/api/agent-tools/${path}`, config.baseUrl);
  for (const [key, value] of Object.entries({
    workspace: config.workspace,
    harness: config.harness,
    role: 'operator',
    run: 'sidestage-build-history',
    spawn: 'sidestage-build-history',
    client: 'sidestage-site',
  })) url.searchParams.set(key, value);

  const response = await config.fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Papercusp ${path} read failed (${response.status})`);

  const envelope = await response.json() as {
    content?: Array<{ type?: unknown; text?: unknown }>;
    isError?: boolean;
  };
  const text = envelope.content?.find((entry) => entry.type === 'text')?.text;
  if (envelope.isError || typeof text !== 'string') {
    throw new Error(`Papercusp ${path} returned an invalid tool envelope`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Papercusp ${path} returned invalid JSON`);
  }
}

function plansFrom(payload: unknown, prefix: string): Array<Omit<BuildHistoryPlan, 'completedItems'>> {
  const rows = record(payload)?.plans;
  if (!Array.isArray(rows)) return [];
  const normalizedPrefix = prefix.trim().toLowerCase();
  return rows.flatMap((value) => {
    const row = record(value);
    const slug = optionalString(row?.slug);
    const title = optionalString(row?.title);
    if (!slug || !title) return [];
    const belongsToSideStage = normalizedPrefix
      ? slug.toLowerCase().startsWith(normalizedPrefix)
      : title.toLowerCase().includes('sidestage');
    return belongsToSideStage ? [{
      slug,
      title,
      status: optionalString(row?.status) ?? 'unknown',
      updatedAt: optionalString(row?.updated),
    }] : [];
  });
}

function itemsFrom(payload: unknown): BuildHistoryWorkItem[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    const row = record(value);
    const id = optionalString(row?.id);
    const title = optionalString(row?.title);
    return id && title ? [{
      id,
      kind: optionalString(row?.kind) ?? 'work-item',
      title,
      state: optionalString(row?.state) ?? 'done',
      completedAt: optionalString(row?.closedAt) ?? optionalString(row?.updatedAt),
      completionAuthority: optionalString(row?.completionAuthority),
      completionSummary: optionalString(row?.terminalCompletionRef),
      completionEvidence: record(row?.terminalCompletionEvidence),
    }] : [];
  });
}

function linkedItemsFromPlan(payload: unknown): BuildHistoryWorkItem[] {
  const results = record(payload)?.results;
  if (!Array.isArray(results)) return [];
  const itemsById = new Map<string, BuildHistoryWorkItem>();
  for (const result of results) {
    const items = record(result)?.items;
    if (!Array.isArray(items)) continue;
    for (const value of items) {
      const row = record(value);
      const text = optionalString(row?.text);
      const match = text?.match(/←\s+((?:WI|EI|F)-\d+)\s+completed\b/);
      if (!match?.[1] || !text) continue;
      const state = optionalString(row?.effectiveStatus) ?? optionalString(row?.storedStatus) ?? 'done';
      if (state !== 'done') continue;
      const noteStart = text.lastIndexOf('— note:');
      const title = (noteStart >= 0 ? text.slice(0, noteStart) : text).trim();
      itemsById.set(match[1], {
        id: match[1],
        kind: 'work-item',
        title,
        state,
        completedAt: null,
        completionAuthority: null,
        completionSummary: null,
        completionEvidence: null,
      });
    }
  }
  return [...itemsById.values()];
}

async function mapSixAtATime<T, R>(values: readonly T[], mapValue: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapValue(values[index]);
    }
  }));
  return results;
}

async function completedItemsForPlan(
  plan: Pick<BuildHistoryPlan, 'slug'>,
  config: BuildHistoryClientOptions,
): Promise<BuildHistoryWorkItem[]> {
  const planPayload = await callTool('plans/get', { harness: config.harness, slug: plan.slug }, config);
  const linkedItems = linkedItemsFromPlan(planPayload);
  if (linkedItems.length === 0) {
    // Older plans predate the explicit `← WI-N completed` item link and used
    // sourcePlanSlug directly. Keep that legacy path without making it the
    // only relation the workbench understands.
    return itemsFrom(await callTool('work_items/list', {
      harness: config.harness,
      sourcePlanSlug: plan.slug,
      state: ['done'],
      limit: MAX_ROWS,
      payloadTier: 'full',
    }, config));
  }
  // The plan index is the durable relationship authority and already carries
  // the item title, terminal state, and linked work-item id. Rendering it
  // directly avoids a second evidence-heavy read whose transport projection
  // can trim records or exceed this public query's eight-second budget.
  return linkedItems;
}

export async function fetchBuildHistory(overrides: Partial<BuildHistoryClientOptions> = {}): Promise<BuildHistoryPlan[]> {
  const config = options(overrides);
  const payload = await callTool('plans/list', {
    harness: config.harness, compact: true, limit: MAX_ROWS, order: 'updated', payloadTier: 'full',
  }, config);
  const plans = plansFrom(payload, config.planPrefix);
  return mapSixAtATime(plans, async (plan) => ({
    ...plan,
    completedItems: await completedItemsForPlan(plan, config),
  }));
}

@Injectable()
export class BuildHistoryService {
  list(): Promise<BuildHistoryPlan[]> {
    return fetchBuildHistory();
  }
}

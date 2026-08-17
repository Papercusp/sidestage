/**
 * The seller's run of show: planned product order, per-product time budgets,
 * and talking-point notes (plan sidestage-run-of-show-planner-2026-08-14).
 *
 * ADVISORY BY DESIGN (D-001): nothing in this module gates, blocks, or
 * auto-drives staging or commerce. The seller plans before the show; during
 * the show the plan is guidance they are free to ignore, and the math here is
 * built to stay honest when they do — off-plan products, skipped slots, and
 * revisits are all representable, none is an error.
 */

export interface RunOfShowEntry {
  productId: string;
  /** Planned seconds on stage; null = no budget set for this product. */
  plannedDurationSec: number | null;
  /** Seller talking points; empty string = no notes. */
  notes: string;
}

export interface RunOfShowPlan {
  eventId: string;
  /** Array order IS the planned show order (D-003). */
  entries: RunOfShowEntry[];
  updatedAt: string;
}

/*
 * No HTTP here by design (sync-contract.test.ts): reads go through
 * useSyncQuery('event.runOfShow'); the REST client lives in events/api.ts
 * (fetchRunOfShowPlan / saveRunOfShowPlan), the one budgeted transport module.
 * This module is pure types + logic so the math is testable without a network.
 */

/**
 * Has this event's plan NEVER been saved? (D-010)
 *
 * Lives here, once, because BOTH surfaces need it and the discriminator is
 * subtle enough that two copies would drift: emptiness alone is the wrong test.
 * A never-saved plan and a plan the seller deliberately emptied are both zero
 * entries, and only the timestamp separates them — the server's
 * `emptyRunOfShow()` fallback stamps the epoch (run-of-show.service.ts:76)
 * while every real save stamps `new Date()` (:105). Branching on emptiness
 * would resurrect products the seller removed on purpose.
 *
 * `undefined` means the query has not delivered a row yet, which is treated as
 * never-saved: the surfaces seed from the lineup and correct themselves when
 * the real plan arrives, rather than flashing an empty show.
 */
export function planNeverSaved(plan: RunOfShowPlan | undefined): boolean {
  const entries = plan?.entries ?? [];
  return entries.length === 0 && (plan === undefined || Date.parse(plan.updatedAt) === 0);
}

/**
 * The show order both surfaces render: the saved plan verbatim, or — when
 * nothing was ever saved — LINEUP ORDER, because direction C's premise is that
 * the lineup IS the run of show (D-010). A saved-but-empty plan stays empty.
 */
export function seededShowOrder(
  plan: RunOfShowPlan | undefined,
  lineupProductIds: readonly string[],
): string[] {
  return planNeverSaved(plan)
    ? [...lineupProductIds]
    : (plan?.entries ?? []).map((entry) => entry.productId);
}

/**
 * The seeded order as PLAN ENTRIES, for a surface that only reads the plan.
 * Seeded slots carry no budget and no notes — an unplanned show has no
 * expectations to pace against, and inventing one would make the pace line lie.
 */
export function seededEntries(
  plan: RunOfShowPlan | undefined,
  lineupProductIds: readonly string[],
): RunOfShowEntry[] {
  if (!planNeverSaved(plan)) return plan?.entries ?? [];
  return lineupProductIds.map((productId) => ({ productId, plannedDurationSec: null, notes: '' }));
}

/* ── Stage log: who has been on stage, for how long ───────────────────────── */

/**
 * Accumulated seconds per product plus the live segment. Kept as plain data so
 * every transition is a pure function the tests can drive without timers.
 */
export interface StageLog {
  /** Closed time per product, in seconds (revisits accumulate). */
  visitedSec: Record<string, number>;
  activeProductId: string | null;
  /** Epoch ms when the active product went on stage; null when idle. */
  activeSinceMs: number | null;
}

export function emptyStageLog(): StageLog {
  return { visitedSec: {}, activeProductId: null, activeSinceMs: null };
}

/** Close the running segment (if any) into visitedSec. */
function closeSegment(log: StageLog, nowMs: number): Record<string, number> {
  if (!log.activeProductId || log.activeSinceMs === null) return log.visitedSec;
  const spent = Math.max(0, Math.round((nowMs - log.activeSinceMs) / 1000));
  return {
    ...log.visitedSec,
    [log.activeProductId]: (log.visitedSec[log.activeProductId] ?? 0) + spent,
  };
}

/**
 * The one transition: the staged product changed (or cleared). A no-op when
 * the product is unchanged, so callers can feed it every render safely.
 */
export function stageLogOnProductChange(log: StageLog, productId: string | null, nowMs: number): StageLog {
  if (productId === log.activeProductId) return log;
  return {
    visitedSec: closeSegment(log, nowMs),
    activeProductId: productId,
    activeSinceMs: productId === null ? null : nowMs,
  };
}

/** Total seconds a product has held the stage, live segment included. */
export function secondsOnProduct(log: StageLog, productId: string, nowMs: number): number {
  const closed = log.visitedSec[productId] ?? 0;
  if (log.activeProductId === productId && log.activeSinceMs !== null) {
    return closed + Math.max(0, Math.round((nowMs - log.activeSinceMs) / 1000));
  }
  return closed;
}

/* ── View model: the plan joined with live reality ────────────────────────── */

export type SlotState = 'done' | 'active' | 'upcoming';

export interface RunOfShowSlotView {
  productId: string;
  title: string;
  /** 1-based planned position. */
  position: number;
  plannedDurationSec: number | null;
  notes: string;
  state: SlotState;
  /** Seconds this product has held the stage so far (live included). */
  spentSec: number;
  /** spentSec - budget when a budget exists and the slot has been touched. */
  overBudgetSec: number | null;
}

export interface RunOfShowView {
  slots: RunOfShowSlotView[];
  /** Total live-show time across planned and off-plan products. */
  totalElapsedSec: number;
  /** The planned slot currently on stage, if the staged product is planned. */
  activeSlot: RunOfShowSlotView | null;
  /** Staged product that is NOT in the plan — a detour, shown, never an error. */
  offPlanActive: { productId: string; title: string } | null;
  /** First un-visited, non-active planned slot, in plan order. */
  nextUp: RunOfShowSlotView | null;
  /** Σ (spent - budget) over touched budgeted slots; null with no budgets touched. */
  paceDeltaSec: number | null;
  /**
   * Σ budgets over every slot that HAS one, touched or not.
   *
   * `paceDeltaSec` deliberately says nothing until a budgeted slot has been on
   * stage, which before the show is EVERY budgeted slot — so it cannot answer
   * "did the seller set any budgets?", and a header that read the null as "no"
   * told a seller who had just typed minutes that there were none (WI-39722).
   * This is the plan-side total, so the pre-live header states the plan instead
   * of denying it, while pacing stays a live-only claim.
   */
  plannedTotalSec: number;
  /** Slots carrying a budget, so an all-zero plan is still "budgets exist". */
  budgetedCount: number;
  /** Planned slots not yet visited (active excluded). */
  remainingCount: number;
  /** Lineup products the plan does not mention, in lineup order. */
  unplanned: Array<{ productId: string; title: string }>;
}

export function buildRunOfShowView(input: {
  entries: readonly RunOfShowEntry[];
  /** productId -> display title (from the event lineup). */
  titles: Readonly<Record<string, string>>;
  log: StageLog;
  nowMs: number;
  /** Lineup ids in lineup order, for the unplanned list. */
  lineupProductIds?: readonly string[];
}): RunOfShowView {
  const { entries, titles, log, nowMs } = input;
  const active = log.activeProductId;

  const slots: RunOfShowSlotView[] = entries.map((entry, index) => {
    const spentSec = secondsOnProduct(log, entry.productId, nowMs);
    const visited = spentSec > 0 || (log.visitedSec[entry.productId] ?? 0) > 0;
    const state: SlotState = entry.productId === active ? 'active' : visited ? 'done' : 'upcoming';
    const overBudgetSec =
      entry.plannedDurationSec !== null && (state !== 'upcoming')
        ? spentSec - entry.plannedDurationSec
        : null;
    return {
      productId: entry.productId,
      title: titles[entry.productId] ?? entry.productId,
      position: index + 1,
      plannedDurationSec: entry.plannedDurationSec,
      notes: entry.notes,
      state,
      spentSec,
      overBudgetSec,
    };
  });

  const activeSlot = slots.find((slot) => slot.state === 'active') ?? null;
  const offPlanActive =
    active && !activeSlot
      ? { productId: active, title: titles[active] ?? active }
      : null;

  const nextUp = slots.find((slot) => slot.state === 'upcoming') ?? null;

  /**
   * Pace: closed slots contribute their full over/under; the ACTIVE slot
   * contributes only overage. Being one minute into a five-minute slot is not
   * "four minutes ahead" — under-time counts only once the seller moves on.
   */
  const touchedBudgeted = slots.filter((slot) => slot.overBudgetSec !== null);
  const paceDeltaSec = touchedBudgeted.length
    ? touchedBudgeted.reduce(
        (sum, slot) =>
          sum + (slot.state === 'active' ? Math.max(0, slot.overBudgetSec ?? 0) : (slot.overBudgetSec ?? 0)),
        0,
      )
    : null;

  const budgeted = slots.filter((slot) => slot.plannedDurationSec !== null);
  const plannedTotalSec = budgeted.reduce((sum, slot) => sum + (slot.plannedDurationSec ?? 0), 0);

  const remainingCount = slots.filter((slot) => slot.state === 'upcoming').length;

  const closedElapsedSec = Object.values(log.visitedSec).reduce((sum, seconds) => sum + seconds, 0);
  const liveElapsedSec = log.activeProductId && log.activeSinceMs !== null
    ? Math.max(0, Math.round((nowMs - log.activeSinceMs) / 1000))
    : 0;
  const totalElapsedSec = closedElapsedSec + liveElapsedSec;

  const planned = new Set(entries.map((entry) => entry.productId));
  const unplanned = (input.lineupProductIds ?? [])
    .filter((id) => !planned.has(id))
    .map((id) => ({ productId: id, title: titles[id] ?? id }));

  return {
    slots,
    totalElapsedSec,
    activeSlot,
    offPlanActive,
    nextUp,
    paceDeltaSec,
    plannedTotalSec,
    budgetedCount: budgeted.length,
    remainingCount,
    unplanned,
  };
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

/** 95 -> "1:35"; 3600 -> "1:00:00". */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The aggregate pacing line (D-001: pacing over alarms). Within a minute of
 * plan reads as on pace; otherwise whole minutes, direction named.
 *
 * With no pace yet (nothing budgeted has been on stage — which is the whole of
 * the pre-show, WI-39722) the line states the PLAN rather than denying it: a
 * seller who has just typed minutes was being told "No time budgets yet" by the
 * very screen they typed them into. That message is reserved for the case it
 * actually describes — a show with no budgets anywhere.
 */
export function formatPace(
  paceDeltaSec: number | null,
  remainingCount: number,
  plannedTotalSec = 0,
): string {
  const tail = `${remainingCount} to go`;
  if (paceDeltaSec === null) {
    return plannedTotalSec > 0
      ? `${formatClock(plannedTotalSec)} planned · ${tail}`
      : 'No time budgets yet';
  }
  if (Math.abs(paceDeltaSec) < 60) return `On pace · ${tail}`;
  const minutes = Math.round(Math.abs(paceDeltaSec) / 60);
  return paceDeltaSec > 0 ? `${minutes}m behind plan · ${tail}` : `${minutes}m ahead of plan · ${tail}`;
}

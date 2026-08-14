import { describe, expect, it } from 'vitest';
import {
  buildRunOfShowView,
  emptyStageLog,
  formatClock,
  formatPace,
  secondsOnProduct,
  stageLogOnProductChange,
  type RunOfShowEntry,
} from './run-of-show';

const T0 = 1_000_000_000_000;

function entries(): RunOfShowEntry[] {
  return [
    { productId: 'a', plannedDurationSec: 300, notes: 'open with the story' },
    { productId: 'b', plannedDurationSec: null, notes: '' },
    { productId: 'c', plannedDurationSec: 120, notes: 'close hard' },
  ];
}

const TITLES = { a: 'Aurora Cup', b: 'Beacon Mug', c: 'Comet Bowl' };

describe('stage log', () => {
  it('accumulates closed segments and reports the live one', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    expect(secondsOnProduct(log, 'a', T0 + 90_000)).toBe(90);
    log = stageLogOnProductChange(log, 'b', T0 + 90_000);
    log = stageLogOnProductChange(log, 'a', T0 + 100_000);
    // Revisit: 90s closed + 20s live.
    expect(secondsOnProduct(log, 'a', T0 + 120_000)).toBe(110);
    expect(secondsOnProduct(log, 'b', T0 + 120_000)).toBe(10);
  });

  it('is a no-op when the product is unchanged, and closes on null', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    expect(stageLogOnProductChange(log, 'a', T0 + 5_000)).toBe(log);
    log = stageLogOnProductChange(log, null, T0 + 60_000);
    expect(log.activeProductId).toBeNull();
    expect(secondsOnProduct(log, 'a', T0 + 999_000)).toBe(60);
  });
});

describe('buildRunOfShowView', () => {
  it('marks position, active slot, next-up, and remaining', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    const view = buildRunOfShowView({ entries: entries(), titles: TITLES, log, nowMs: T0 + 30_000 });
    expect(view.slots.map((slot) => slot.state)).toEqual(['active', 'upcoming', 'upcoming']);
    expect(view.activeSlot?.title).toBe('Aurora Cup');
    expect(view.activeSlot?.notes).toBe('open with the story');
    expect(view.nextUp?.productId).toBe('b');
    expect(view.remainingCount).toBe(2);
    expect(view.offPlanActive).toBeNull();
  });

  it('an off-plan product is a detour, never an error — plan resumes where left', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    log = stageLogOnProductChange(log, 'zz', T0 + 60_000);
    const view = buildRunOfShowView({ entries: entries(), titles: TITLES, log, nowMs: T0 + 90_000 });
    expect(view.offPlanActive).toEqual({ productId: 'zz', title: 'zz' });
    expect(view.activeSlot).toBeNull();
    expect(view.slots[0]!.state).toBe('done');
    expect(view.nextUp?.productId).toBe('b');
  });

  it('pace sums over/under across touched budgeted slots only', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    // a: 300s budget, spends 400s (=> +100). b: no budget (excluded). c untouched (excluded).
    log = stageLogOnProductChange(log, 'b', T0 + 400_000);
    const view = buildRunOfShowView({ entries: entries(), titles: TITLES, log, nowMs: T0 + 430_000 });
    expect(view.paceDeltaSec).toBe(100);
    // Nothing budgeted touched => null.
    const idle = buildRunOfShowView({ entries: entries(), titles: TITLES, log: emptyStageLog(), nowMs: T0 });
    expect(idle.paceDeltaSec).toBeNull();
  });

  it('an active slot under budget banks nothing; over budget it counts live', () => {
    let log = emptyStageLog();
    log = stageLogOnProductChange(log, 'a', T0);
    // 65s into a 300s budget: not "235s ahead" — pace stays flat.
    const early = buildRunOfShowView({ entries: entries(), titles: TITLES, log, nowMs: T0 + 65_000 });
    expect(early.paceDeltaSec).toBe(0);
    // 360s into the same 300s budget: 60s over, counted while still live.
    const late = buildRunOfShowView({ entries: entries(), titles: TITLES, log, nowMs: T0 + 360_000 });
    expect(late.paceDeltaSec).toBe(60);
  });

  it('lists lineup products missing from the plan, in lineup order', () => {
    const view = buildRunOfShowView({
      entries: entries(),
      titles: { ...TITLES, d: 'Drift Vase' },
      log: emptyStageLog(),
      nowMs: T0,
      lineupProductIds: ['c', 'd', 'a'],
    });
    expect(view.unplanned).toEqual([{ productId: 'd', title: 'Drift Vase' }]);
  });
});

describe('formatting', () => {
  it('formatClock', () => {
    expect(formatClock(95)).toBe('1:35');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(3_661)).toBe('1:01:01');
  });

  it('formatPace names the direction only past a minute', () => {
    expect(formatPace(null, 3)).toBe('No time budgets yet');
    expect(formatPace(30, 3)).toBe('On pace · 3 to go');
    expect(formatPace(-45, 2)).toBe('On pace · 2 to go');
    expect(formatPace(180, 4)).toBe('3m behind plan · 4 to go');
    expect(formatPace(-120, 1)).toBe('2m ahead of plan · 1 to go');
  });
});

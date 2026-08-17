/**
 * The one live-show clock (plan sidestage-lineup-run-of-show-2026-08-16, D-003/D-005).
 *
 * A `StageLog` is ACCUMULATED state, not a pure function of current props: it
 * remembers how long each product has held the stage across the whole show. So
 * a second one, created lower in the tree, does not agree with the first — it
 * starts at zero whenever its owner mounts. Two surfaces would then answer
 * "how far behind plan am I" differently, and an authoritative-looking wrong
 * number is worse than no number at all. Hence exactly one, held above every
 * consumer and read through this context.
 *
 * WHAT ADVANCES IT (D-005): the EVENT'S STAGED PRODUCT — server-authoritative
 * `item.onStage`, the flag the guarded push/swap actions actually mutate — and
 * NOT the seller's local `selectedProductId`. "Run of show" means the show, not
 * a selection. The Lineup timeline renders an "on stage" chip from the same
 * server flag, so any other source would let the chip and the clock disagree
 * about which product is live.
 *
 * Still advisory (run-of-show.ts D-001): this observes staging, it never drives
 * it. Off-plan products, skipped slots and revisits all stay representable.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { emptyStageLog, stageLogOnProductChange, type StageLog } from '../run-of-show';

/**
 * The log AND its render pulse, because D-003's "one clock" is two things that
 * must not be split: the accumulated `StageLog`, and the 1s tick that re-renders
 * pace against it. Each consuming surface used to own the tick — so two timers
 * fired on independent phases, and the same elapsed second could paint on the
 * Lineup up to a second before the dock. One timer here means both surfaces
 * re-render from the SAME instant, which is the property "one clock" promises.
 */
interface StageClock {
  log: StageLog;
  /** The instant both surfaces measure elapsed against — never per-surface. */
  nowMs: number;
}

const StageClockContext = createContext<StageClock | null>(null);

/**
 * The live show clock for `stagedProductId`.
 *
 * The staged id is passed IN rather than queried here so this module stays
 * free of transport (the same rule run-of-show.ts follows) and so the owner —
 * which already reads the event lineup — does not pay for a second query.
 */
export function StageClockProvider({
  stagedProductId,
  children,
}: {
  stagedProductId: string | null;
  children: ReactNode;
}) {
  const [log, setLog] = useState(emptyStageLog);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setLog((current) => stageLogOnProductChange(current, stagedProductId, Date.now()));
  }, [stagedProductId]);

  /*
   * The one 1s pulse, and only while something is on stage — the same
   * permanently-valid local-clock exception the panels used to hold
   * individually (sync-contract.test.ts). It reads NO server state: it only
   * re-renders the pace the shared log above already holds. Gating on
   * `log.activeProductId` rather than `stagedProductId` keeps the timer tied to
   * the value it advances, so an idle show costs no timer at all.
   */
  useEffect(() => {
    if (!log.activeProductId) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [log.activeProductId]);

  const clock = useMemo(() => ({ log, nowMs }), [log, nowMs]);

  return <StageClockContext.Provider value={clock}>{children}</StageClockContext.Provider>;
}

/**
 * Read the shared clock. Returns an empty log outside a provider so a panel
 * rendered on its own (tests, a detached mobile host) shows "no time yet"
 * rather than throwing — an absent clock is a legible state, not an error.
 */
export function useStageClock(): StageLog {
  const log = useContext(StageClockContext);
  const fallback = useMemo(emptyStageLog, []);
  return log ?? fallback;
}

/** True when a real provider is above this component. */
export function useHasStageClock(): boolean {
  return useContext(StageClockContext) !== null;
}

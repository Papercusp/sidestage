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

const StageClockContext = createContext<StageLog | null>(null);

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

  useEffect(() => {
    setLog((current) => stageLogOnProductChange(current, stagedProductId, Date.now()));
  }, [stagedProductId]);

  return <StageClockContext.Provider value={log}>{children}</StageClockContext.Provider>;
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

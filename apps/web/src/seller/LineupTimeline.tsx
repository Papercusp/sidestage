/**
 * The Lineup IS the run of show (plan sidestage-lineup-run-of-show-2026-08-16,
 * direction C, P-004).
 *
 * One ordered timeline: each planned slot carries its minutes budget, the notes
 * the seller wants on screen, its live pacing, and — behind a per-slot drawer —
 * the commerce controls that used to live in a separate grid. Products the plan
 * does not mention sit in a reserved tray below, one click from joining the show.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * 1. It computes NO pacing, elapsed, or slot math (D-002). Everything displayed
 *    comes from `buildRunOfShowView` and is rendered through `formatClock` /
 *    `formatPace`. That module's pacing rule is subtle on purpose — closed slots
 *    contribute their full over/under while the ACTIVE slot contributes only
 *    overage, because being one minute into a five-minute slot is not "four
 *    minutes ahead" — and any component re-deriving it gets it quietly wrong.
 *
 * 2. It holds NO clock of its own (D-003). A `StageLog` is accumulated state,
 *    so a second one created here would start at zero on mount and disagree with
 *    the Studio dock's. The caller passes the ONE shared view in. When no clock
 *    is available, `showPace` is false and every time column is omitted rather
 *    than rendered as zero — an absent clock is a legible state, a wrong number
 *    is not.
 *
 * 3. It gates nothing (run-of-show.ts D-001, restated by D-002). Going live
 *    never locks the seller to the plan: slots can be skipped, revisited, or
 *    ignored, an off-plan product on stage is shown as a detour rather than an
 *    error, and no control here is disabled because the plan says otherwise.
 *    The only things that disable a control are an explicit `disabled`, an
 *    in-flight action, and the guardrails the commerce controls enforce
 *    themselves.
 *
 * 4. It performs no transport. Like `run-of-show.ts` and `stage-clock.tsx` this
 *    stays a pure view over data handed to it, which is what lets it be tested
 *    with `renderToStaticMarkup` and keeps the queries/mutations in one place
 *    (P-005 wires it into `EventManager`).
 *
 * THE "ON STAGE" CHIP READS THE SERVER FLAG (D-005). SideStage has had two
 * notions of on-stage that could disagree: the dock's local `selectedProductId`
 * and the server-authoritative `item.onStage` that push/swap actually mutate.
 * This chip reads `item.onStage` — the same flag the Push button below it
 * mutates — so the chip and the action can never tell different stories. The
 * shared clock is driven off that same server flag, so `slot.state === 'active'`
 * agrees with the chip by construction; the row's pacing styling uses the slot
 * state, the chip uses the flag, and they are the same truth reached two ways.
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import type { SellerEventItem } from '../events/api';
import type { EventLineupGridProps } from '../events/EventLineupGrid';
import { formatClock, formatPace, type RunOfShowSlotView, type RunOfShowView } from '../run-of-show';
import { MarkdownControl } from './MarkdownControl';
import { BuyerPicker } from './BuyerPicker';
import './lineup-timeline.css';

/** The minutes range the run-of-show save accepts; mirrored here for an inline hint only. */
const MIN_SLOT_MINUTES = 1;
const MAX_SLOT_MINUTES = 240;

/**
 * Everything the seller can be mid-typing on one slot.
 *
 * One draft object with one change callback, rather than nine controlled props
 * per row: the owning surface keeps a plain `Record<productId, draft>` and the
 * timeline never has to know how that record is stored.
 */
export interface TimelineSlotDraft {
  /** Minutes as typed. '' means no budget, which is a valid plan. */
  minutes: string;
  notes: string;
  markdownPercent: string;
  offerBuyerId: string;
  offerQuantity: string;
  offerPriceCents: string;
  auctionQuantity: string;
  auctionStartPrice: string;
  stockQuantity: string;
}

export type TimelineDrafts = Readonly<Record<string, TimelineSlotDraft>>;

export function emptySlotDraft(): TimelineSlotDraft {
  return {
    minutes: '',
    notes: '',
    markdownPercent: '',
    offerBuyerId: '',
    offerQuantity: '1',
    offerPriceCents: '',
    auctionQuantity: '1',
    auctionStartPrice: '',
    stockQuantity: '',
  };
}

/**
 * The commerce half of the contract is INHERITED from the grid this replaces
 * rather than restated (`onPush`/`onSwap`/`onMarkdown`/`onStockAdjust`/
 * `onStartAuction`/`onSendOffer`, `policy`, `buyers`, `busyProductId`, …). Two
 * copies of the same callback list drift, and the drift shows up as a silently
 * unwired button; extending it means `EventManager` can hand the timeline the
 * props it already builds.
 */
export interface LineupTimelineViewProps extends EventLineupGridProps {
  /** Built by the caller from `buildRunOfShowView` — never recomputed here. */
  view: RunOfShowView;
  drafts: TimelineDrafts;
  /**
   * False ⇒ render no elapsed, no per-slot spend, and no pace line at all
   * (the D-003 fallback). The caller passes `useHasStageClock()`.
   */
  showPace: boolean;
  saveStatus: 'idle' | 'saving' | 'saved';
  saveError?: string | null;
  onDraftChange: (productId: string, patch: Partial<TimelineSlotDraft>) => void;
  /** Move a slot by one position; the keyboard path and the drag path share it. */
  onMove: (productId: string, delta: -1 | 1) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Drop a product from the PLAN. It stays in the lineup, in the reserved tray. */
  onRemoveFromShow: (productId: string) => void;
  onAddToShow: (productId: string) => void;
  onSave: () => void;
  /** Which slot's commerce drawer is open; null for none. Owned by the caller. */
  openProductId: string | null;
  onToggleDrawer: (productId: string) => void;
}

/** '' is a legal budget (no budget). Anything else must be a whole 1..240. */
function minutesLooksInvalid(minutes: string): boolean {
  const trimmed = minutes.trim();
  if (trimmed === '') return false;
  if (!/^\d+$/.test(trimmed)) return true;
  const value = Number(trimmed);
  return value < MIN_SLOT_MINUTES || value > MAX_SLOT_MINUTES;
}

function positiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Whole currency units as typed -> integer cents; null when unusable. */
function priceToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function stateLabel(slot: RunOfShowSlotView): string {
  return slot.state === 'done' ? 'Done' : slot.state === 'active' ? 'On now' : 'Upcoming';
}

/**
 * The over/under chip for one slot. Only ever shown for a slot that HAS a
 * budget and has been touched — `overBudgetSec` is null otherwise, and an
 * untouched slot has nothing honest to say about pace yet.
 */
function SlotBudgetChip({ slot }: { slot: RunOfShowSlotView }) {
  if (slot.overBudgetSec === null) return null;
  const over = slot.overBudgetSec;
  if (Math.abs(over) < 30) {
    return <span className="lineup-slot-chip is-onplan">on budget</span>;
  }
  const magnitude = formatClock(Math.abs(over));
  return over > 0
    ? <span className="lineup-slot-chip is-over">{magnitude} over</span>
    : <span className="lineup-slot-chip is-under">{magnitude} under</span>;
}

export function LineupTimelineView({
  view,
  drafts,
  showPace,
  saveStatus,
  saveError,
  items,
  busyProductId,
  auctionWritesEnabled = true,
  auctionWriteDisabledReason,
  policy,
  buyers,
  buyersLoading,
  blockedActionKinds,
  onDraftChange,
  onMove,
  onReorder,
  onRemoveFromShow,
  onAddToShow,
  onSave,
  openProductId,
  onToggleDrawer,
  onPush,
  onMarkdown,
  onStockAdjust,
  onStartAuction,
  onSendOffer,
}: LineupTimelineViewProps) {
  /** Purely transient pointer state; nothing outside this component needs it. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const itemsByProduct = new Map(items.map((item) => [item.productId, item]));
  const candidates = buyers ?? [];
  const offersBlocked = (blockedActionKinds ?? []).includes('targeted-offer');
  const busy = busyProductId ?? null;

  const handleDrop = (event: DragEvent<HTMLLIElement>, toIndex: number) => {
    event.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) onReorder(dragIndex, toIndex);
    setDragIndex(null);
  };

  const handleHandleKeys = (event: KeyboardEvent<HTMLButtonElement>, productId: string) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onMove(productId, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(productId, 1);
    }
  };

  return (
    <section className="lineup-timeline" aria-labelledby="lineup-timeline-title">
      <header className="lineup-timeline-header">
        <div className="lineup-timeline-heading">
          <h3 id="lineup-timeline-title">Run of show</h3>
          <p className="lineup-timeline-sub">
            The order you will actually present. Budget minutes, write the notes you want on screen,
            and run each product from its own slot.
          </p>
        </div>
        {/*
          The clock block is omitted wholesale without a shared clock (D-003), so
          the seller sees no time rather than a confident 0:00.
        */}
        {showPace ? (
          <div className="lineup-timeline-clock" aria-live="polite">
            <span className="lineup-timeline-elapsed">{formatClock(view.totalElapsedSec)}</span>
            <span className="lineup-timeline-pace">
              {formatPace(view.paceDeltaSec, view.remainingCount)}
            </span>
          </div>
        ) : (
          <div className="lineup-timeline-clock is-unavailable">
            <span className="lineup-timeline-pace">
              Show clock unavailable — pacing hidden
            </span>
          </div>
        )}
      </header>

      {/* A detour, shown as a fact and never as an error (D-002 advisory contract). */}
      {view.offPlanActive ? (
        <p className="lineup-timeline-offplan" aria-live="polite">
          <strong>{view.offPlanActive.title}</strong> is on stage and is not in the plan. That is
          fine — the plan is a guide, not a rail.
        </p>
      ) : null}

      {view.slots.length === 0 ? (
        <p className="lineup-timeline-empty">
          Nothing is in the show yet. Add products from the reserved tray below to build the order.
        </p>
      ) : (
        <ol className="lineup-timeline-slots">
          {view.slots.map((slot, index) => {
            const draft = drafts[slot.productId] ?? emptySlotDraft();
            const item = itemsByProduct.get(slot.productId);
            const drawerOpen = openProductId === slot.productId;
            const drawerId = `lineup-drawer-${slot.productId}`;
            const rowBusy = busy === slot.productId;
            const onStage = item?.onStage === true;
            const isNextUp = view.nextUp?.productId === slot.productId;

            return (
              <li
                key={slot.productId}
                className={`lineup-slot is-${slot.state}${onStage ? ' is-onstage' : ''}${
                  dragIndex === index ? ' is-dragging' : ''
                }`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, index)}
                onDragEnd={() => setDragIndex(null)}
                data-testid={`lineup-slot-${slot.productId}`}
              >
                <div className="lineup-slot-main">
                  <button
                    type="button"
                    className="lineup-slot-handle"
                    aria-label={`Reorder ${slot.title}. Use arrow up and arrow down to move it.`}
                    onKeyDown={(event) => handleHandleKeys(event, slot.productId)}
                  >
                    <span className="lineup-slot-position">{slot.position}</span>
                    <span aria-hidden="true" className="lineup-slot-grip">⋮⋮</span>
                  </button>

                  <div className="lineup-slot-identity">
                    <div className="lineup-slot-titlerow">
                      <span className="lineup-slot-title">{slot.title}</span>
                      {onStage ? <span className="lineup-slot-chip is-onstage">On stage</span> : null}
                      {isNextUp && !onStage ? (
                        <span className="lineup-slot-chip is-next">Next up</span>
                      ) : null}
                      <span className="lineup-slot-state">{stateLabel(slot)}</span>
                    </div>
                    {showPace ? (
                      <div className="lineup-slot-times">
                        <span className="lineup-slot-spent">{formatClock(slot.spentSec)} on stage</span>
                        <SlotBudgetChip slot={slot} />
                      </div>
                    ) : null}
                  </div>

                  <label className="lineup-slot-minutes">
                    <span>Minutes</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={draft.minutes}
                      placeholder="—"
                      aria-invalid={minutesLooksInvalid(draft.minutes) || undefined}
                      onChange={(event) => onDraftChange(slot.productId, { minutes: event.target.value })}
                    />
                  </label>

                  <div className="lineup-slot-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={rowBusy || !item || onStage}
                      onClick={() => item && onPush(item)}
                    >
                      {onStage ? 'On stage' : 'Take live'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-expanded={drawerOpen}
                      aria-controls={drawerId}
                      onClick={() => onToggleDrawer(slot.productId)}
                    >
                      {drawerOpen ? 'Hide controls' : 'Controls'}
                    </button>
                    <button
                      type="button"
                      className="button tertiary"
                      onClick={() => onRemoveFromShow(slot.productId)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <label className="lineup-slot-notes">
                  <span>On-screen notes</span>
                  <input
                    type="text"
                    value={draft.notes}
                    placeholder="What you want on screen for this slot"
                    onChange={(event) => onDraftChange(slot.productId, { notes: event.target.value })}
                  />
                </label>

                {/*
                  The drawer is only MOUNTED when open. `<details>`-style
                  always-render-then-hide keeps every row's controls in the tree,
                  which is the documented performance anti-pattern here.
                */}
                {drawerOpen && item ? (
                  <div className="lineup-slot-drawer" id={drawerId}>
                    <MarkdownControl
                      productId={item.productId}
                      title={item.title}
                      currentPriceCents={item.priceCents}
                      policy={policy}
                      percent={draft.markdownPercent}
                      onPercentChange={(next) => onDraftChange(item.productId, { markdownPercent: next })}
                      onApply={(percent, priceCents) => onMarkdown(item, percent, priceCents)}
                      disabled={rowBusy}
                    />

                    <div className="lineup-drawer-row">
                      <label className="lineup-drawer-field">
                        <span>Live quantity</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={draft.stockQuantity}
                          placeholder={String(item.quantity)}
                          onChange={(event) =>
                            onDraftChange(item.productId, { stockQuantity: event.target.value })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="button"
                        disabled={rowBusy || draft.stockQuantity.trim() === ''}
                        onClick={() => onStockAdjust(item, positiveInt(draft.stockQuantity, item.quantity))}
                      >
                        Set quantity
                      </button>
                      <span className="lineup-drawer-note">
                        {item.availableQty} verified in inventory
                      </span>
                    </div>

                    <div className="lineup-drawer-row">
                      <label className="lineup-drawer-field">
                        <span>Auction qty</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={draft.auctionQuantity}
                          onChange={(event) =>
                            onDraftChange(item.productId, { auctionQuantity: event.target.value })
                          }
                        />
                      </label>
                      <label className="lineup-drawer-field">
                        <span>Start price</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={draft.auctionStartPrice}
                          placeholder="0.00"
                          onChange={(event) =>
                            onDraftChange(item.productId, { auctionStartPrice: event.target.value })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="button"
                        disabled={
                          rowBusy || !auctionWritesEnabled || priceToCents(draft.auctionStartPrice) === null
                        }
                        onClick={() => {
                          const cents = priceToCents(draft.auctionStartPrice);
                          if (cents !== null) {
                            onStartAuction(item, positiveInt(draft.auctionQuantity, 1), cents);
                          }
                        }}
                      >
                        Start auction
                      </button>
                      {!auctionWritesEnabled && auctionWriteDisabledReason ? (
                        <span className="lineup-drawer-note">{auctionWriteDisabledReason}</span>
                      ) : null}
                    </div>

                    {/*
                      An event may forbid targeted offers outright. Say so where
                      the control would have been, rather than showing a control
                      whose action the server will refuse.
                    */}
                    {offersBlocked ? (
                      <p className="lineup-drawer-note">
                        This event does not allow targeted offers.
                      </p>
                    ) : (
                      <div className="lineup-drawer-row">
                        <BuyerPicker
                          productId={item.productId}
                          title={item.title}
                          candidates={candidates}
                          value={draft.offerBuyerId}
                          onChange={(buyerId) => onDraftChange(item.productId, { offerBuyerId: buyerId })}
                          disabled={rowBusy}
                          loading={buyersLoading}
                        />
                        <label className="lineup-drawer-field">
                          <span>Offer qty</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={draft.offerQuantity}
                            onChange={(event) =>
                              onDraftChange(item.productId, { offerQuantity: event.target.value })
                            }
                          />
                        </label>
                        <label className="lineup-drawer-field">
                          <span>Offer price</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={draft.offerPriceCents}
                            placeholder="0.00"
                            onChange={(event) =>
                              onDraftChange(item.productId, { offerPriceCents: event.target.value })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="button"
                          disabled={
                            rowBusy ||
                            draft.offerBuyerId === '' ||
                            priceToCents(draft.offerPriceCents) === null
                          }
                          onClick={() => {
                            const buyer = candidates.find((c) => c.buyerId === draft.offerBuyerId);
                            const cents = priceToCents(draft.offerPriceCents);
                            if (buyer && cents !== null) {
                              onSendOffer(item, buyer, positiveInt(draft.offerQuantity, 1), cents);
                            }
                          }}
                        >
                          Send offer
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <div className="lineup-timeline-save">
        <button type="button" className="button primary" onClick={onSave} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save run of show'}
        </button>
        <span className="lineup-timeline-savestatus" aria-live="polite">
          {saveStatus === 'saved' ? 'Saved' : `${view.slots.length} in the show`}
        </span>
        {saveError ? <span className="lineup-timeline-error">{saveError}</span> : null}
      </div>

      {/*
        Reserved, not in the show. These are real lineup products the plan does
        not mention — deliberately visible, because an invisible product is one
        the seller forgets they can reach for mid-show.
      */}
      <div className="lineup-timeline-tray">
        <h4>Reserved · not in the show</h4>
        {view.unplanned.length === 0 ? (
          <p className="lineup-timeline-empty">Every product in this event is in the show.</p>
        ) : (
          <ul className="lineup-tray-items">
            {view.unplanned.map((entry) => (
              <li key={entry.productId} className="lineup-tray-item">
                <span className="lineup-tray-title">{entry.title}</span>
                <button
                  type="button"
                  className="button tertiary"
                  onClick={() => onAddToShow(entry.productId)}
                >
                  Add to show
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Re-exported for the container so it does not need to reach into two modules. */
export type { RunOfShowView, SellerEventItem };

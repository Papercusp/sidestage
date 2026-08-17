import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import {
  buildRunOfShowView,
  formatClock,
  formatPace,
  seededEntries,
  type RunOfShowPlan,
  type RunOfShowView,
} from '../run-of-show';
import { useStageClock, useStageNow } from './stage-clock';
import {
  executeSellerAction,
  startSellerAuction,
  type SellerActionResult,
  type SellerAuction,
  type SellerEventItem,
} from '../events/api';
import type { CatalogProduct } from '../seller-products';
import type { EventConfigView } from '../ConfigTab';
import { PricingHistoryPanel } from './PricingHistoryPanel';
import { MarkdownControl } from './MarkdownControl';
import { OfferComposer, emptyOfferDraft } from './OfferComposer';
import { buyerCandidates, type PresenceRowView } from './offer-guard';
import '../run-of-show.css';

/**
 * The live run-of-show panel (plan P-004/P-005).
 *
 * ADVISORY (D-001): a position marker, the staged product's notes, a soft
 * elapsed-vs-budget clock, and the aggregate pacing line. Nothing here blocks
 * or auto-stages; the one action is the next-up button, which stages the
 * planned next product only when the seller taps it.
 */

export interface RunOfShowPanelProps {
  eventId: string;
  /** The acting seller, for the guarded push action "Take live" now performs. */
  actorId: string;
  /** The product currently on stage, including the live card's commerce detail. */
  activeProduct: CatalogProduct | null;
  /** The existing app-level catalog projection, used for next-item imagery. */
  catalogProducts?: readonly CatalogProduct[];
  /** One-tap advisory staging: the seller chose to follow the plan. */
  onActiveProductChange: (productId: string | null) => void;
  apiBaseUrl?: string;
}

export interface NextAuctionLauncherProps {
  item: SellerEventItem;
  product?: CatalogProduct | null;
  startingPrice: string;
  durationSec: number;
  busy?: boolean;
  disabledReason?: string | null;
  feedback?: { tone: 'success' | 'error'; text: string } | null;
  onStartingPriceChange: (value: string) => void;
  onDurationChange: (durationSec: number) => void;
  onStart: () => void;
}

function money(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

function moneyInputToCents(value: string): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** The approved inline action card; it never stages the product implicitly. */
export function NextAuctionLauncher({
  item,
  product,
  startingPrice,
  durationSec,
  busy = false,
  disabledReason,
  feedback,
  onStartingPriceChange,
  onDurationChange,
  onStart,
}: NextAuctionLauncherProps) {
  const available = Math.max(0, item.quantity);
  const buttonDisabled = busy || Boolean(disabledReason) || moneyInputToCents(startingPrice) === null;
  const readyText = disabledReason ?? 'Review before launch';

  return (
    <div className="run-of-show-auction" aria-label={`Auction setup for ${item.title}`}>
      <div className="run-of-show-auction-product">
        <div className="run-of-show-auction-media" aria-hidden="true">
          {product?.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>{product?.glyph ?? item.title.charAt(0)}</span>}
        </div>
        <div className="run-of-show-auction-copy">
          <strong>{item.title}</strong>
          <p><b>{available} available</b><span>Retail {money(item.priceCents)}</span></p>
        </div>
      </div>

      <div className="run-of-show-auction-controls">
        <label>
          <span>Opening bid</span>
          <span className="run-of-show-auction-money">
            <span aria-hidden="true">$</span>
            <input
              aria-label={`Opening bid for ${item.title}`}
              type="number"
              min={0.01}
              step={0.01}
              inputMode="decimal"
              value={startingPrice}
              onChange={(event) => onStartingPriceChange(event.target.value)}
            />
          </span>
        </label>
        <label>
          <span>Duration</span>
          <select
            aria-label={`Auction duration for ${item.title}`}
            value={durationSec}
            onChange={(event) => onDurationChange(Number(event.target.value))}
          >
            <option value={30}>30 sec</option>
            <option value={60}>60 sec</option>
            <option value={90}>90 sec</option>
            <option value={120}>2 min</option>
            <option value={300}>5 min</option>
          </select>
        </label>
        <button
          className="button primary run-of-show-auction-start"
          type="button"
          disabled={buttonDisabled}
          title={disabledReason ?? undefined}
          onClick={onStart}
        >
          {busy ? 'Starting…' : 'Start auction'}
        </button>
      </div>

      <div className={`run-of-show-auction-review${disabledReason ? ' is-blocked' : ''}`}>
        <span aria-hidden="true">✓</span>
        <span>{readyText}</span>
      </div>
      {feedback ? (
        <p className={`run-of-show-auction-feedback is-${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}

/** Presentational body, exported for markup tests (no fetch, no timers). */
export function RunOfShowPanelView({
  view,
  loaded,
  error,
  onStageNext,
  activeProduct = null,
  pricingHistory = null,
  stageCommerce = null,
  nextAuctionLauncher = null,
  stageBusy = false,
  stageError = null,
}: {
  view: RunOfShowView;
  loaded: boolean;
  error: string | null;
  onStageNext: (productId: string) => void;
  activeProduct?: CatalogProduct | null;
  pricingHistory?: ReactNode;
  /**
   * The guarded markdown + targeted-offer controls for whatever is ON STAGE.
   * Injected rather than built here so this view stays a pure markup function
   * with no fetch and no timers, exactly as its tests assume.
   */
  stageCommerce?: ReactNode;
  nextAuctionLauncher?: ReactNode;
  /** True while the guarded push is in flight, so the button cannot double-fire. */
  stageBusy?: boolean;
  /** The server's own refusal, shown verbatim — it is the authority, not us. */
  stageError?: string | null;
}) {
  const {
    slots,
    activeSlot,
    offPlanActive,
    nextUp,
    paceDeltaSec,
    plannedTotalSec,
    remainingCount,
    totalElapsedSec,
  } = view;
  const completed = slots.filter((slot) => slot.state === 'done');
  const upcoming = slots.filter((slot) => slot.state === 'upcoming');
  const currentTitle = activeProduct?.name ?? activeSlot?.title ?? offPlanActive?.title ?? null;
  const currentProductId = activeSlot?.productId ?? offPlanActive?.productId ?? null;
  const currentProduct = activeProduct?.id === currentProductId ? activeProduct : null;
  const currentClock = activeSlot
    ? `${formatClock(activeSlot.spentSec)}${activeSlot.plannedDurationSec !== null ? ` / ${formatClock(activeSlot.plannedDurationSec)}` : ''}`
    : null;

  return (
    <section className="run-of-show-panel" aria-labelledby="run-of-show-title">
      <header className="run-of-show-header">
        <div className="panel-kicker">Run of show</div>
        <p className="run-of-show-summary">
          <span>{formatClock(totalElapsedSec)} elapsed</span>
          <span aria-hidden="true">·</span>
          <span className="run-of-show-pace">{formatPace(paceDeltaSec, remainingCount, plannedTotalSec)}</span>
        </p>
      </header>

      {error ? <p className="run-of-show-error" role="alert">{error}</p> : null}

      {slots.length === 0 ? (
        <div className="empty-state">
          <h3 id="run-of-show-title">No show plan yet</h3>
          <p>{loaded ? 'Plan the order, timing, and notes in the Event Manager board before going live.' : 'Loading the plan…'}</p>
        </div>
      ) : (
        <>
          <h3 id="run-of-show-title" className="visually-hidden">Run of show</h3>

          {completed.length > 0 ? (
            <details className="run-of-show-completed">
              <summary>{completed.length} completed</summary>
              <ol className="run-of-show-completed-list">
                {completed.map((slot) => (
                  <li key={slot.productId} className="run-of-show-compact-row state-done">
                    <span className="run-of-show-slot-marker" aria-hidden="true">✓</span>
                    <span className="run-of-show-slot-title">{slot.title}</span>
                    <span className="run-of-show-slot-time">{formatClock(slot.spentSec)}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          {currentTitle ? (
            <article className="run-of-show-current-card" aria-current="step" aria-live="polite">
              <div className="run-of-show-timeline-marker state-active">
                <span className="run-of-show-marker-label">Now</span>
                <span className="run-of-show-slot-marker">{activeSlot?.position ?? '•'}</span>
              </div>
              <div className="run-of-show-card">
                <div className="run-of-show-current-head">
                  <div>
                    <strong>{currentTitle}</strong>
                    {currentProduct ? <p>{currentProduct.price} · {currentProduct.stockLabel}</p> : null}
                  </div>
                  {currentClock ? (
                    <span className={activeSlot?.overBudgetSec !== null && (activeSlot?.overBudgetSec ?? 0) > 0 ? 'run-of-show-clock over' : 'run-of-show-clock'}>
                      {currentClock}
                    </span>
                  ) : <span className="run-of-show-off-plan">off plan</span>}
                </div>
                {activeSlot?.notes ? (
                  <p className="run-of-show-notes">{activeSlot.notes}</p>
                ) : offPlanActive ? (
                  <p className="run-of-show-notes muted">Not in the show plan — carry on, the plan picks back up whenever you do.</p>
                ) : (
                  <p className="run-of-show-notes muted">No notes for this product.</p>
                )}
                {pricingHistory}
                {stageCommerce}
              </div>
            </article>
          ) : null}

          <ol className="run-of-show-list">
            {upcoming.map((slot) => {
              const isNext = slot.productId === nextUp?.productId;
              return (
                <li key={slot.productId} className={isNext ? 'run-of-show-upcoming state-next' : 'run-of-show-upcoming'}>
                  <div className="run-of-show-timeline-marker">
                    {isNext ? <span className="run-of-show-marker-label">Next</span> : null}
                    <span className="run-of-show-slot-marker">{slot.position}</span>
                  </div>
                  {isNext ? (
                    <div className="run-of-show-card run-of-show-next-card">
                      <div className="run-of-show-compact-row">
                        <span className="run-of-show-slot-title">{slot.title}</span>
                        <span className="run-of-show-slot-time">
                          {slot.plannedDurationSec !== null ? formatClock(slot.plannedDurationSec) : '—'}
                        </span>
                      </div>
                      {nextAuctionLauncher}
                      <button
                        className="button secondary run-of-show-take-live"
                        type="button"
                        disabled={stageBusy}
                        aria-busy={stageBusy || undefined}
                        onClick={() => onStageNext(slot.productId)}
                      >
                        {stageBusy ? 'Taking live…' : 'Take live'}
                      </button>
                      {stageError ? (
                        <p className="run-of-show-stage-error" role="status">{stageError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <details className="run-of-show-card run-of-show-later-card">
                      <summary className="run-of-show-compact-row">
                        <span className="run-of-show-slot-title">{slot.title}</span>
                        <span className="run-of-show-slot-time">
                          {slot.plannedDurationSec !== null ? formatClock(slot.plannedDurationSec) : '—'}
                        </span>
                      </summary>
                      <p className="run-of-show-notes muted">{slot.notes || 'No notes for this product.'}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export function RunOfShowPanel({
  eventId,
  actorId,
  activeProduct,
  catalogProducts = [],
  onActiveProductChange,
  apiBaseUrl,
}: RunOfShowPanelProps) {
  const principal = useSyncPrincipal() ?? undefined;
  /*
   * The ONE shared clock (D-003) — read, never created, and no longer received
   * as a prop. The prop let a host hand this panel a log that had accumulated
   * separately from the Lineup's, which is the exact disagreement D-003 forbids:
   * a `StageLog` remembers how long each product has held the stage, so a second
   * one does not agree with the first. `nowMs` comes from the same provider, so
   * both surfaces measure elapsed against the same instant.
   */
  const log = useStageClock();
  const nowMs = useStageNow();
  /**
   * The plan rides the audited sync path (sync-contract.test.ts): the server
   * registers `event.runOfShow` and invalidates it on every PUT, so a save in
   * the planner board appears here live with no refetch code of our own.
   */
  const planQuery = useSyncQuery<RunOfShowPlan>({ queryName: 'event.runOfShow', args: { eventId } });
  const itemsQuery = useSyncQuery<SellerEventItem>({ queryName: 'event.actions.items', args: { eventId } });
  const auctionQuery = useSyncQuery<SellerAuction>({
    queryName: 'event.auction.active',
    args: { eventId },
    staleTime: 0,
  });
  /*
   * The SAME two reads the Lineup surface makes, by the same query names, so
   * the guardrail this dock draws and the one the Lineup draws are the same
   * policy — P-006's "cannot drift" is a claim about the INPUTS as much as the
   * controls. The 10s presence poll matches EventChat and EventManager, so the
   * three surfaces cannot disagree about who is in the room.
   */
  const configQuery = useSyncQuery<EventConfigView>({ queryName: 'event.config', args: { eventId } });
  const presenceQuery = useSyncQuery<PresenceRowView>({
    queryName: 'event.chat.presence',
    args: { eventId },
    pollIntervalMs: 10_000,
  });
  const lineupItems = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  /*
   * The SAME show the Lineup renders (D-010), through the same helper — an
   * event nobody planned still has a show, seeded from lineup order. Reading
   * `entries` raw here would make the two surfaces disagree about what the show
   * IS: the Lineup would show every reserved product as a slot while this dock
   * showed "No show plan yet", which is the drift P-006 exists to close.
   */
  const entries = useMemo(
    () => seededEntries(planQuery.data?.[0], lineupItems.map((item) => item.productId)),
    [planQuery.data, lineupItems],
  );
  const titles = useMemo(
    () => Object.fromEntries(lineupItems.map((item) => [item.productId, item.title])),
    [lineupItems],
  );
  const offerBuyers = useMemo(
    () => buyerCandidates({
      presence: presenceQuery.data,
      auction: auctionQuery.data?.[0] ?? null,
      excludeUserId: actorId,
    }),
    [actorId, auctionQuery.data, presenceQuery.data],
  );
  const policy = configQuery.data?.[0]?.policy;
  /*
   * The item ON STAGE, by the server's own flag (D-005) — the same truth the
   * clock advances on. The commerce controls below act on whatever is live, so
   * reading local selection here would let the seller mark down one product
   * while the room is looking at another.
   */
  const stagedItem = useMemo(
    () => lineupItems.find((item) => item.onStage) ?? null,
    [lineupItems],
  );
  const [markdownPercent, setMarkdownPercent] = useState('');
  const [offerDraft, setOfferDraft] = useState(emptyOfferDraft);
  const [commerceBusy, setCommerceBusy] = useState(false);
  const [commerceNote, setCommerceNote] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [startingPrice, setStartingPrice] = useState('');
  const [durationSec, setDurationSec] = useState(90);
  const [auctionBusy, setAuctionBusy] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [auctionFeedback, setAuctionFeedback] = useState<NextAuctionLauncherProps['feedback']>(null);

  const loaded = !planQuery.loading && !itemsQuery.loading;
  const error = planQuery.error
    ? 'The show plan could not be loaded.'
    : itemsQuery.error
      ? 'The live event lineup could not be loaded.'
      : null;

  const view = useMemo(
    () => buildRunOfShowView({
      entries,
      titles,
      log,
      nowMs,
      lineupProductIds: lineupItems.map((item) => item.productId),
    }),
    [entries, titles, log, nowMs, lineupItems],
  );

  const nextItem = useMemo(
    () => lineupItems.find((item) => item.productId === view.nextUp?.productId) ?? null,
    [lineupItems, view.nextUp?.productId],
  );
  const nextProduct = useMemo(
    () => catalogProducts.find((product) => product.id === nextItem?.productId) ?? null,
    [catalogProducts, nextItem?.productId],
  );
  const currentAuction = auctionQuery.data?.[0] ?? null;

  useEffect(() => {
    setStartingPrice(nextItem ? (nextItem.priceCents / 100).toFixed(2) : '');
    setDurationSec(90);
    setAuctionFeedback(null);
  }, [nextItem?.priceCents, nextItem?.productId]);

  type StartNextAuction = {
    item: SellerEventItem;
    startingPriceCents: number;
    durationSec: number;
  };
  const startAuctionFallback = useCallback(
    ({ item, startingPriceCents, durationSec: selectedDuration }: StartNextAuction) => startSellerAuction(
      eventId,
      item,
      1,
      startingPriceCents,
      apiBaseUrl,
      principal,
      selectedDuration,
    ),
    [apiBaseUrl, eventId, principal],
  );
  const mutateStartAuction = useSyncMutate<StartNextAuction, SellerAuction>('auction.start', startAuctionFallback);

  const auctionDisabledReason = !nextItem
    ? null
    : itemsQuery.loading || auctionQuery.loading
      ? 'Checking live auction readiness'
      : itemsQuery.error || auctionQuery.error
        ? 'Live auction readiness is unavailable'
        : nextItem.quantity < 1
          ? 'No reserved event inventory is available'
          : currentAuction?.status === 'active'
            ? 'Close the current auction before starting another'
            : moneyInputToCents(startingPrice) === null
              ? 'Enter a valid opening bid'
              : null;

  /**
   * "Take live" performs the GUARDED SERVER PUSH, then follows the server.
   *
   * D-005 makes the stage clock advance on the event's server-authoritative
   * `onStage` flag rather than the seller's local selection. This button used to
   * set local selection ONLY, so under that clock it was visibly inert: the
   * seller tapped it, the card changed, and the clock never started because
   * nothing on the server had moved.
   *
   * Note the ORDER, which is the whole correctness argument: local selection is
   * advanced only AFTER the push resolves. Advancing first (or optimistically)
   * would put the dock and the clock into exactly the disagreement D-005 exists
   * to prevent, and a rejected push would leave the seller looking at a card
   * that is not on stage.
   *
   * There is deliberately NO client mirror of the push guard here, unlike the
   * markdown and offer controls. Those mirrors exist because the seller COMPOSES
   * a value the server may refuse (a percent, a price, a quantity, a buyer), so
   * the control must stop where the server stops. "Take live" composes nothing —
   * it is one button on one already-planned product — so there is no value to
   * pre-validate, and the honest design is to call the server and report its
   * verdict verbatim rather than to predict it.
   */
  type StagePushMutation = { eventId: string; actorId: string; productId: string; title: string };
  const stagePushFallback = useCallback(
    ({ eventId: pushEventId, actorId: pushActorId, productId, title }: StagePushMutation) => executeSellerAction(
      pushEventId,
      pushActorId,
      {
        kind: 'push',
        productId,
        // A push carries NO quantity, price, or swap target: guardrail.ts:101-118
        // blocks a push that includes any of them, and a reason is required
        // before any action is evaluated at all (guardrail.ts:70).
        reason: `Seller took ${title} live from the run of show`,
      },
      apiBaseUrl,
      principal,
    ),
    [apiBaseUrl, principal],
  );
  const mutateStagePush = useSyncMutate<StagePushMutation, SellerActionResult>('event.executeAction', stagePushFallback);

  const stageNext = async (productId: string) => {
    if (stageBusy) return;
    setStageBusy(true);
    setStageError(null);
    try {
      await mutateStagePush({
        eventId,
        actorId,
        productId,
        title: titles[productId] ?? 'the next item',
      });
      // The server is now the source of truth for what is on stage; re-read it
      // so the clock and the "on stage" chip both see the transition.
      itemsQuery.invalidate();
      onActiveProductChange(productId);
    } catch (caught) {
      setStageError(caught instanceof Error ? caught.message : 'This item could not be taken live.');
    } finally {
      setStageBusy(false);
    }
  };

  /*
   * Markdown and targeted offer both ride the ONE guarded action seam this
   * panel already uses for the push, so the dock gains no transport of its own.
   * The reason string names the surface, because the audit log is read later by
   * someone asking WHERE a price move came from.
   */
  /*
   * The action shape comes FROM the client that sends it, so a field the server
   * would reject cannot be assembled here. `ActionProposal` is not exported, and
   * widening to a Record + cast would have thrown away exactly the checking that
   * caught a malformed action while this was being written.
   */
  type SellerAction = Parameters<typeof executeSellerAction>[2];
  type CommerceMutation = { eventId: string; actorId: string; action: SellerAction };
  const commerceFallback = useCallback(
    ({ eventId: actionEventId, actorId: commerceActorId, action }: CommerceMutation) => executeSellerAction(
      actionEventId,
      commerceActorId,
      action,
      apiBaseUrl,
      principal,
    ),
    [apiBaseUrl, principal],
  );
  const mutateCommerce = useSyncMutate<CommerceMutation, SellerActionResult>('event.executeAction', commerceFallback);

  const runCommerce = async (action: SellerAction, success: string) => {
    if (commerceBusy) return;
    setCommerceBusy(true);
    setCommerceNote(null);
    try {
      await mutateCommerce({ eventId, actorId, action });
      itemsQuery.invalidate();
      setCommerceNote({ tone: 'success', text: success });
    } catch (caught) {
      // The server's refusal, verbatim — it is the authority, not our mirror.
      setCommerceNote({
        tone: 'error',
        text: caught instanceof Error ? caught.message : 'That change was not applied.',
      });
    } finally {
      setCommerceBusy(false);
    }
  };

  const startNextAuction = async () => {
    if (!nextItem || auctionDisabledReason || auctionBusy) return;
    const startingPriceCents = moneyInputToCents(startingPrice);
    if (startingPriceCents === null) return;
    setAuctionBusy(true);
    setAuctionFeedback(null);
    try {
      await mutateStartAuction({ item: nextItem, startingPriceCents, durationSec });
      auctionQuery.invalidate();
      setAuctionFeedback({ tone: 'success', text: `${nextItem.title} auction started for ${durationSec} seconds.` });
    } catch (caught) {
      setAuctionFeedback({
        tone: 'error',
        text: caught instanceof Error ? caught.message : 'The auction could not be started.',
      });
    } finally {
      setAuctionBusy(false);
    }
  };

  return (
    <RunOfShowPanelView
      view={view}
      loaded={loaded}
      error={error}
      onStageNext={(productId) => void stageNext(productId)}
      stageBusy={stageBusy}
      stageError={stageError}
      activeProduct={activeProduct}
      pricingHistory={activeProduct ? <PricingHistoryPanel eventId={eventId} productId={activeProduct.id} /> : null}
      stageCommerce={stagedItem ? (
        <div className="run-of-show-commerce">
          {/*
            The SHARED controls (P-006), not dock-local copies: the same
            MarkdownControl the Lineup drawer renders, so the floor drawn here
            and the floor drawn there are one implementation reading one policy.
            D-006 — the previewed price IS the sent price, so `onApply` forwards
            the cents the control showed rather than recomputing them.
          */}
          <MarkdownControl
            productId={stagedItem.productId}
            title={stagedItem.title}
            currentPriceCents={stagedItem.priceCents}
            policy={policy}
            percent={markdownPercent}
            onPercentChange={setMarkdownPercent}
            disabled={commerceBusy}
            applyLabel="Mark down live"
            onApply={(percent, priceCents) => void runCommerce(
              {
                kind: 'markdown',
                productId: stagedItem.productId,
                priceCents,
                reason: `Seller applied a ${percent}% markdown from the run of show`,
              },
              `${stagedItem.title} markdown passed the event guardrail.`,
            )}
          />
          <OfferComposer
            productId={stagedItem.productId}
            title={stagedItem.title}
            currentPriceCents={stagedItem.priceCents}
            availableQty={stagedItem.availableQty}
            policy={policy}
            blockedActionKinds={policy?.blockedActionKinds}
            candidates={offerBuyers}
            buyersLoading={presenceQuery.loading}
            disabled={commerceBusy}
            draft={offerDraft}
            onDraftChange={(patch) => setOfferDraft((current) => ({ ...current, ...patch }))}
            onSend={(buyer, quantity, priceCents) => void runCommerce(
              {
                kind: 'targeted-offer',
                productId: stagedItem.productId,
                buyerId: buyer.buyerId,
                quantity,
                priceCents,
                reason: `Seller offered ${stagedItem.title} to ${buyer.displayName} from the run of show`,
              },
              `Offer sent to ${buyer.displayName}.`,
            )}
          />
          {commerceNote ? (
            <p
              className={`run-of-show-commerce-note is-${commerceNote.tone}`}
              role={commerceNote.tone === 'error' ? 'alert' : 'status'}
            >
              {commerceNote.text}
            </p>
          ) : null}
        </div>
      ) : null}
      nextAuctionLauncher={nextItem ? (
        <NextAuctionLauncher
          item={nextItem}
          product={nextProduct}
          startingPrice={startingPrice}
          durationSec={durationSec}
          busy={auctionBusy}
          disabledReason={auctionDisabledReason}
          feedback={auctionFeedback}
          onStartingPriceChange={setStartingPrice}
          onDurationChange={setDurationSec}
          onStart={() => void startNextAuction()}
        />
      ) : null}
    />
  );
}

export default RunOfShowPanel;

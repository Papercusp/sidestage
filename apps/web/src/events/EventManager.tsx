import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import { EventSettingsPanel, type EventConfigView } from '../ConfigTab';
import {
  eventManagerHref,
  useUrlEventManagerRoute,
  type EventManagerRoute,
  type EventManagerSection,
} from '../app-routing';
import EventCreationPanel from '../event-creation/EventCreationPanel';
import type { EventCreationPayload } from '../event-creation/catalog';
import { buyerCandidates, type PresenceRowView } from '../seller/offer-guard';
import {
  LineupTimelineView,
  emptySlotDraft,
  type TimelineSlotDraft,
} from '../seller/LineupTimeline';
import { useHasStageClock, useStageClock, useStageNow } from '../seller/stage-clock';
import {
  buildRunOfShowView,
  seededShowOrder,
  type RunOfShowEntry,
  type RunOfShowPlan,
} from '../run-of-show';
import {
  addItemsToSellerEvent,
  adjustSellerEventStock,
  closeSellerAuction,
  executeSellerAction,
  saveRunOfShowPlan,
  setupSellerEvent,
  startSellerAuction,
  transitionSellerEvent,
  unpublishSellerEvent,
  type SellerActionResult,
  type SellerAuction,
  type SellerEventItem,
  type SellerEventRecord,
  type SellerEventSetup,
} from './api';
import {
  instantFromLocalInput,
  lifecycleRefusal,
  lifecycleStatusRefusal,
  type EventLifecycleAction,
} from './event-lifecycle';
import './event-manager.css';

export interface EventManagerProps {
  eventId: string;
  actorId: string;
  sellerName?: string;
  eventName?: string;
  apiBaseUrl?: string;
  initialItems?: readonly SellerEventItem[];
  initialEvents?: readonly SellerOwnedEvent[];
  onEventReady?: (eventId: string, eventName: string) => void;
}

/**
 * A row of the seller's own event directory.
 *
 * The same shape the lifecycle endpoint returns, so it is an ALIAS rather than
 * a second declaration: two hand-maintained copies of one server record is how
 * a field added on the API silently fails to reach one of its two readers.
 */
export type SellerOwnedEvent = SellerEventRecord;

/**
 * Minutes as typed -> the seconds the run-of-show document stores.
 *
 * Three outcomes, deliberately distinct: `null` is a slot with NO budget (a
 * valid plan), a number is a budget, and `undefined` means the seller typed
 * something the save must refuse. Collapsing the last two would either send a
 * NaN or silently drop a budget the seller believed they set. The 1..240 range
 * is the server's, mirrored here so the refusal names the product.
 */
function draftMinutesToSeconds(minutes: string): number | null | undefined {
  const trimmed = minutes.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 240) return undefined;
  return Math.round(parsed * 60);
}

/** The stored half of a slot draft — what a saved entry seeds back into the editor. */
function draftFromEntry(entry: RunOfShowEntry): Pick<TimelineSlotDraft, 'minutes' | 'notes'> {
  return {
    minutes: entry.plannedDurationSec === null ? '' : String(Math.round(entry.plannedDurationSec / 60)),
    notes: entry.notes,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The seller event request failed.';
}

type AddItemsMutation = { eventId: string; payload: EventCreationPayload };
type ExecuteActionMutation = {
  eventId: string;
  actorId: string;
  action: Parameters<typeof executeSellerAction>[2];
};
type AdjustStockMutation = {
  eventId: string;
  actorId: string;
  item: SellerEventItem;
  quantity: number;
};
type StartAuctionMutation = {
  eventId: string;
  item: SellerEventItem;
  quantity: number;
  startingPriceCents: number;
};
type CloseAuctionMutation = { auctionId: string };
type LifecycleMutation = {
  eventId: string;
  action: EventLifecycleAction;
  startsAt?: string | null;
};
type UnpublishMutation = { eventId: string };

function formatAuctionPrice(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function eventInitials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || 'EV';
}

/** The one wall-clock rendering for event times, so the list and the lifecycle
 *  confirmations cannot describe the same instant two different ways. */
function formatStartTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function eventTiming(event: SellerOwnedEvent): string {
  const date = event.status === 'ended' ? event.endedAt : event.startsAt;
  if (!date) return event.status === 'draft' ? 'Not scheduled' : 'Schedule pending';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Schedule pending';
  return formatStartTime(date);
}

function managerRoute(
  eventId: string | undefined,
  section: EventManagerSection = 'lineup',
): EventManagerRoute {
  return { view: 'events', ...(eventId ? { eventId } : {}), section };
}

const EVENT_DETAIL_SECTIONS: ReadonlyArray<{
  id: EventManagerSection;
  label: string;
}> = [
  { id: 'lineup', label: 'Lineup' },
  { id: 'settings', label: 'Settings' },
];

const EVENT_MANAGER_VIEWS: ReadonlyArray<EventManagerRoute['view']> = ['events', 'create'];

/**
 * Pure seam for the WAI-ARIA tab keys, so the roving-focus rule is covered
 * without depending on jsdom focus behaviour. Returns null for a key the
 * tablist does not handle, which is the signal to leave the event alone.
 */
export function nextTabId<T extends string>(
  ids: readonly T[],
  current: T,
  key: string,
): T | null {
  const index = ids.indexOf(current);
  if (index < 0) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length];
  return null;
}

export function EventManager({
  eventId,
  actorId,
  sellerName,
  eventName = 'Seller event',
  apiBaseUrl,
  initialItems,
  initialEvents,
  onEventReady,
}: EventManagerProps) {
  const [route, navigateRoute] = useUrlEventManagerRoute();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [eventSearch, setEventSearch] = useState('');
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A half-typed start time is a mid-edit draft, so it stays local: nothing
  // else reads it and a shareable URL carrying someone's abandoned keystrokes
  // would be worse than useless.
  const [startsAtDraft, setStartsAtDraft] = useState('');
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
  const sellerDisplayName = sellerName?.trim() || actorId;
  const demoPrincipal = useSyncPrincipal() ?? actorId;

  const directoryQuery = useSyncQuery<SellerOwnedEvent>({
    queryName: 'events.mine',
    args: { sellerId: actorId },
    enabled: initialEvents === undefined,
    pollIntervalMs: 15_000,
  });
  const events = initialEvents ?? directoryQuery.data ?? [];
  const filteredEvents = useMemo(() => {
    const needle = eventSearch.trim().toLowerCase();
    return needle
      ? events.filter((event) => `${event.title} ${event.status}`.toLowerCase().includes(needle))
      : [...events];
  }, [eventSearch, events]);
  const routedEvent = route.eventId
    ? events.find((event) => event.eventId === route.eventId)
    : undefined;
  const fallbackEvent = events.find((event) => event.eventId === eventId) ?? events[0];
  // The owned-event directory is authoritative for both the detail metadata
  // and the id sent to owner-checked queries. A routed id that is absent from
  // that directory must not borrow the first event's metadata, and the shared
  // seller fallback must not create a phantom detail when this seller has no
  // events at all.
  const selectedEvent = route.eventId ? routedEvent : fallbackEvent;
  const selectedEventId = selectedEvent?.eventId ?? eventId;
  const hasSelectedEvent = selectedEvent !== undefined;
  const isCreateView = route.view === 'create';

  const configQuery = useSyncQuery<EventConfigView>({
    queryName: 'event.config',
    args: { eventId: selectedEventId },
    enabled: initialItems === undefined && !isCreateView && hasSelectedEvent,
    pollIntervalMs: 30_000,
  });
  const itemsQuery = useSyncQuery<SellerEventItem>({
    queryName: 'event.actions.items',
    args: { eventId: selectedEventId },
    enabled: initialItems === undefined && !isCreateView && hasSelectedEvent,
    pollIntervalMs: 10_000,
  });
  const auctionQuery = useSyncQuery<SellerAuction>({
    queryName: 'event.auction.active',
    args: { eventId: selectedEventId },
    enabled: !isCreateView && hasSelectedEvent,
    pollIntervalMs: 2_000,
    staleTime: 0,
  });
  // Who a targeted offer may be addressed to. The server already TTL-filters
  // presence to 35s (chat.service.ts:54), so this list is "in the event now"
  // rather than "was here at some point"; the 10s poll matches EventChat so the
  // two surfaces cannot disagree about who is in the room.
  const presenceQuery = useSyncQuery<PresenceRowView>({
    queryName: 'event.chat.presence',
    args: { eventId: selectedEventId },
    enabled: !isCreateView && hasSelectedEvent,
    pollIntervalMs: 10_000,
  });
  const offerBuyers = useMemo(
    () => buyerCandidates({
      presence: presenceQuery.data,
      auction: auctionQuery.data?.[0] ?? null,
      excludeUserId: actorId,
    }),
    [actorId, auctionQuery.data, presenceQuery.data],
  );
  const name = configQuery.data?.[0]?.name ?? selectedEvent?.title ?? eventName;
  const items = initialItems ?? itemsQuery.data ?? [];
  const currentAuction = auctionQuery.data?.[0] ?? null;
  const loaded = isCreateView || initialItems !== undefined || (!configQuery.loading && !itemsQuery.loading);
  const readError = initialItems === undefined ? configQuery.error ?? itemsQuery.error : null;

  /*
   * THE RUN OF SHOW LIVES HERE NOW (D-001, direction C). The lineup IS the run
   * of show, so the stored plan, the show order, and the per-slot drafts are
   * owned by this container and rendered by `LineupTimelineView`. The separate
   * authoring panel this replaces is retired from the section below.
   */
  const planQuery = useSyncQuery<RunOfShowPlan>({
    queryName: 'event.runOfShow',
    args: { eventId: selectedEventId },
    enabled: !isCreateView && hasSelectedEvent,
  });
  const storedPlan = planQuery.data?.[0];
  /*
   * `null` = the seller has not reordered, added or removed anything yet, so
   * the show order is DERIVED rather than seeded into state.
   *
   * Deriving it is not a style preference. A seeding effect cannot run during
   * `renderToStaticMarkup` (this codebase's test convention) so the show would
   * test as permanently empty; it would flash the empty state on first paint
   * before the effect landed; and it has to race the lineup and plan queries,
   * which resolve independently, so a seed taken while either was still loading
   * would pin the wrong show and never re-seed. Derivation has none of those
   * failure modes — every render simply reads the best truth available.
   */
  const [showOrderEdit, setShowOrderEdit] = useState<string[] | null>(null);
  const [slotDrafts, setSlotDrafts] = useState<Record<string, TimelineSlotDraft>>({});
  const [openSlotProductId, setOpenSlotProductId] = useState<string | null>(null);
  const [planSaveStatus, setPlanSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [planSaveError, setPlanSaveError] = useState<string | null>(null);

  const storedEntries = useMemo<readonly RunOfShowEntry[]>(
    () => storedPlan?.entries ?? [],
    [storedPlan],
  );
  const storedByProduct = useMemo(
    () => new Map(storedEntries.map((entry) => [entry.productId, entry])),
    [storedEntries],
  );
  /*
   * AN EVENT NOBODY PLANNED STILL HAS A SHOW (D-010). Direction C's premise is
   * that the lineup IS the run of show, so with nothing ever saved the show
   * order defaults to LINEUP ORDER — every reserved product becomes a slot with
   * no budget. Defaulting to empty instead would put every product in the
   * "reserved, not in the show" tray, and because the commerce controls hang
   * off a slot, a seller who never opened a planner could not push, mark down
   * or auction anything: the old two-surface split wearing the new surface's
   * clothes, with the authoring step now mandatory.
   *
   * A plan that WAS saved wins verbatim, INCLUDING a deliberately emptied one,
   * so removing a product from the show survives a reload. The server makes the
   * two cases distinguishable: a never-saved plan comes back from
   * `emptyRunOfShow()` stamped with the epoch, while every real save stamps
   * `new Date()` (run-of-show.service.ts:76 vs :105). Testing emptiness alone
   * would resurrect products the seller deliberately removed.
   */
  const showOrder = useMemo(
    () => showOrderEdit ?? seededShowOrder(storedPlan, items.map((item) => item.productId)),
    [showOrderEdit, storedPlan, items],
  );

  /**
   * A slot's values before any local edit: the stored entry, or empty.
   *
   * Local edits must layer OVER this rather than replace it — a draft created
   * by typing a markdown percent would otherwise carry `minutes: ''` and
   * silently wipe a budget the seller never touched.
   */
  const baseDraftFor = useCallback(
    (productId: string): TimelineSlotDraft => {
      const stored = storedByProduct.get(productId);
      return { ...emptySlotDraft(), ...(stored ? draftFromEntry(stored) : {}) };
    },
    [storedByProduct],
  );
  const timelineDrafts = useMemo(() => {
    const drafts: Record<string, TimelineSlotDraft> = {};
    for (const productId of showOrder) {
      drafts[productId] = slotDrafts[productId] ?? baseDraftFor(productId);
    }
    // Commerce drafts typed against a product that has since left the show
    // survive in the tray, so re-adding it does not lose what was typed.
    for (const [productId, draft] of Object.entries(slotDrafts)) {
      drafts[productId] ??= draft;
    }
    return drafts;
  }, [showOrder, slotDrafts, baseDraftFor]);

  /*
   * The ONE shared clock (D-003) — read, never created. Outside a provider
   * `showPace` is false and the timeline omits every time column rather than
   * rendering a confident 0:00.
   */
  const stageLog = useStageClock();
  const showPace = useHasStageClock();
  /*
   * The pulse comes from the provider too, not from a timer here. This surface
   * and the Studio dock each used to own one, so the same elapsed second could
   * paint here up to a second before it painted there — two clocks in effect,
   * which is what D-003 forbids, even though the LOG was already shared.
   */
  const nowMs = useStageNow();

  const titles = useMemo(
    () => Object.fromEntries(items.map((item) => [item.productId, item.title])),
    [items],
  );
  /*
   * The plan AS TYPED, so the pace chips track what the seller is editing. An
   * unparseable minutes value contributes NO budget rather than a NaN; `save`
   * below is the thing that refuses it, with the product named.
   */
  const planEntries = useMemo<RunOfShowEntry[]>(
    () => showOrder.map((productId) => {
      const draft = timelineDrafts[productId] ?? emptySlotDraft();
      const seconds = draftMinutesToSeconds(draft.minutes);
      return {
        productId,
        plannedDurationSec: seconds === undefined ? null : seconds,
        notes: draft.notes,
      };
    }),
    [showOrder, timelineDrafts],
  );
  /** Every slot, pace and tray value the timeline renders (D-002: never re-derived). */
  const runOfShowView = useMemo(
    () => buildRunOfShowView({
      entries: planEntries,
      titles,
      log: stageLog,
      nowMs,
      lineupProductIds: items.map((item) => item.productId),
    }),
    [planEntries, titles, stageLog, nowMs, items],
  );

  const setupFallback = useCallback(
    async (payload: EventCreationPayload) => setupSellerEvent(
      payload,
      { sellerId: actorId, sellerName: sellerDisplayName, principal: demoPrincipal },
      apiBaseUrl,
    ),
    [actorId, apiBaseUrl, demoPrincipal, sellerDisplayName],
  );
  const mutateSetup = useSyncMutate<EventCreationPayload, SellerEventSetup>('event.setup', setupFallback);

  const addItemsFallback = useCallback(
    async ({ eventId: resolvedEventId, payload }: AddItemsMutation) => (
      addItemsToSellerEvent(resolvedEventId, payload, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateAddItems = useSyncMutate<AddItemsMutation, SellerEventSetup>('event.addItems', addItemsFallback);

  const actionFallback = useCallback(
    async ({ eventId: resolvedEventId, actorId: resolvedActorId, action }: ExecuteActionMutation) => (
      executeSellerAction(resolvedEventId, resolvedActorId, action, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateAction = useSyncMutate<ExecuteActionMutation, SellerActionResult>('event.executeAction', actionFallback);

  const stockFallback = useCallback(
    async ({ eventId: resolvedEventId, actorId: resolvedActorId, item, quantity }: AdjustStockMutation) => (
      adjustSellerEventStock(resolvedEventId, resolvedActorId, item, quantity, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateStock = useSyncMutate<AdjustStockMutation, SellerActionResult>('event.adjustStock', stockFallback);

  const auctionFallback = useCallback(
    async ({ eventId: resolvedEventId, item, quantity, startingPriceCents }: StartAuctionMutation) => (
      startSellerAuction(resolvedEventId, item, quantity, startingPriceCents, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateStartAuction = useSyncMutate<StartAuctionMutation, SellerAuction>('auction.start', auctionFallback);

  const closeAuctionFallback = useCallback(
    async ({ auctionId }: CloseAuctionMutation) => (
      closeSellerAuction(auctionId, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateCloseAuction = useSyncMutate<CloseAuctionMutation, SellerAuction>('auction.close', closeAuctionFallback);

  const lifecycleFallback = useCallback(
    async ({ eventId: resolvedEventId, action, startsAt }: LifecycleMutation) => (
      transitionSellerEvent(resolvedEventId, action, { startsAt }, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateLifecycle = useSyncMutate<LifecycleMutation, SellerEventRecord>('event.lifecycle', lifecycleFallback);

  const unpublishFallback = useCallback(
    async ({ eventId: resolvedEventId }: UnpublishMutation) => (
      unpublishSellerEvent(resolvedEventId, apiBaseUrl, demoPrincipal)
    ),
    [apiBaseUrl, demoPrincipal],
  );
  const mutateUnpublish = useSyncMutate<UnpublishMutation, { eventId: string; status: 'draft' }>(
    'event.unpublish',
    unpublishFallback,
  );

  /** Whole-document save: reorder, edit and removal are all the same PUT. */
  const runOfShowSaveFallback = useCallback(
    (entries: RunOfShowEntry[]) => saveRunOfShowPlan(selectedEventId, entries, apiBaseUrl, demoPrincipal),
    [selectedEventId, apiBaseUrl, demoPrincipal],
  );
  const mutateSaveRunOfShow = useSyncMutate<RunOfShowEntry[], RunOfShowPlan>(
    'runOfShow.save',
    runOfShowSaveFallback,
  );

  useEffect(() => {
    setPickerOpen(false);
    setMessage(null);
    // The start time belongs to the event that was on screen. Carrying it to
    // the next one would offer to schedule a different room at a time its
    // seller never chose.
    setStartsAtDraft('');
    // Likewise the show plan: another event's order, budgets and notes must
    // never be shown against this one's lineup. Dropping the local overrides
    // returns the timeline to derivation from the newly selected event.
    setShowOrderEdit(null);
    setSlotDrafts({});
    setOpenSlotProductId(null);
    setPlanSaveStatus('idle');
    setPlanSaveError(null);
  }, [selectedEventId]);

  const submitPicker = async (payload: EventCreationPayload) => {
    setMessage(null);
    const result = isCreateView
      ? await mutateSetup(payload)
      : await mutateAddItems({ eventId: selectedEventId, payload });
    setPickerOpen(false);
    setMessage(isCreateView ? 'Event created and inventory reserved.' : 'Catalog items reserved and added to the live event.');
    onEventReady?.(result.eventId, result.name);
    navigateRoute(managerRoute(result.eventId));
  };

  const runAction = async (
    productId: string,
    task: () => Promise<unknown>,
    success: string,
  ) => {
    setBusyProductId(productId);
    setMessage(null);
    try {
      await task();
      setMessage(success);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyProductId(null);
    }
  };

  /*
   * Every edit below marks the document dirty by dropping `saved`, so the save
   * status can never claim "Saved" about a plan that has since been changed.
   */
  const patchSlotDraft = (productId: string, patch: Partial<TimelineSlotDraft>) => {
    setPlanSaveStatus('idle');
    setSlotDrafts((current) => ({
      ...current,
      [productId]: { ...(current[productId] ?? baseDraftFor(productId)), ...patch },
    }));
  };

  /*
   * The first structural edit MATERIALISES the derived order into state — from
   * here on the seller owns it. `showOrder` is the derived value, so the
   * materialised copy starts from exactly what was on screen.
   */
  const reorderShow = (fromIndex: number, toIndex: number) => {
    setPlanSaveStatus('idle');
    if (fromIndex < 0 || fromIndex >= showOrder.length) return;
    if (toIndex < 0 || toIndex >= showOrder.length) return;
    const next = [...showOrder];
    const [moved] = next.splice(fromIndex, 1);
    if (moved === undefined) return;
    next.splice(toIndex, 0, moved);
    setShowOrderEdit(next);
  };

  /** The keyboard path and the drag path are the same move, by design. */
  const moveSlot = (productId: string, delta: -1 | 1) => {
    const index = showOrder.indexOf(productId);
    if (index === -1) return;
    reorderShow(index, index + delta);
  };

  /*
   * Dropping a product from the SHOW never removes it from the lineup — it
   * returns to the reserved tray, one click from coming back. The commerce
   * draft is deliberately kept, so a markdown typed before a reshuffle is
   * still there afterwards.
   */
  const removeFromShow = (productId: string) => {
    setPlanSaveStatus('idle');
    setOpenSlotProductId((current) => (current === productId ? null : current));
    setShowOrderEdit(showOrder.filter((id) => id !== productId));
  };

  const addToShow = (productId: string) => {
    setPlanSaveStatus('idle');
    if (showOrder.includes(productId)) return;
    setShowOrderEdit([...showOrder, productId]);
  };

  const saveRunOfShow = async () => {
    const entries: RunOfShowEntry[] = [];
    for (const productId of showOrder) {
      const draft = timelineDrafts[productId] ?? emptySlotDraft();
      const seconds = draftMinutesToSeconds(draft.minutes);
      if (seconds === undefined) {
        setPlanSaveError(`"${titles[productId] ?? productId}": minutes must be a number between 1 and 240.`);
        return;
      }
      entries.push({ productId, plannedDurationSec: seconds, notes: draft.notes });
    }
    setPlanSaveStatus('saving');
    setPlanSaveError(null);
    try {
      const saved = await mutateSaveRunOfShow(entries);
      // Adopt the SERVER's echo as the new baseline: the local overrides are
      // dropped so the derivation above reads the freshly stored plan, which is
      // now authoritative. Commerce drafts are keyed separately and untouched
      // by this, so a markdown typed before the save survives it.
      setShowOrderEdit(saved.entries.map((entry) => entry.productId));
      setSlotDrafts((current) => {
        const next = { ...current };
        for (const entry of saved.entries) {
          if (next[entry.productId] === undefined) continue;
          next[entry.productId] = { ...next[entry.productId]!, ...draftFromEntry(entry) };
        }
        return next;
      });
      setPlanSaveStatus('saved');
    } catch (cause) {
      setPlanSaveStatus('idle');
      setPlanSaveError(cause instanceof Error ? cause.message : 'The show plan could not be saved.');
    }
  };

  const openRoute = (next: EventManagerRoute) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigateRoute(next);
  };

  // Both tablists are a roving tab stop: only the selected tab is in the Tab
  // sequence, and the arrow/Home/End keys move selection AND focus. Focusing
  // through the owning nav (rather than a per-tab ref array) keeps the anchors
  // free of refs, matching the SellerMobileStudio tablist.
  const viewTabsRef = useRef<HTMLElement>(null);
  const detailTabsRef = useRef<HTMLElement>(null);

  const focusTab = (nav: HTMLElement | null, tabId: string) => {
    nav?.querySelector<HTMLAnchorElement>(`#${tabId}`)?.focus();
  };

  const viewRoute = (view: EventManagerRoute['view']): EventManagerRoute =>
    view === 'create'
      ? { view: 'create', section: 'lineup' }
      : managerRoute(selectedEvent?.eventId, route.section);

  const onViewTabKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    const next = nextTabId(EVENT_MANAGER_VIEWS, route.view, event.key);
    if (!next) return;
    event.preventDefault();
    navigateRoute(viewRoute(next));
    focusTab(viewTabsRef.current, `event-manager-view-tab-${next}`);
  };

  const onDetailTabKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    const sections = EVENT_DETAIL_SECTIONS.map(({ id }) => id);
    const next = nextTabId(sections, route.section, event.key);
    if (!next) return;
    event.preventDefault();
    navigateRoute(managerRoute(selectedEventId, next));
    focusTab(detailTabsRef.current, `event-manager-section-tab-${next}`);
  };

  const selectEvent = (event: SellerOwnedEvent) => {
    onEventReady?.(event.eventId, event.title);
    navigateRoute(managerRoute(event.eventId, route.section));
  };

  const eventStatus = selectedEvent?.status ?? 'draft';
  const scheduleInstant = instantFromLocalInput(startsAtDraft);
  // Every control's availability comes from the mirror of the server's table
  // (event-lifecycle.ts), never from a status check written here: a second
  // hand-written copy of the rule is what lets the UI offer a button whose
  // only outcome is a 409.
  const scheduleRefusal = lifecycleRefusal(eventStatus, 'schedule', scheduleInstant);
  const endRefusal = lifecycleRefusal(eventStatus, 'end');
  // Only the refusals the seller cannot fix by filling the form in — an empty
  // date field explains itself and must not become a standing complaint.
  const lifecycleHint = lifecycleStatusRefusal(eventStatus, 'schedule')
    ?? lifecycleStatusRefusal(eventStatus, 'end');
  const lifecycleBusyNow = lifecycleBusy !== null;

  const runLifecycle = async (
    action: string,
    task: () => Promise<unknown>,
    success: string,
  ) => {
    setLifecycleBusy(action);
    setMessage(null);
    try {
      await task();
      // The move changed what the guide, the seller's directory and this
      // event's own header report, so re-read them rather than painting an
      // optimistic status the server may have resolved differently.
      directoryQuery.invalidate();
      configQuery.invalidate();
      setMessage(success);
    } catch (error) {
      // A refused transition arrives as a 409 whose message IS the server's
      // reason; showing it beats a generic failure the seller cannot act on.
      setMessage(errorMessage(error));
    } finally {
      setLifecycleBusy(null);
    }
  };
  const currentAuctionItem = currentAuction
    ? items.find((item) => item.productId === currentAuction.productId)
    : undefined;
  const currentAuctionIsLive = currentAuction?.status === 'active';
  const auctionWritesEnabled = !currentAuctionIsLive;
  const auctionWriteDisabledReason = currentAuctionIsLive
    ? 'Close the current auction before starting another'
    : undefined;

  const closeCurrentAuction = () => {
    if (!currentAuctionIsLive || !currentAuction) return;
    void runAction(
      currentAuction.productId,
      async () => {
        await mutateCloseAuction({ auctionId: currentAuction.id });
        auctionQuery.invalidate();
      },
      `${currentAuctionItem?.title ?? 'Auction'} closed. The authoritative result is refreshing.`,
    );
  };

  return (
    <section className="event-manager" aria-labelledby="event-manager-title">
      <div className="event-manager-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-manager-title">Event Manager</h2>
          <p className="event-manager-copy">
            Choose an event to manage, or create one from real catalog inventory. Guarded seller actions remain enforced server-side.
          </p>
        </div>
        <nav ref={viewTabsRef} className="event-manager-switch" aria-label="Event Manager view" role="tablist">
          <a
            id="event-manager-view-tab-events"
            className={route.view === 'events' ? 'is-active' : undefined}
            href={eventManagerHref(managerRoute(selectedEvent?.eventId), typeof window === 'undefined' ? '/' : window.location.href)}
            role="tab"
            aria-selected={route.view === 'events'}
            aria-controls="event-manager-events"
            tabIndex={route.view === 'events' ? 0 : -1}
            onClick={openRoute(managerRoute(selectedEvent?.eventId))}
            onKeyDown={onViewTabKeyDown}
          >
            My events <span>{events.length}</span>
          </a>
          <a
            id="event-manager-view-tab-create"
            className={route.view === 'create' ? 'is-active' : undefined}
            href={eventManagerHref({ view: 'create', section: 'lineup' }, typeof window === 'undefined' ? '/' : window.location.href)}
            role="tab"
            aria-selected={route.view === 'create'}
            aria-controls="event-manager-create"
            tabIndex={route.view === 'create' ? 0 : -1}
            onClick={openRoute({ view: 'create', section: 'lineup' })}
            onKeyDown={onViewTabKeyDown}
          >
            Create event
          </a>
        </nav>
      </div>

      {route.view === 'create' ? (
        <div id="event-manager-create" role="tabpanel" className="event-manager-create-view">
          <EventCreationPanel
            title="Build the live lineup"
            copy="Name the event, reserve real catalog inventory, and set the guarded price and quantity for every item."
            submitLabel="Create event"
            onCreateEvent={submitPicker}
          />
        </div>
      ) : (
        <div id="event-manager-events" role="tabpanel" className="event-manager-layout">
          <aside className="event-list-panel" aria-label="My events">
            <div className="event-list-heading">
              <div>
                <p className="eyebrow">My events</p>
                <strong>Drafts, scheduled rooms, live shows, and replays</strong>
              </div>
              <span className="event-list-count">{events.length} total</span>
            </div>
            <label className="event-search-field event-list-search">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">Search my events</span>
              <input
                type="search"
                placeholder="Search events"
                value={eventSearch}
                onChange={(event) => setEventSearch(event.target.value)}
              />
            </label>
            {directoryQuery.loading ? <p className="event-list-state" role="status">Loading your events…</p> : null}
            {directoryQuery.error ? <p className="event-list-state" role="status">{errorMessage(directoryQuery.error)}</p> : null}
            <div className="event-list">
              {filteredEvents.map((event) => (
                <button
                  key={event.eventId}
                  type="button"
                  className={`event-list-row${event.eventId === selectedEventId ? ' is-selected' : ''}`}
                  aria-pressed={event.eventId === selectedEventId}
                  onClick={() => selectEvent(event)}
                >
                  <span className="event-list-avatar" aria-hidden="true">{eventInitials(event.title)}</span>
                  <span className="event-list-copy">
                    <strong>{event.title}</strong>
                    <small>{eventTiming(event)}</small>
                  </span>
                  <span className={`event-status event-status-${event.status}`}>{event.status}</span>
                </button>
              ))}
            </div>
            {!directoryQuery.loading && filteredEvents.length === 0 ? (
              <div className="event-list-empty">
                <p>{eventSearch ? 'No events match this search.' : 'No seller events yet.'}</p>
                {!eventSearch ? (
                  <a
                    className="button secondary"
                    href={eventManagerHref({ view: 'create', section: 'lineup' }, typeof window === 'undefined' ? '/' : window.location.href)}
                    onClick={openRoute({ view: 'create', section: 'lineup' })}
                  >
                    Create event
                  </a>
                ) : null}
              </div>
            ) : null}
          </aside>

          {selectedEvent ? (
          <section className="event-detail-panel" aria-labelledby="event-detail-title">
            <div className="event-detail-heading">
              <div>
                <span className={`event-status event-status-${eventStatus}`}>{eventStatus}</span>
                <h3 id="event-detail-title">{name}</h3>
                <p>{items.length} reserved {items.length === 1 ? 'item' : 'items'} · Event ID {selectedEventId}</p>
              </div>
              <button className="button secondary" type="button" onClick={() => setPickerOpen((open) => !open)}>
                {pickerOpen ? 'Close lineup editor' : 'Add inventory'}
              </button>
            </div>

            <div className="event-lifecycle-controls" role="group" aria-label="Event lifecycle">
              <label className="event-lifecycle-schedule">
                <span>Start time</span>
                <input
                  type="datetime-local"
                  value={startsAtDraft}
                  onChange={(event) => setStartsAtDraft(event.target.value)}
                />
              </label>
              <button
                className="button secondary"
                type="button"
                disabled={lifecycleBusyNow || scheduleRefusal !== null}
                title={scheduleRefusal ?? undefined}
                onClick={() => {
                  // Unreachable while the control is disabled, but the guard is
                  // what makes that a fact rather than an assumption.
                  if (!scheduleInstant) return;
                  void runLifecycle(
                    'schedule',
                    () => mutateLifecycle({
                      eventId: selectedEventId,
                      action: 'schedule',
                      startsAt: scheduleInstant,
                    }),
                    `${name} is scheduled to start ${formatStartTime(scheduleInstant)}.`,
                  );
                }}
              >
                {lifecycleBusy === 'schedule' ? 'Scheduling…' : 'Schedule'}
              </button>
              <button
                className="button primary"
                type="button"
                disabled={lifecycleBusyNow}
                onClick={() => void runLifecycle(
                  'go-live',
                  () => mutateLifecycle({ eventId: selectedEventId, action: 'go-live' }),
                  `${name} is live.`,
                )}
              >
                {lifecycleBusy === 'go-live' ? 'Going live…' : 'Go live'}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={lifecycleBusyNow || endRefusal !== null}
                title={endRefusal ?? undefined}
                onClick={() => void runLifecycle(
                  'end',
                  () => mutateLifecycle({ eventId: selectedEventId, action: 'end' }),
                  `${name} has ended.`,
                )}
              >
                {lifecycleBusy === 'end' ? 'Ending…' : 'End event'}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={lifecycleBusyNow}
                onClick={() => void runLifecycle(
                  'unpublish',
                  () => mutateUnpublish({ eventId: selectedEventId }),
                  `${name} is unpublished and hidden from buyers.`,
                )}
              >
                {lifecycleBusy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
              </button>
              {lifecycleHint ? (
                <small className="event-lifecycle-hint">{lifecycleHint}</small>
              ) : null}
            </div>

            <nav className="event-detail-tabs" aria-label={`${name} detail`} role="tablist">
              {EVENT_DETAIL_SECTIONS.map(({ id: section, label }) => {
                const next = managerRoute(selectedEventId, section);
                return (
                  <a
                    key={section}
                    className={route.section === section ? 'is-active' : undefined}
                    href={eventManagerHref(next, typeof window === 'undefined' ? '/' : window.location.href)}
                    role="tab"
                    aria-selected={route.section === section}
                    onClick={openRoute(next)}
                  >
                    {label}
                  </a>
                );
              })}
            </nav>

            {route.section === 'settings' ? (
              <div className="event-settings-view" role="tabpanel">
                <EventSettingsPanel
                  eventId={selectedEventId}
                  principal={demoPrincipal}
                  apiBaseUrl={apiBaseUrl}
                  embedded
                />
              </div>
            ) : (
              <div className="event-lineup-view" role="tabpanel">
                {!loaded ? <p className="event-manager-message" role="status">Loading verified event state…</p> : null}
                {readError ? <p className="event-manager-message" role="status">{errorMessage(readError)}</p> : null}

                {loaded && pickerOpen ? (
                  <EventCreationPanel
                    initialEventName={name}
                    eventNameReadOnly
                    title={`Add inventory to ${name}`}
                    copy="Select more real-catalog inventory and set the event price and reserved quantity."
                    submitLabel="Reserve and add items"
                    onCreateEvent={submitPicker}
                  />
                ) : null}

                {items.length ? (
                  <>
                    {/*
                      The permanent "guarded seller actions are live" banner is
                      RETIRED here (fault 8). It restated a standing property of
                      every control on the screen, on every render, and so was
                      read as furniture within seconds — while occupying the one
                      position a seller actually looks at mid-show. Guardrails
                      now speak WHERE and WHEN they bind: the markdown control
                      shows the floor it is clamping to, the offer control
                      disables send with the reason, and a server refusal
                      surfaces as the action's own message.
                    */}
                    {auctionQuery.loading ? (
                      <p className="event-current-auction-state" role="status">Checking the authoritative auction state…</p>
                    ) : auctionQuery.error ? (
                      <div className="event-current-auction-state is-error" role="alert">
                        <span>{errorMessage(auctionQuery.error)}</span>
                        <button className="button small" type="button" onClick={auctionQuery.invalidate}>Try again</button>
                      </div>
                    ) : currentAuction ? (
                      <div className={`event-current-auction is-${currentAuction.status}`} aria-live="polite">
                        <div>
                          <span className={`event-status event-auction-status-${currentAuction.status}`}>
                            {currentAuction.status === 'active' ? 'Live auction' : 'Closed result'}
                          </span>
                          <strong>{currentAuctionItem?.title ?? currentAuction.productId}</strong>
                          <small>
                            {currentAuction.status === 'active'
                              ? `Current bid ${formatAuctionPrice(currentAuction.currentPriceCents)} · closes from server time ${new Date(currentAuction.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                              : currentAuction.winnerOrder
                                ? `Winner ${currentAuction.winnerOrder.bidderId} · ${formatAuctionPrice(currentAuction.winnerOrder.unitPriceCents)} each · recovered from the server`
                                : 'Closed without a winning bid · recovered from the server'}
                          </small>
                        </div>
                        {currentAuction.status === 'active' ? (
                          <button
                            className="button secondary"
                            type="button"
                            disabled={busyProductId === currentAuction.productId}
                            onClick={closeCurrentAuction}
                          >
                            {busyProductId === currentAuction.productId ? 'Closing…' : 'Close auction'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="event-manager-queue-heading">
                      <div>
                        <p className="eyebrow">Event lineup</p>
                        <strong>{items.length} reserved {items.length === 1 ? 'item' : 'items'} ready for the live room</strong>
                      </div>
                    </div>
                    <LineupTimelineView
                      view={runOfShowView}
                      drafts={timelineDrafts}
                      showPace={showPace}
                      saveStatus={planSaveStatus}
                      saveError={planSaveError}
                      onDraftChange={patchSlotDraft}
                      onMove={moveSlot}
                      onReorder={reorderShow}
                      onRemoveFromShow={removeFromShow}
                      onAddToShow={addToShow}
                      onSave={() => void saveRunOfShow()}
                      openProductId={openSlotProductId}
                      onToggleDrawer={(productId) => setOpenSlotProductId(
                        (current) => (current === productId ? null : productId),
                      )}
                      items={items}
                      busyProductId={busyProductId}
                      auctionWritesEnabled={auctionWritesEnabled}
                      auctionWriteDisabledReason={auctionWriteDisabledReason}
                      policy={configQuery.data?.[0]?.policy}
                      buyers={offerBuyers}
                      buyersLoading={presenceQuery.loading}
                      blockedActionKinds={configQuery.data?.[0]?.policy?.blockedActionKinds}
                      onPush={(item) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: { kind: 'push', productId: item.productId, reason: 'Seller pushed this verified item to the live stage' },
                        }),
                        `${item.title} is now on stage.`,
                      )}
                      onSwap={(current, target) => void runAction(
                        target.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'swap',
                            productId: current.productId,
                            swapToProductId: target.productId,
                            reason: 'Seller swapped the next verified item onto the live stage',
                          },
                        }),
                        `${target.title} replaced ${current.title} on stage.`,
                      )}
                      onMarkdown={(item, percent, priceCents) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'markdown',
                            productId: item.productId,
                            // The price the control PREVIEWED, not a recomputed
                            // one. This used to be Math.round(...) here while
                            // the server derives its floor with Math.ceil, so a
                            // markdown at exactly the event limit was rejected
                            // for landing a cent under the floor.
                            priceCents,
                            reason: `Seller applied a ${percent}% live-event markdown`,
                          },
                        }),
                        `${item.title} markdown passed the event guardrail.`,
                      )}
                      onStockAdjust={(item, quantity) => void runAction(
                        item.productId,
                        () => mutateStock({ eventId: selectedEventId, actorId, item, quantity }),
                        `${item.title} inventory reservation is now ${quantity}.`,
                      )}
                      onStartAuction={(item, quantity, startingPriceCents) => void runAction(
                        item.productId,
                        async () => {
                          await mutateStartAuction({ eventId: selectedEventId, item, quantity, startingPriceCents });
                          auctionQuery.invalidate();
                        },
                        `${quantity} × ${item.title} auction started.`,
                      )}
                      onSendOffer={(item, buyer, quantity, priceCents) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'targeted-offer',
                            productId: item.productId,
                            // The id the server routes on stays the id; the
                            // display name is only ever narration.
                            buyerId: buyer.buyerId,
                            quantity,
                            priceCents,
                            reason: `Seller sent ${buyer.displayName} a quantity-aware targeted offer`,
                          },
                        }),
                        `${quantity} × ${item.title} offered to ${buyer.displayName}.`,
                      )}
                    />
                    {/*
                      The standalone RunOfShowPlannerPanel mount is RETIRED
                      (D-001). Ordering, minutes and notes are no longer a
                      separate pre-show surface below the lineup — they are the
                      timeline above, which is the whole point of direction C.
                      The module itself stays for the dock, which adopts this
                      component under P-006.
                    */}
                  </>
                ) : loaded && !pickerOpen ? (
                  <div className="event-detail-empty">
                    <div>
                      <strong>This event has no reserved inventory yet.</strong>
                      <p>Add verified catalog items before opening the live room.</p>
                      <button className="button primary" type="button" onClick={() => setPickerOpen(true)}>Add inventory</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
          ) : (
            <section className="event-detail-panel event-detail-empty" aria-live="polite">
              <div>
                <strong>
                  {directoryQuery.loading
                    ? 'Loading your events…'
                    : route.eventId
                      ? 'This event is not available for this seller.'
                      : 'Create your first seller event.'}
                </strong>
                <p>
                  {directoryQuery.loading
                    ? 'Checking the verified seller event directory.'
                    : route.eventId && events.length
                      ? 'Choose another event from My events, or create a new event.'
                      : 'Reserve verified catalog inventory to start a seller event.'}
                </p>
                {!directoryQuery.loading ? (
                  <a
                    className="button primary"
                    href={eventManagerHref({ view: 'create', section: 'lineup' }, typeof window === 'undefined' ? '/' : window.location.href)}
                    onClick={openRoute({ view: 'create', section: 'lineup' })}
                  >
                    Create event
                  </a>
                ) : null}
              </div>
            </section>
          )}
        </div>
      )}

      {message ? <p className="event-manager-message" role="status">{message}</p> : null}
    </section>
  );
}

export default EventManager;

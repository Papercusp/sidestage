import { useEffect, useState } from 'react';

export type TabId = 'buyer' | 'orders' | 'seller' | 'history' | 'config' | 'test' | 'architecture';
export type StudioView = 'active-event' | 'event-manager' | 'inventory';
export type EventManagerView = 'events' | 'create';
export type EventManagerSection = 'lineup' | 'settings';

export interface EventManagerRoute {
  view: EventManagerView;
  eventId?: string;
  section: EventManagerSection;
}

export type TabGroupId = 'buyer-work' | 'operator-work';

export interface TabDefinition {
  id: TabId;
  label: string;
  description: string;
  group: TabGroupId;
}

export const TABS: ReadonlyArray<TabDefinition> = [
  { id: 'buyer', label: 'Watch', description: 'Browse the live catalog', group: 'buyer-work' },
  { id: 'orders', label: 'Orders', description: 'Review purchases and product moments', group: 'buyer-work' },
  { id: 'seller', label: 'Studio', description: 'Run the stage', group: 'operator-work' },
  { id: 'history', label: 'History', description: 'Review shipped plans', group: 'operator-work' },
  { id: 'test', label: 'Tests', description: 'Run isolated synthetic suites', group: 'operator-work' },
  { id: 'architecture', label: 'Architecture', description: 'Understand how SideStage works', group: 'operator-work' },
];

export const TAB_GROUPS: ReadonlyArray<{
  id: TabGroupId;
  label: string;
  tabs: ReadonlyArray<TabDefinition>;
}> = [
  { id: 'buyer-work', label: 'Buyer work', tabs: TABS.filter((tab) => tab.group === 'buyer-work') },
  { id: 'operator-work', label: 'Operator work', tabs: TABS.filter((tab) => tab.group === 'operator-work') },
];

function resolveTabId(value: string | null): TabId | null {
  if (value === 'config') return 'seller';
  return TABS.some((tab) => tab.id === value) ? value as TabId : null;
}

function urlFor(value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>): URL {
  if (value instanceof URL) return new URL(value.href);
  if (typeof value === 'string') return new URL(value, 'https://sidestage.local');
  return new URL(`${value.pathname}${value.search}${value.hash}`, 'https://sidestage.local');
}

/** Resolve the active tab from URL state, accepting both query and path URLs. */
export function getTabFromUrl(value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>): TabId {
  const url = urlFor(value);
  const queryTab = url.searchParams.get('tab');
  const resolvedQueryTab = resolveTabId(queryTab);
  if (resolvedQueryTab) return resolvedQueryTab;

  const pathTab = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return resolveTabId(pathTab) ?? 'buyer';
}

export function tabHref(tab: TabId, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', tab === 'config' ? 'seller' : tab);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

/** A durable link to one event on the Watch page, preserving unrelated URL state. */
export function eventWatchHref(eventId: string, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', 'buyer');
  url.searchParams.set('event', eventId);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

function isStudioView(value: string | null): value is StudioView {
  return value === 'active-event' || value === 'event-manager' || value === 'inventory';
}

export function getStudioViewFromUrl(value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>): StudioView {
  const url = urlFor(value);
  const query = url.searchParams.get('studio');
  if (isStudioView(query)) return query;
  const path = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return isStudioView(path) ? path : 'active-event';
}

export function studioViewHref(view: StudioView, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', 'seller');
  url.searchParams.set('studio', view);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

export function useUrlStudioView(): [StudioView, (view: StudioView) => void] {
  const read = () => (typeof window === 'undefined' ? 'active-event' : getStudioViewFromUrl(window.location));
  const [view, setView] = useState<StudioView>(read);
  useEffect(() => {
    const onPopState = () => setView(read());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (next: StudioView) => {
    if (typeof window === 'undefined') return;
    window.history.pushState({ tab: 'seller', studio: next }, '', studioViewHref(next, window.location.href));
    setView(next);
  };
  return [view, navigate];
}

function isEventManagerView(value: string | null): value is EventManagerView {
  return value === 'events' || value === 'create';
}

/** 'rehearse' is a retired URL value (folded into 'lineup') — kept resolvable, never valid to construct. */
function isEventManagerSection(value: string | null): value is EventManagerSection {
  return value === 'lineup' || value === 'settings';
}

/** Resolve the nested Event Manager state without interpreting Watch-page URLs. */
export function getEventManagerRouteFromUrl(
  value: string | URL | Pick<Location, 'pathname' | 'search' | 'hash'>,
): EventManagerRoute {
  const url = urlFor(value);
  const view = url.searchParams.get('manager');
  const section = url.searchParams.get('section');
  const eventId = url.searchParams.get('event')?.trim();
  return {
    view: isEventManagerView(view) ? view : 'events',
    ...(eventId ? { eventId } : {}),
    section: isEventManagerSection(section) ? section : 'lineup',
  };
}

export function eventManagerHref(route: EventManagerRoute, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', 'seller');
  url.searchParams.set('studio', 'event-manager');
  url.searchParams.set('manager', route.view);
  if (route.eventId) url.searchParams.set('event', route.eventId);
  else url.searchParams.delete('event');
  if (route.view === 'events') url.searchParams.set('section', route.section);
  else url.searchParams.delete('section');
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
}

export function useUrlEventManagerRoute(): [EventManagerRoute, (route: EventManagerRoute) => void] {
  const read = () => (typeof window === 'undefined'
    ? { view: 'events', section: 'lineup' } as EventManagerRoute
    : getEventManagerRouteFromUrl(window.location));
  const [route, setRoute] = useState<EventManagerRoute>(read);

  useEffect(() => {
    const onPopState = () => setRoute(read());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (next: EventManagerRoute) => {
    if (typeof window === 'undefined') return;
    window.history.pushState(
      { tab: 'seller', studio: 'event-manager', manager: next.view, event: next.eventId, section: next.section },
      '',
      eventManagerHref(next, window.location.href),
    );
    setRoute(next);
  };

  return [route, navigate];
}


export function useUrlTab(): [TabId, (tab: TabId) => void] {
  const read = () => (typeof window === 'undefined' ? 'buyer' : getTabFromUrl(window.location));
  const [tab, setTab] = useState<TabId>(read);

  useEffect(() => {
    const onPopState = () => setTab(read());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (nextTab: TabId) => {
    if (typeof window === 'undefined') return;
    window.history.pushState({ tab: nextTab }, '', tabHref(nextTab, window.location.href));
    setTab(nextTab);
  };

  return [tab, navigate];
}

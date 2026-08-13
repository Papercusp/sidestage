import { useEffect, useState } from 'react';

export type TabId = 'buyer' | 'seller' | 'config' | 'test';

export const TABS: ReadonlyArray<{ id: TabId; label: string; description: string }> = [
  { id: 'buyer', label: 'Buyer', description: 'Browse the live catalog' },
  { id: 'seller', label: 'Seller', description: 'Run the stage' },
  { id: 'config', label: 'Config', description: 'Set event guardrails' },
  { id: 'test', label: 'Test', description: 'Check your setup' },
];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
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
  if (isTabId(queryTab)) return queryTab;

  const pathTab = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return isTabId(pathTab) ? pathTab : 'buyer';
}

export function tabHref(tab: TabId, currentUrl = '/'): string {
  const url = urlFor(currentUrl);
  url.searchParams.set('tab', tab);
  return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
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

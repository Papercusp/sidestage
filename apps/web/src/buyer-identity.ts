import { useCallback, useEffect, useState } from 'react';

export const BUYER_ID_STORAGE_KEY = 'sidestage-buyer-id';
export const BUYER_ID_CHANGED_EVENT = 'sidestage:buyer-id-changed';
export const SERVER_BUYER_ID = 'buyer-server-render';

export interface BuyerIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BuyerIdentityOptions {
  storage?: BuyerIdentityStorage | null;
  randomId?: () => string;
  announce?: (buyerId: string) => void;
}

function browserStorage(): BuyerIdentityStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // A blocked/private localStorage must not make the demo unusable. The
    // current tab still gets an identity; only reload persistence is lost.
    return null;
  }
}

function generatedBuyerId(): string {
  const token = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `buyer-${token}`;
}

/**
 * D-013 deliberately permits every non-empty id. Trimming the edges avoids a
 * user accidentally impersonating " alice " while preserving spaces,
 * punctuation, unicode, and every other character inside the id.
 */
export function normalizeBuyerIdentity(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readBuyerIdentity(options: BuyerIdentityOptions = {}): string {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  try {
    const existing = normalizeBuyerIdentity(storage?.getItem(BUYER_ID_STORAGE_KEY) ?? '');
    if (existing) return existing;
  } catch {
    // Fall through to a usable in-memory identity.
  }

  if (!storage && typeof window === 'undefined' && !options.randomId) return SERVER_BUYER_ID;

  const created = `buyer-${(options.randomId ?? (() => generatedBuyerId().slice('buyer-'.length)))()}`;
  try {
    storage?.setItem(BUYER_ID_STORAGE_KEY, created);
  } catch {
    // The id still works for this page even when persistence is unavailable.
  }
  return created;
}

function announceBrowserIdentity(buyerId: string): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(BUYER_ID_CHANGED_EVENT, { detail: buyerId }));
}

/** Persist an arbitrary non-empty demo id and announce it to mounted surfaces. */
export function writeBuyerIdentity(value: string, options: BuyerIdentityOptions = {}): string | null {
  const buyerId = normalizeBuyerIdentity(value);
  if (!buyerId) return null;

  const storage = options.storage === undefined ? browserStorage() : options.storage;
  try {
    storage?.setItem(BUYER_ID_STORAGE_KEY, buyerId);
  } catch {
    // Keep the current tab functional even when the browser refuses storage.
  }
  (options.announce ?? announceBrowserIdentity)(buyerId);
  return buyerId;
}

/**
 * One app-wide identity hook shared by BuyerTab and the Orders tab. Custom
 * events update this window immediately; the storage event keeps other tabs in
 * step. No auth/session semantics are implied — this is the D-013 demo seam.
 */
export function useBuyerIdentity(): {
  buyerId: string;
  impersonate: (value: string) => string | null;
} {
  const [buyerId, setBuyerId] = useState(() => readBuyerIdentity());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onIdentityChange = (event: Event) => {
      const next = normalizeBuyerIdentity((event as CustomEvent<string>).detail ?? '');
      if (next) setBuyerId(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== BUYER_ID_STORAGE_KEY) return;
      const next = normalizeBuyerIdentity(event.newValue ?? '');
      if (next) setBuyerId(next);
    };
    window.addEventListener(BUYER_ID_CHANGED_EVENT, onIdentityChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(BUYER_ID_CHANGED_EVENT, onIdentityChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const impersonate = useCallback((value: string) => {
    const next = writeBuyerIdentity(value);
    if (next) setBuyerId(next);
    return next;
  }, []);

  return { buyerId, impersonate };
}

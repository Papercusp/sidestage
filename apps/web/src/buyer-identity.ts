import { useCallback, useEffect, useState } from 'react';

export const DEMO_IDENTITY_STORAGE_KEY = 'sidestage-demo-user-id';
export const DEMO_IDENTITY_CHANGED_EVENT = 'sidestage:demo-user-id-changed';
export const SERVER_DEMO_USER_ID = 'demo-server-render';

/** Legacy names remain exported while buyer-only call sites migrate. */
export const BUYER_ID_STORAGE_KEY = 'sidestage-buyer-id';
export const BUYER_ID_CHANGED_EVENT = 'sidestage:buyer-id-changed';
export const SERVER_BUYER_ID = 'buyer-server-render';

export interface DemoIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DemoIdentityOptions {
  storage?: DemoIdentityStorage | null;
  randomId?: () => string;
  announce?: (userId: string) => void;
}

export type BuyerIdentityStorage = DemoIdentityStorage;
export type BuyerIdentityOptions = DemoIdentityOptions;

function browserStorage(): DemoIdentityStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // A blocked/private localStorage must not make the demo unusable. The
    // current tab still gets an identity; only reload persistence is lost.
    return null;
  }
}

function generatedDemoUserId(): string {
  const token = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `demo-${token}`;
}

/**
 * D-013 deliberately permits every non-empty id. Trimming the edges avoids a
 * user accidentally impersonating " alice " while preserving spaces,
 * punctuation, unicode, and every other character inside the id.
 */
export function normalizeDemoIdentity(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readStoredIdentity(
  storage: DemoIdentityStorage | null,
  key: string,
): string | null {
  try {
    return normalizeDemoIdentity(storage?.getItem(key) ?? '');
  } catch {
    return null;
  }
}

function persistIdentity(storage: DemoIdentityStorage | null, userId: string): void {
  for (const key of [DEMO_IDENTITY_STORAGE_KEY, BUYER_ID_STORAGE_KEY]) {
    try {
      storage?.setItem(key, userId);
    } catch {
      // The id still works for this page even when persistence is unavailable.
    }
  }
}

export function readDemoIdentity(options: DemoIdentityOptions = {}): string {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const existing = readStoredIdentity(storage, DEMO_IDENTITY_STORAGE_KEY);
  if (existing) return existing;

  // One-way migration from the buyer-only D-013 seam. Mirroring the value into
  // the canonical key preserves every existing demo user across this upgrade.
  const legacyBuyerId = readStoredIdentity(storage, BUYER_ID_STORAGE_KEY);
  if (legacyBuyerId) {
    persistIdentity(storage, legacyBuyerId);
    return legacyBuyerId;
  }

  if (!storage && typeof window === 'undefined' && !options.randomId) return SERVER_DEMO_USER_ID;

  const created = `demo-${(options.randomId ?? (() => generatedDemoUserId().slice('demo-'.length)))()}`;
  persistIdentity(storage, created);
  return created;
}

function announceBrowserIdentity(userId: string): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(DEMO_IDENTITY_CHANGED_EVENT, { detail: userId }));
  // Keep already-mounted buyer-only surfaces in sync during hot upgrades.
  window.dispatchEvent(new CustomEvent<string>(BUYER_ID_CHANGED_EVENT, { detail: userId }));
}

/** Persist an arbitrary non-empty demo id and announce it to mounted surfaces. */
export function writeDemoIdentity(value: string, options: DemoIdentityOptions = {}): string | null {
  const userId = normalizeDemoIdentity(value);
  if (!userId) return null;

  const storage = options.storage === undefined ? browserStorage() : options.storage;
  persistIdentity(storage, userId);
  (options.announce ?? announceBrowserIdentity)(userId);
  return userId;
}

/**
 * One app-wide identity hook shared by buyer and seller surfaces. Custom events
 * update this window immediately; storage events keep other tabs in step. No
 * auth/session semantics are implied — this is the D-013 demo seam.
 */
export function useDemoIdentity(): {
  userId: string;
  impersonate: (value: string) => string | null;
} {
  const [userId, setUserId] = useState(() => readDemoIdentity());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onIdentityChange = (event: Event) => {
      const next = normalizeDemoIdentity((event as CustomEvent<string>).detail ?? '');
      if (next) setUserId(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DEMO_IDENTITY_STORAGE_KEY && event.key !== BUYER_ID_STORAGE_KEY) return;
      const next = normalizeDemoIdentity(event.newValue ?? '');
      if (next) setUserId(next);
    };
    window.addEventListener(DEMO_IDENTITY_CHANGED_EVENT, onIdentityChange);
    window.addEventListener(BUYER_ID_CHANGED_EVENT, onIdentityChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DEMO_IDENTITY_CHANGED_EVENT, onIdentityChange);
      window.removeEventListener(BUYER_ID_CHANGED_EVENT, onIdentityChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const impersonate = useCallback((value: string) => {
    const next = writeDemoIdentity(value);
    if (next) setUserId(next);
    return next;
  }, []);

  return { userId, impersonate };
}

/** Buyer compatibility aliases; all delegate to the one canonical identity. */
export const normalizeBuyerIdentity = normalizeDemoIdentity;
export const readBuyerIdentity = readDemoIdentity;
export const writeBuyerIdentity = writeDemoIdentity;

export function useBuyerIdentity(): {
  buyerId: string;
  impersonate: (value: string) => string | null;
} {
  const { userId, impersonate } = useDemoIdentity();
  return { buyerId: userId, impersonate };
}

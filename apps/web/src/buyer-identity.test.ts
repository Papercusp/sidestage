import { describe, expect, it, vi } from 'vitest';

import {
  BUYER_ID_STORAGE_KEY,
  DEMO_IDENTITY_STORAGE_KEY,
  normalizeDemoIdentity,
  normalizeBuyerIdentity,
  readDemoIdentity,
  readBuyerIdentity,
  writeDemoIdentity,
  writeBuyerIdentity,
  type BuyerIdentityStorage,
} from './buyer-identity';

class MemoryStorage implements BuyerIdentityStorage {
  readonly rows = new Map<string, string>();

  getItem(key: string): string | null {
    return this.rows.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.rows.set(key, value);
  }
}

describe('shared demo identity', () => {
  it('reuses the canonical app-wide id across reloads', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEMO_IDENTITY_STORAGE_KEY, 'avi-demo');

    expect(readDemoIdentity({ storage, randomId: () => 'unused' })).toBe('avi-demo');
  });

  it('migrates the buyer-only key without changing the current user', () => {
    const storage = new MemoryStorage();
    storage.setItem(BUYER_ID_STORAGE_KEY, 'legacy-buyer');

    expect(readDemoIdentity({ storage, randomId: () => 'unused' })).toBe('legacy-buyer');
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('legacy-buyer');
  });

  it('creates and persists a stable id for a first-time demo user', () => {
    const storage = new MemoryStorage();

    expect(readDemoIdentity({ storage, randomId: () => 'abc12345' })).toBe('demo-abc12345');
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('demo-abc12345');
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('demo-abc12345');
  });

  it('accepts any non-empty demo id and announces the switch', () => {
    const storage = new MemoryStorage();
    const announce = vi.fn();

    expect(writeDemoIdentity('  Team A / seller #42 🛍️  ', { storage, announce })).toBe('Team A / seller #42 🛍️');
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('Team A / seller #42 🛍️');
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('Team A / seller #42 🛍️');
    expect(announce).toHaveBeenCalledWith('Team A / seller #42 🛍️');
  });

  it('keeps buyer compatibility aliases on the canonical identity', () => {
    const storage = new MemoryStorage();
    const announce = vi.fn();

    expect(writeBuyerIdentity('  buyer-alias  ', { storage, announce })).toBe('buyer-alias');
    expect(readBuyerIdentity({ storage })).toBe('buyer-alias');
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('buyer-alias');
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('buyer-alias');
    expect(announce).toHaveBeenCalledWith('buyer-alias');
    expect(normalizeBuyerIdentity).toBe(normalizeDemoIdentity);
  });

  it('rejects only an empty id and preserves the current identity', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEMO_IDENTITY_STORAGE_KEY, 'still-me');
    const announce = vi.fn();

    expect(normalizeDemoIdentity(' \n\t ')).toBeNull();
    expect(writeDemoIdentity(' \n\t ', { storage, announce })).toBeNull();
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('still-me');
    expect(announce).not.toHaveBeenCalled();
  });
});

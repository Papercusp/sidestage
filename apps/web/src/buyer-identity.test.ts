import { describe, expect, it, vi } from 'vitest';

import {
  BUYER_ID_STORAGE_KEY,
  normalizeBuyerIdentity,
  readBuyerIdentity,
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

describe('demo buyer identity', () => {
  it('reuses the persisted id across reloads', () => {
    const storage = new MemoryStorage();
    storage.setItem(BUYER_ID_STORAGE_KEY, 'avi-demo');

    expect(readBuyerIdentity({ storage, randomId: () => 'unused' })).toBe('avi-demo');
  });

  it('creates and persists a stable id for a first-time buyer', () => {
    const storage = new MemoryStorage();

    expect(readBuyerIdentity({ storage, randomId: () => 'abc12345' })).toBe('buyer-abc12345');
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('buyer-abc12345');
  });

  it('accepts any non-empty demo id and announces the switch', () => {
    const storage = new MemoryStorage();
    const announce = vi.fn();

    expect(writeBuyerIdentity('  Team A / buyer #42 🛍️  ', { storage, announce })).toBe('Team A / buyer #42 🛍️');
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('Team A / buyer #42 🛍️');
    expect(announce).toHaveBeenCalledWith('Team A / buyer #42 🛍️');
  });

  it('rejects only an empty id and preserves the current identity', () => {
    const storage = new MemoryStorage();
    storage.setItem(BUYER_ID_STORAGE_KEY, 'still-me');
    const announce = vi.fn();

    expect(normalizeBuyerIdentity(' \n\t ')).toBeNull();
    expect(writeBuyerIdentity(' \n\t ', { storage, announce })).toBeNull();
    expect(storage.getItem(BUYER_ID_STORAGE_KEY)).toBe('still-me');
    expect(announce).not.toHaveBeenCalled();
  });
});

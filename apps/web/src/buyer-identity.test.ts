import { describe, expect, it, vi } from 'vitest';

import {
  BUYER_ID_STORAGE_KEY,
  DEMO_IDENTITY_STORAGE_KEY,
  normalizeDemoIdentity,
  normalizeBuyerIdentity,
  normalizeRoleDemoIdentity,
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
    expect(normalizeBuyerIdentity('seller-alias')).toBe('buyer-alias');
  });

  it('projects one stored persona into distinct buyer and seller identities', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEMO_IDENTITY_STORAGE_KEY, 'buyer-avi');

    expect(readDemoIdentity({ storage }, 'buyer')).toBe('buyer-avi');
    expect(readDemoIdentity({ storage }, 'seller')).toBe('seller-avi');
    expect(normalizeRoleDemoIdentity(' seller-Team A ', 'buyer')).toBe('buyer-Team A');
  });

  it('preserves the catalog seed owner only on the seller surface', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEMO_IDENTITY_STORAGE_KEY, 'demo-seller');

    expect(readDemoIdentity({ storage }, 'seller')).toBe('demo-seller');
    expect(readDemoIdentity({ storage }, 'buyer')).toBe('buyer-demo-seller');
    expect(normalizeRoleDemoIdentity('demo-seller', 'seller')).toBe('demo-seller');
  });

  it('enforces a role prefix when a scoped identity is written', () => {
    const storage = new MemoryStorage();
    const announce = vi.fn();

    expect(writeDemoIdentity('avi', { storage, announce }, 'seller')).toBe('seller-avi');
    expect(storage.getItem(DEMO_IDENTITY_STORAGE_KEY)).toBe('seller-avi');
    expect(announce).toHaveBeenCalledWith('seller-avi');
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

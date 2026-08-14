import { randomUUID } from 'node:crypto';
import type { ScoutMemory, ScoutMemoryStore } from './scout.types';

/**
 * Memory scopes for one scout turn (ported from Restart's `memory-scopes.ts`).
 *
 * A buyer with a resolved identity reads + writes their own `user:<id>` scope
 * plus the shared `store` scope; a guest reads only `store` and writes NOWHERE
 * (`writeScope` null). That write asymmetry is the isolation rule: without it,
 * every anonymous visitor would pour their turns into one shared bucket that
 * every other visitor then recalls.
 */
export const STORE_SCOPE = 'store';

export function memoryScopes(buyerId?: string | null): {
  scopes: string[];
  writeScope: string | null;
} {
  const trimmed = buyerId?.trim();
  const writeScope = trimmed ? `user:${trimmed}` : null;
  return { scopes: writeScope ? [writeScope, STORE_SCOPE] : [STORE_SCOPE], writeScope };
}

/**
 * Split text into lowercase word tokens for lexical matching.
 *
 * Deliberately shared by catalog retrieval, memory retrieval, the scorer, and
 * their tests so "why did this not match" is answerable without parallel
 * tokenizers drifting apart.
 */
export function memoryTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * How well `text` answers `query`, as the fraction of DISTINCT query tokens it
 * contains (0..1).
 *
 * Normalizing by the QUERY's token count, not the text's, is what stops a long
 * rambling memory from out-ranking a short exact one: a memory that contains
 * every query word scores 1 whether it is five words or fifty. Ties are broken
 * by recency at the call site, so the newest of two equally-good memories wins.
 */
export function memoryScore(text: string, query: string): number {
  const wanted = new Set(memoryTokens(query));
  if (wanted.size === 0) return 0;
  const have = new Set(memoryTokens(text));
  let hits = 0;
  for (const token of wanted) if (have.has(token)) hits += 1;
  return hits / wanted.size;
}

/**
 * Non-durable memory — the fallback when Postgres is not reachable, mirroring
 * the session store's seam so a clone without a database still boots (memories
 * simply do not survive a restart).
 *
 * Ranks by the same lexical score as the Postgres implementation so a turn
 * behaves the same either side of the seam; only durability differs.
 */
export class InMemoryScoutMemoryStore implements ScoutMemoryStore {
  private readonly rows: Array<ScoutMemory & { at: number }> = [];

  async remember(scope: string, text: string, kind = 'fact'): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !scope) return;
    this.rows.push({ id: randomUUID(), scope, kind, text: trimmed, at: this.rows.length });
  }

  async recall(scopes: readonly string[], query: string, k = 5): Promise<ScoutMemory[]> {
    const trimmed = query.trim();
    if (scopes.length === 0 || !trimmed) return [];
    const wanted = new Set(scopes);
    return this.rows
      .filter((row) => wanted.has(row.scope))
      .map((row) => ({ row, score: memoryScore(row.text, trimmed) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.row.at - a.row.at)
      .slice(0, Math.max(1, k))
      .map(({ row }) => ({ id: row.id, scope: row.scope, kind: row.kind, text: row.text }));
  }
}

/**
 * A memory store that does nothing, used when memory is switched off.
 *
 * Having an explicit null object (rather than an optional dependency the
 * service null-checks at every call site) keeps the degrade path on ONE code
 * path — the one that is exercised by every test — instead of a branch that
 * only runs in the configuration nobody tests.
 */
export class DisabledScoutMemoryStore implements ScoutMemoryStore {
  async remember(): Promise<void> {
    /* memory disabled */
  }

  async recall(): Promise<ScoutMemory[]> {
    return [];
  }
}

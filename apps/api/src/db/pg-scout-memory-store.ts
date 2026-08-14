import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { memoryTokens } from '../scout/scout-memory';
import type { ScoutMemory, ScoutMemoryStore } from '../scout/scout.types';

interface MemoryRow {
  id: string;
  scope: string;
  kind: string;
  text: string;
}

/**
 * Durable scout memory over Postgres full-text + trigram search (D-008).
 *
 * Restart's equivalent recalls by pgvector cosine distance over OpenAI
 * embeddings. SideStage's database has neither — `pg_available_extensions` has
 * no `vector` row, and `TYPESENSE_EMBEDDING_PROVIDER` is `none` — so this ports
 * the CONTRACT onto the retrieval machinery the schema already uses (`pg_trgm`
 * + a `tsvector` column with a trigger, exactly as `product_catalog` does).
 * The seam is what keeps that reversible: an embedding-backed store can replace
 * this class without the service noticing.
 *
 * Every method is failure-swallowing by contract — see `ScoutMemoryStore`.
 */
export class PgScoutMemoryStore implements ScoutMemoryStore {
  /** Hard ceiling on a recall round-trip. Memory must never stall a turn. */
  static readonly RECALL_TIMEOUT_MS = 2000;

  constructor(
    private readonly pool: Pool,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  async remember(scope: string, text: string, kind = 'fact'): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !scope) return;
    try {
      await this.pool.query(
        `INSERT INTO scout_memory (id, scope, kind, text) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), scope, kind, trimmed],
      );
    } catch (err) {
      this.onError(`scout memory write dropped: ${describe(err)}`);
    }
  }

  /**
   * Top-k memories in `scopes` matching `query`.
   *
   * The query text is reduced to `[a-z0-9]+` tokens in JS and passed as a text
   * ARRAY, then joined with `|` inside `to_tsquery`. Two reasons, both load-
   * bearing:
   *  - OR, not AND. `plainto_tsquery` ANDs every term, so a five-word question
   *    would only recall a memory containing all five — which is essentially
   *    never, and the failure is silent (recall just returns nothing).
   *  - Injection safety. `to_tsquery` parses its input as query SYNTAX, so raw
   *    user text there is both a crash risk (`&`, `!`, unbalanced parens throw)
   *    and an injection surface. Alphanumeric tokens cannot express syntax.
   */
  async recall(scopes: readonly string[], query: string, k = 5): Promise<ScoutMemory[]> {
    const tokens = memoryTokens(query);
    if (scopes.length === 0 || tokens.length === 0) return [];
    try {
      const result = await withTimeout(
        this.pool.query<MemoryRow>(
          `WITH q AS (SELECT to_tsquery('english', array_to_string($2::text[], ' | ')) AS tsq)
           SELECT m.id, m.scope, m.kind, m.text
             FROM scout_memory m, q
            WHERE m.scope = ANY($1::text[])
              AND (m.search_tsv @@ q.tsq OR m.text % $3)
            ORDER BY (ts_rank(m.search_tsv, q.tsq) + similarity(m.text, $3)) DESC,
                     m.created_at DESC
            LIMIT $4`,
          [[...scopes], tokens, query.trim(), Math.max(1, k)],
        ),
        PgScoutMemoryStore.RECALL_TIMEOUT_MS,
      );
      return result.rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        kind: row.kind,
        text: row.text,
      }));
    } catch (err) {
      this.onError(`scout memory recall degraded to none: ${describe(err)}`);
      return [];
    }
  }
}

/**
 * Reject after `ms`.
 *
 * A pool that is merely SLOW (saturated, or a lock wait) is the case this
 * exists for: it never rejects on its own, so without a ceiling a degraded
 * database turns "memory is an enhancement" into "every reply hangs".
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

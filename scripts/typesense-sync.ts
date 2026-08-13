/**
 * typesense-sync.ts — Build/refresh the SideStage Typesense catalog index.
 *
 * The SAME search the Restart wholesale grid uses (@papercusp/typesense,
 * ported per the spec): one document per product group, min/max price across
 * variants, conditions facet, volume tiers — bulk-upserted in batches with
 * transient-error retry. Reads Postgres directly (keyset pagination ordered so
 * every group's variants arrive contiguously; the 1.1M-row catalog never sits
 * in memory at once).
 *
 *   DATABASE_URL=postgres://… TYPESENSE_API_KEY=… npx tsx scripts/typesense-sync.ts
 */
import { Pool } from 'pg';
import { typesenseService, type StorefrontDoc } from '@papercusp/typesense';

const BATCH_ROWS = 5_000;
const IMPORT_BATCH = 250;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    ?? 'postgresql://sidestage:dev-only-change-me@localhost:5432/sidestage',
  max: 4,
});

async function retryCall<T>(fn: () => Promise<T>, label = 'op', attempt = 0): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const anyErr = err as { httpStatus?: number; status?: number; code?: string; cause?: { code?: string }; name?: string; message?: string };
    const status = anyErr?.httpStatus ?? anyErr?.status;
    const code = anyErr?.cause?.code ?? anyErr?.code;
    const transient = code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET'
      || anyErr?.name === 'TypeError'
      || (typeof status === 'number' && status >= 500 && status < 600);
    if (!transient || attempt >= 10) throw err;
    const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
    console.log(`  ⚠ ${label} failed (${code ?? status ?? anyErr?.message}); retry in ${backoffMs}ms (${attempt + 1}/10)`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return retryCall(fn, label, attempt + 1);
  }
}

interface Row {
  id: string;
  slug: string;
  price_cents: number;
  group_id: string | null;
  condition: string | null;
  qty: number;
  available_qty: number;
  group_key: string;
  title: string | null;
  description: string | null;
  brand: string | null;
  product_type: string | null;
  images: Array<{ url: string; isPrimary?: boolean }> | null;
  tiers: (number | null)[] | null;
}

function docFrom(rows: Row[]): StorefrontDoc {
  const first = rows[0];
  const images = first.images ?? [];
  const prices = rows.map((row) => row.price_cents ?? 0);
  const conditions = [...new Set(rows.map((row) => (row.condition ?? '').trim().toUpperCase()).filter(Boolean))];
  const qty = rows.reduce((sum, row) => sum + Math.max(0, row.available_qty ?? 0), 0);
  const [tier1, tier2, tier3, tier4, tier5, tier1Discount, tier2Discount, tier3Discount, tier4Discount, tier5Discount] = first.tiers ?? [];
  return {
    id: first.group_key,
    slug: first.slug,
    name: first.title ?? '',
    description: (first.description ?? '').slice(0, 2000),
    brand: first.brand && first.brand !== 'Unknown' ? first.brand : '',
    category: first.product_type ?? '',
    imageUrl: images.find((image) => image.isPrimary)?.url ?? images[0]?.url ?? '',
    active: true,
    groupId: first.group_id ?? undefined,
    priceCents: Math.min(...prices),
    minPriceCents: Math.min(...prices),
    maxPriceCents: Math.max(...prices),
    conditions,
    qty,
    ...(tier1 != null ? { tier1, tier2: tier2 ?? undefined, tier3: tier3 ?? undefined, tier4: tier4 ?? undefined, tier5: tier5 ?? undefined, tier1Discount: tier1Discount ?? undefined, tier2Discount: tier2Discount ?? undefined, tier3Discount: tier3Discount ?? undefined, tier4Discount: tier4Discount ?? undefined, tier5Discount: tier5Discount ?? undefined } : {}),
  } as StorefrontDoc;
}

async function main() {
  console.log('==> ensureCollection');
  await retryCall(() => typesenseService.ensureCollection(), 'ensureCollection');

  let lastKey = '';
  let lastId = '';
  let carry: Row[] = [];
  let docs: StorefrontDoc[] = [];
  let imported = 0;

  const flushDocs = async (force = false) => {
    while (docs.length >= IMPORT_BATCH || (force && docs.length > 0)) {
      const batch = docs.splice(0, IMPORT_BATCH);
      await retryCall(() => typesenseService.indexDocuments(batch), `import@${imported}`);
      imported += batch.length;
      if (imported % 25_000 < IMPORT_BATCH) console.log(`  … ${imported.toLocaleString()} groups indexed`);
    }
  };

  for (;;) {
    const { rows } = await pool.query<Row>(
      `SELECT v.id, v.slug, v.price_cents, v.group_id, v.condition, v.qty,
              v."availableQty" AS available_qty,
              COALESCE(v.group_id, v.id) AS group_key,
              c.title, c.description, c.brand, c.product_type,
              c.images,
              ARRAY[c.tier_1, c.tier_2, c.tier_3, c.tier_4, c.tier_5,
                    c.tier_1_discount, c.tier_2_discount, c.tier_3_discount,
                    c.tier_4_discount, c.tier_5_discount] AS tiers
       FROM storefront_product v
       LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region
       WHERE v.active AND (COALESCE(v.group_id, v.id), v.id) > ($1, $2)
       ORDER BY COALESCE(v.group_id, v.id), v.id
       LIMIT $3`,
      [lastKey, lastId, BATCH_ROWS],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      if (carry.length > 0 && carry[0].group_key !== row.group_key) {
        docs.push(docFrom(carry));
        carry = [];
      }
      carry.push(row);
    }
    await flushDocs();
    lastKey = rows[rows.length - 1].group_key;
    lastId = rows[rows.length - 1].id;
  }
  if (carry.length > 0) docs.push(docFrom(carry));
  await flushDocs(true);

  console.log(`==> Done: ${imported.toLocaleString()} group documents indexed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

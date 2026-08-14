import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

import { describe, expect, it } from 'vitest';

import { DEMO_CATALOG_FIXTURE } from './catalog.fixture';
import { catalogSourceForPool } from './catalog.module';
import {
  EVENT_DEMO_COLLECTION,
  FixtureCatalogSource,
  UnavailableCatalogSource,
} from './catalog.sources';
import type { CatalogVariant } from './catalog.types';

/** db/seed/demo.sql, from the repo root (this file is apps/api/src/catalog/). */
const DEMO_SQL = readFileSync(join(__dirname, '../../../../db/seed/demo.sql'), 'utf8');

interface SeededVariant {
  id: string;
  sku: string;
  priceCents: number;
  groupId: string;
  condition: string;
  handling: number;
  optionSignature: string;
  imageUrl: string;
}

interface EventDemoManifestRow {
  productNumber: number;
  title: string;
  productType: string;
  brand: string;
  basePriceCents: number;
}

function eventDemoManifest(sql: string): EventDemoManifestRow[] {
  const section = sql.match(
    /-- BEGIN EVENT_DEMO_MANIFEST[\s\S]*?\n([\s\S]*?)-- END EVENT_DEMO_MANIFEST/,
  )?.[1] ?? '';
  const row = /^\s*\((\d+),\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+)\)[,;]?$/gm;
  return [...section.matchAll(row)].map((match) => ({
    productNumber: Number(match[1]),
    title: match[2],
    productType: match[3],
    brand: match[4],
    basePriceCents: Number(match[5]),
  }));
}

/**
 * The demo variant rows as db/seed/demo.sql itself declares them. Only the
 * `demo-` ids: the same INSERT also seeds the hoodie/mug/tote rows that exist
 * to cover the two-axis, sold-out and no-option cases.
 */
function seededDemoVariants(sql: string): SeededVariant[] {
  const row = /^\s*\('(demo-[a-z0-9-]+)',\s*'[^']*',\s*'US',\s*'([A-Z0-9-]+)',\s*(\d+),\s*true,\s*'([a-z0-9-]+)',\s*'([A-Z]+)',\s*(\d+),\s*'([^']*)',\s*'(\[[^']+\])'/gm;
  return [...sql.matchAll(row)].map((match) => {
    const images = JSON.parse(match[8]) as Array<{ url?: string }>;
    return {
      id: match[1],
      sku: match[2],
      priceCents: Number(match[3]),
      groupId: match[4],
      condition: match[5],
      handling: Number(match[6]),
      optionSignature: match[7],
      imageUrl: images[0]?.url ?? '',
    };
  });
}

function byGroup(variants: readonly CatalogVariant[]): Map<string, CatalogVariant[]> {
  const groups = new Map<string, CatalogVariant[]>();
  for (const variant of variants) {
    const key = variant.groupId ?? variant.id;
    groups.set(key, [...(groups.get(key) ?? []), variant]);
  }
  return groups;
}

/** 'Matte Black' -> 'matte-black', the option_signature value slug. */
function slugify(label: string): string {
  return label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

describe('the demo catalog sells on a COLOUR axis', () => {
  /**
   * The point of the fixture. Restart's variants split on a resale grade and a
   * handling time; SideStage sells a seller's own stock, where the buyer picks
   * a colour. Before WI-38716 both headphone rows carried NEW/2d, so the
   * inventory picker rendered the two variants as the same line twice.
   */
  it('gives every demo variant a colour', () => {
    const colourless = DEMO_CATALOG_FIXTURE.filter((variant) => !variant.color);
    expect(colourless.map((variant) => variant.id)).toEqual([]);
  });

  it('distinguishes the variants within a product group by colour ALONE', () => {
    for (const [groupId, variants] of byGroup(DEMO_CATALOG_FIXTURE)) {
      const colours = variants.map((variant) => variant.color);
      expect(new Set(colours).size, `${groupId} repeats a colour`).toBe(variants.length);

      // Anything else that differs inside a group is a second axis competing
      // with colour to explain why there are two rows. Condition and handling
      // are import-compatibility columns, so they must be constant here.
      expect(new Set(variants.map((v) => v.condition)).size, `${groupId} varies condition`).toBe(1);
      expect(new Set(variants.map((v) => v.handlingDays)).size, `${groupId} varies handling`).toBe(1);
    }
  });

  it('shows each colourway its own photo rather than one shared group image', () => {
    const images = DEMO_CATALOG_FIXTURE.map((variant) => variant.imageUrl);
    expect(new Set(images).size).toBe(DEMO_CATALOG_FIXTURE.length);
  });

  it('ships every demo photo as a project-owned, non-trivial WebP asset', () => {
    for (const variant of DEMO_CATALOG_FIXTURE) {
      const imageUrl = variant.imageUrl ?? '';
      expect(imageUrl).toMatch(/^\/demo-products\/[a-z0-9-]+\.webp$/);

      const image = readFileSync(join(
        __dirname,
        '../../../../apps/web/public',
        imageUrl.replace(/^\//, ''),
      ));
      expect(image.byteLength, `${variant.id} is suspiciously small`).toBeGreaterThan(20_000);
      expect(image.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(image.subarray(8, 12).toString('ascii')).toBe('WEBP');
    }
  });

  it('finds a variant by its colour, so a seller can search "walnut"', async () => {
    const source = new FixtureCatalogSource();
    const page = await source.search({ q: 'walnut' });

    expect(page.rows.map((variant) => variant.id)).toEqual(['demo-desk-walnut']);
    expect(page.rows[0].color).toBe('Walnut');
  });
});

describe('catalog source selection', () => {
  it('seeds fixtures only in development or explicit memory mode', () => {
    expect(catalogSourceForPool(null, { NODE_ENV: 'development' })).toBeInstanceOf(FixtureCatalogSource);
    expect(catalogSourceForPool(null, { NODE_ENV: 'production', DATA_BACKEND: 'memory' }))
      .toBeInstanceOf(FixtureCatalogSource);
  });

  it('rejects reads instead of fabricating inventory when production durable storage is unavailable', async () => {
    const source = catalogSourceForPool(null, { NODE_ENV: 'production', DATA_BACKEND: 'auto' });

    expect(source).toBeInstanceOf(UnavailableCatalogSource);
    await expect(source.search({})).rejects.toThrow('durable catalog storage is not connected');
    await expect(source.productTypes()).rejects.toThrow('durable catalog storage is not connected');
    await expect(source.variant('demo-espresso-matte-black')).rejects.toThrow('durable catalog storage is not connected');
  });

  it.each([
    ['production', 'the unscoped real corpus', [10_001], [6, 0]],
    [
      'development',
      'the curated demo collection',
      [EVENT_DEMO_COLLECTION, 10_001],
      [EVENT_DEMO_COLLECTION, 6, 0],
    ],
  ] as const)('uses %s durable storage with %s', async (nodeEnv, _description, expectedCountParams, expectedPageParams) => {
    const observedParams: unknown[][] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        observedParams.push([...params]);
        return observedParams.length === 1 ? { rows: [{ n: '6' }] } : { rows: [] };
      },
    } as unknown as Pool;

    const source = catalogSourceForPool(pool, { NODE_ENV: nodeEnv });
    await source.search({ availability: 'in-stock', pageSize: 6 });

    expect(observedParams[0]).toEqual(expectedCountParams);
    expect(observedParams[1]).toEqual(expectedPageParams);
  });
});

describe('DEMO_CATALOG_FIXTURE tracks db/seed/demo.sql', () => {
  /**
   * The same eight products exist in three places — this fixture (memory
   * mode), db/seed/demo.sql (a seeded database) and the web app's
   * OFFLINE_FIXTURE (API unreachable). The fixture's own docstring promises
   * memory mode and a seeded database show the SAME shop, and nothing enforced
   * that: an edit to one mirror could silently leave the others behind. This
   * pins the two authoritative ones to each other.
   */
  const seeded = seededDemoVariants(DEMO_SQL);

  it('parses a non-trivial number of seeded rows, so a broken regex cannot pass vacuously', () => {
    // Guards the guard: if the matcher stopped matching, every comparison below
    // would agree on an empty set and report success.
    expect(seeded.length).toBe(DEMO_CATALOG_FIXTURE.length);
  });

  it('seeds the same ids, skus and prices', () => {
    expect(seeded.map((row) => ({ id: row.id, sku: row.sku, priceCents: row.priceCents })))
      .toEqual(DEMO_CATALOG_FIXTURE.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        priceCents: variant.priceCents,
      })));
  });

  it('encodes each fixture colour as the row option_signature', () => {
    expect(seeded.map((row) => row.optionSignature))
      .toEqual(DEMO_CATALOG_FIXTURE.map((variant) => `color=${slugify(variant.color ?? '')}`));
  });

  it('seeds the same owned image path for every fixture variant', () => {
    expect(seeded.map((row) => row.imageUrl))
      .toEqual(DEMO_CATALOG_FIXTURE.map((variant) => variant.imageUrl));
  });

  it('keeps condition and handling out of the seeded variant axis', () => {
    for (const row of seeded) {
      expect(row.condition, `${row.id} is not NEW`).toBe('NEW');
      expect(row.optionSignature, `${row.id} still splits on condition/handling`)
        .not.toMatch(/condition=|handling=/);
    }
  });

  /**
   * FALSIFIABILITY CONTROL — a guard that has never failed is not known to work.
   * Proving it by editing demo.sql would be unsafe: git-sync sweeps the whole
   * tree on a schedule and would happily commit the mutant. So the control runs
   * a SYNTHETIC seed through the same parser; no file is touched.
   */
  it('WOULD fail if demo.sql reverted a row to the condition/handling axis', () => {
    const mutant = DEMO_SQL.replace("'color=walnut'", "'condition=used|handling=9'");
    const parsed = seededDemoVariants(mutant);

    expect(parsed).toHaveLength(seeded.length);
    expect(parsed.map((row) => row.optionSignature)).toContain('condition=used|handling=9');
    // The assertion the real test makes — here it must NOT hold.
    expect(parsed.map((row) => row.optionSignature))
      .not.toEqual(DEMO_CATALOG_FIXTURE.map((v) => `color=${slugify(v.color ?? '')}`));
  });
});

describe('the curated Event Manager seed', () => {
  const manifest = eventDemoManifest(DEMO_SQL);

  it('authors exactly 50 distinct product groups numbered without gaps', () => {
    expect(manifest.map((row) => row.productNumber)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(new Set(manifest.map((row) => row.title)).size).toBe(50);
    expect(manifest.every((row) => row.productType && row.brand && row.basePriceCents > 0)).toBe(true);
  });

  it('derives four variants per group and pins the executable database invariants', () => {
    expect(DEMO_SQL).toContain('CROSS JOIN generate_series(1, 4)');
    expect(DEMO_SQL).toContain('expected 50 groups / 200 variants');
    expect(DEMO_SQL).toContain('expected 20 / 15 / 15');
    expect(DEMO_SQL).toContain('expected 140 color / 120 size');
    expect(DEMO_SQL).toContain('each group must have four variants');
  });
});

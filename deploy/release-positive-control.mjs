#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://sidestage.buyrestart.com';
const REQUIRED_CATALOG_ROWS = 6;

function normalizedBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function identifierFor(value) {
  if (typeof value?.productId === 'string') return value.productId;
  if (typeof value?.id === 'string') return value.id;
  return '';
}

function isDemoIdentifier(value) {
  return /^(?:event-)?demo-/i.test(identifierFor(value));
}

/**
 * Read-only release gate: prove the public API exposes real sellable inventory,
 * then prove Scout can retrieve from that same catalog. The Scout query is
 * derived from a row the deployed catalog just returned, so the guard does not
 * depend on a hand-maintained product name or fabricate a release fixture.
 */
export async function verifyReleasePositiveControl({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = normalizedBaseUrl(baseUrl);
  const catalog = await readJson(await fetchImpl(
    `${base}/api/catalog?pageSize=${REQUIRED_CATALOG_ROWS}&availability=in-stock`,
    { headers: { accept: 'application/json' } },
  ), 'GET /api/catalog');

  if (!Array.isArray(catalog?.rows)) {
    throw new Error('GET /api/catalog returned an invalid catalog payload');
  }
  if (catalog.rows.length < REQUIRED_CATALOG_ROWS) {
    throw new Error(`Release catalog has ${catalog.rows.length} in-stock row(s); expected at least ${REQUIRED_CATALOG_ROWS}`);
  }

  const demoRows = catalog.rows.filter(isDemoIdentifier);
  if (demoRows.length > 0) {
    throw new Error(`Release catalog returned demo row(s): ${demoRows.map(identifierFor).join(', ')}`);
  }
  const unavailableRows = catalog.rows.filter((row) => !(Number(row?.availableQty) > 0));
  if (unavailableRows.length > 0) {
    throw new Error('Release catalog returned a non-positive quantity for an in-stock request');
  }

  const seed = catalog.rows.find((row) => typeof row?.title === 'string' && row.title.trim());
  const message = seed?.title.trim();
  if (!message) throw new Error('Release catalog rows do not provide a title for the Scout positive control');

  const scout = await readJson(await fetchImpl(`${base}/api/scout/chat`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ message, maxProducts: REQUIRED_CATALOG_ROWS }),
  }), 'POST /api/scout/chat');

  if (!Array.isArray(scout?.products) || scout.products.length === 0) {
    throw new Error(`Scout returned no verified products for catalog-derived query ${JSON.stringify(message)}`);
  }
  if (!scout.products.some((product) => identifierFor(product) && !isDemoIdentifier(product))) {
    throw new Error('Scout returned no non-demo verified product');
  }

  return {
    catalogRows: catalog.rows.length,
    scoutProducts: scout.products.length,
    query: message,
  };
}

function argumentValue(args, name) {
  const equals = args.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const result = await verifyReleasePositiveControl({
    baseUrl: argumentValue(process.argv.slice(2), '--base-url')
      ?? process.env.SIDESTAGE_AUDIT_BASE
      ?? DEFAULT_BASE_URL,
  });
  console.log(`Release positive control passed: ${result.catalogRows} real in-stock row(s); Scout returned ${result.scoutProducts} product(s) for ${JSON.stringify(result.query)}.`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://sidestage.buyrestart.com';

const PROBE_ID_PATTERNS = [
  /^wi\d+(?:[-_].*)?$/i,
  /^qa[-_]wi\d+(?:[-_].*)?$/i,
  /(?:^|[-_])(acceptance|deploy|rollback)(?:[-_]|$)/i,
];

function normalizedBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function isPlaceholdThumbnail(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'placehold.co' || host.endsWith('.placehold.co');
  } catch {
    return false;
  }
}

export function releaseProbeReasons(event) {
  const reasons = [];
  const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
  if (PROBE_ID_PATTERNS.some((pattern) => pattern.test(eventId))) reasons.push('probe event id');
  if (isPlaceholdThumbnail(event?.thumbnailUrl)) reasons.push('placehold.co thumbnail');
  return reasons;
}

export function findReleaseProbeResidue(events) {
  return events.flatMap((event) => {
    const reasons = releaseProbeReasons(event);
    return reasons.length > 0 ? [{ event, reasons }] : [];
  });
}

async function readGuide(baseUrl, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/events`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GET /api/events failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.events)) {
    throw new Error('GET /api/events returned an invalid guide payload');
  }
  return body.events;
}

function residueSummary(residue) {
  return residue
    .map(({ event, reasons }) => `${event.eventId} (${reasons.join(', ')})`)
    .join(', ');
}

/**
 * Clean and verify public release-probe residue. Mutations are exact-id and
 * seller-scoped; DELETE drafts the row server-side instead of destroying any
 * event-scoped history. With clean=false this is a read-only release gate.
 */
export async function enforceReleaseProbeHygiene({
  baseUrl = DEFAULT_BASE_URL,
  clean = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = normalizedBaseUrl(baseUrl);
  const before = findReleaseProbeResidue(await readGuide(base, fetchImpl));

  if (!clean && before.length > 0) {
    throw new Error(`Public event residue found: ${residueSummary(before)}`);
  }

  const removed = [];
  if (clean) {
    for (const { event, reasons } of before) {
      if (typeof event.sellerId !== 'string' || event.sellerId.trim() === '') {
        throw new Error(`Cannot safely unpublish ${event.eventId}: guide row has no sellerId`);
      }
      const response = await fetchImpl(`${base}/api/events/${encodeURIComponent(event.eventId)}`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          'x-seller-id': event.sellerId,
        },
      });
      if (!response.ok) {
        throw new Error(`DELETE ${event.eventId} failed with HTTP ${response.status}`);
      }
      removed.push({ eventId: event.eventId, reasons });
    }
  }

  const after = findReleaseProbeResidue(await readGuide(base, fetchImpl));
  if (after.length > 0) {
    throw new Error(`Public event residue remains after cleanup: ${residueSummary(after)}`);
  }
  return { removed, remaining: after };
}

function argumentValue(args, name) {
  const equals = args.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = argumentValue(args, '--base-url')
    ?? process.env.SIDESTAGE_AUDIT_BASE
    ?? DEFAULT_BASE_URL;
  const clean = args.includes('--clean');
  const result = await enforceReleaseProbeHygiene({ baseUrl, clean });
  if (result.removed.length > 0) {
    console.log(`Release event hygiene passed; unpublished ${result.removed.length} residue row(s): ${result.removed.map((entry) => entry.eventId).join(', ')}`);
  } else {
    console.log('Release event hygiene passed; no probe ids or placehold.co event rows are public.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

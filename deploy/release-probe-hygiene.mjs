#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Only a convenience default for a MANUAL run: deploy.sh always passes
// --base-url built from the hostname it resolved out of prod's .env.production.
// Kept current anyway (WI-39708) -- sidestage.buyrestart.com now 301s here, and
// a probe that silently audits a redirect target is auditing the wrong claim.
const DEFAULT_BASE_URL = 'https://sidestage.papercusp.com';

const PROBE_ID_PATTERNS = [
  /^wi\d+(?:[-_].*)?$/i,
  /^qa[-_]wi\d+(?:[-_].*)?$/i,
  /^p\d{3}[-_](?:buyer|seller|e2e|qa|probe|acceptance)(?:[-_].*)?$/i,
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
  // WI-39750: deliberately does NOT flag `sellerId === 'demo-seller'` as a
  // probe fingerprint, and must not be "restored" to -- same trap as
  // guideWithholdReason (apps/api/src/events/event.service.ts, WI-39723).
  // `demo-seller` is the DEFAULT identity every anonymous or minted Studio
  // session resolves to (apps/api/src/sync/sync-request-context.ts
  // rolePrincipal), not a synthetic probe marker -- it is the owner's own
  // identity every time they test without a distinct seller login. Gating
  // on it made "the owner is testing" indistinguishable from "CI probe
  // residue is still public", so every deploy failed while the owner had a
  // live demo-seller event up. Probe residue from an automated rehearsal is
  // still caught by its event-id convention (PROBE_ID_PATTERNS above) or by
  // a placehold.co thumbnail below; sellerId is no longer a signal here.
  if (typeof event?.sellerName === 'string' && event.sellerName.trim().toLowerCase() === 'sidestage seller') {
    reasons.push('placeholder seller name');
  }
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
 * seller-scoped through the canonical demo-principal header; DELETE drafts the
 * row server-side instead of destroying any event-scoped history. With
 * clean=false this is a read-only release gate.
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
          'x-demo-principal': event.sellerId,
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  enforceReleaseProbeHygiene,
  findReleaseProbeResidue,
} from './release-probe-hygiene.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploySource = readFileSync(path.join(here, 'deploy.sh'), 'utf8');

function guide(events, status = 200) {
  return new Response(JSON.stringify({ events }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realEvent = {
  eventId: 'summer-vintage-drop',
  sellerId: 'seller-real',
  thumbnailUrl: 'https://cdn.example.com/summer.jpg',
};

describe('release probe residue classification', () => {
  it('covers every release namespace family and placeholder thumbnails', () => {
    const residue = findReleaseProbeResidue([
      realEvent,
      {
        eventId: 'p002-buyer-loop-0814-1952',
        sellerId: 'demo-seller',
        sellerName: 'SideStage Seller',
      },
      { eventId: 'wi38795-e2e-1786717919', sellerId: 'seller-a' },
      { eventId: 'qa-wi38814-live', sellerId: 'seller-b' },
      { eventId: 'production-acceptance-thumbnail', sellerId: 'seller-c' },
      { eventId: 'prod-deploy-check', sellerId: 'seller-d' },
      { eventId: 'release-rollback-check', sellerId: 'seller-e' },
      {
        eventId: 'otherwise-normal',
        sellerId: 'seller-f',
        thumbnailUrl: 'https://placehold.co/320x180/png?text=Probe',
      },
    ]);

    expect(residue.map(({ event }) => event.eventId)).toEqual([
      'p002-buyer-loop-0814-1952',
      'wi38795-e2e-1786717919',
      'qa-wi38814-live',
      'production-acceptance-thumbnail',
      'prod-deploy-check',
      'release-rollback-check',
      'otherwise-normal',
    ]);
    expect(residue[0].reasons).toEqual([
      'probe event id',
      'placeholder seller name',
    ]);
  });

  it('WI-39750: does not flag a live demo-seller event with no other probe fingerprint', () => {
    // demo-seller is the DEFAULT identity every anonymous/minted Studio
    // session resolves to (sync-request-context.ts rolePrincipal) -- the
    // owner's own routine testing, not synthetic probe residue. Gating on
    // it made shipping and testing mutually exclusive.
    const residue = findReleaseProbeResidue([
      {
        eventId: 'asfsaf',
        sellerId: 'demo-seller',
        sellerName: 'Demo Seller',
        thumbnailUrl: 'https://cdn.example.com/real-upload.jpg',
      },
    ]);
    expect(residue).toEqual([]);
  });
});

describe('release probe hygiene gate', () => {
  it('is read-only by default and fails on public residue', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(guide([
      { eventId: 'wi38795-e2e', sellerId: 'seller-probe' },
    ]));

    await expect(enforceReleaseProbeHygiene({
      baseUrl: 'https://sidestage.example/',
      fetchImpl,
    })).rejects.toThrow('Public event residue found: wi38795-e2e');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('unpublishes exact seller-owned rows and re-reads before passing', async () => {
    const residue = {
      eventId: 'qa-wi38814-live',
      sellerId: 'seller-probe',
      thumbnailUrl: 'https://placehold.co/320x180/png?text=Probe',
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(guide([realEvent, residue]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        eventId: residue.eventId,
        status: 'draft',
      }), { status: 200 }))
      .mockResolvedValueOnce(guide([realEvent]));

    await expect(enforceReleaseProbeHygiene({
      baseUrl: 'https://sidestage.example/',
      clean: true,
      fetchImpl,
    })).resolves.toEqual({
      removed: [{
        eventId: residue.eventId,
        reasons: ['probe event id', 'placehold.co thumbnail'],
      }],
      remaining: [],
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://sidestage.example/api/events/qa-wi38814-live',
      {
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          'x-demo-principal': 'seller-probe',
        },
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses to claim cleanup when residue remains public', async () => {
    const residue = { eventId: 'deploy-probe', sellerId: 'seller-probe' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(guide([residue]))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(guide([residue]));

    await expect(enforceReleaseProbeHygiene({
      clean: true,
      fetchImpl,
    })).rejects.toThrow('Public event residue remains after cleanup');
  });
});

describe('production deploy wiring', () => {
  it('runs the read-only hygiene verdict after the positive control and before recording the sha', () => {
    const positiveControl = deploySource.indexOf('release-positive-control.mjs');
    const eventHygiene = deploySource.indexOf('release-probe-hygiene.mjs');
    const shaWrite = deploySource.indexOf('> $DEPLOYED_SHA_FILE');

    expect(positiveControl).toBeGreaterThan(-1);
    expect(eventHygiene).toBeGreaterThan(positiveControl);
    expect(shaWrite).toBeGreaterThan(eventHygiene);
  });

  it('auto-rolls back instead of recording a release with public probe residue', () => {
    // The direct `node "$SCRIPT_DIR/..."` call became the run_release_probe
    // helper when probes moved to the prod vantage (a14ce45). Both halves of
    // the original guarantee are still asserted, just in two places: the call
    // site runs the probe and rolls back on failure, and the helper is what
    // now carries the public --base-url (so the probe cannot silently be
    // pointed at localhost).
    expect(deploySource).toMatch(/if ! run_release_probe release-probe-hygiene\.mjs "\$SHA"/);
    expect(deploySource).toMatch(/\/probe\/\$1 --base-url https:\/\/\$PUBLIC_HOSTNAME/);
    expect(deploySource).toMatch(/auto_rollback_failed_release "release event hygiene" 7/);
  });
});

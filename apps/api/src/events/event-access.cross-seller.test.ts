/**
 * Two-seller behavioural regression matrix over the real HTTP surface (P-008).
 *
 * `event-access.matrix.test.ts` proves every route is CLASSIFIED. This file
 * proves the classification is TRUE: a second seller is driven against the
 * first seller's resources through the booted application graph, and every
 * `seller-owned` cell in the registry must be exercised here or the coverage
 * test fails. Classification without behaviour is a promise, not a proof.
 *
 * D-003 is the contract under test: "Owner-only lookups return the same
 * not-found response for absent and foreign ids, including secondary
 * proposal/audit/auction identifiers, so callers cannot enumerate another
 * seller's resources." A response that merely FAILS is not enough — it must be
 * indistinguishable from the response for an id that does not exist at all.
 *
 * The principal pair is deliberately ROLE-CROSSING (D-009 C1): seller A is
 * addressed as `buyer-avi` so `rolePrincipal()`'s strip-and-reprefix projection
 * (D-001) is exercised on every request rather than assumed.
 */
import { bootNestTestApp, type NestTestApp } from '@papercusp/test-config/nest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_AUDIT_STORE, type ActionAuditStore } from '../actions/action-audit.store';
import type { ActionAuditRecord } from '../actions/action.types';
import { AppModule } from '../app.module';
import { AUCTION_INVENTORY } from '../auction/auction.service';
import { CopilotProposalService } from '../copilot/copilot.service';
import { baselinePolicyBody } from '../policies/policy-rules';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { endpointsWithPolicy, syncQueriesWithPolicy } from './event-access.registry';

/** Seller A, addressed in its buyer spelling so the role projection is live. */
const AVI = 'buyer-avi';
/** Seller B — a different seller, addressed in its seller spelling. */
const MIRA = 'seller-mira';

const AVI_EVENT = 'avi-drop-2026-09-05';
const MIRA_EVENT = 'mira-drop-2026-09-05';
const ABSENT_EVENT = 'no-such-event-2026-09-05';

const ABSENT_POLICY = 'no-such-policy-2026-09-05';
const ABSENT_PROPOSAL = 'no-such-proposal-2026-09-05';
const ABSENT_AUDIT = 'no-such-audit-2026-09-05';
const ABSENT_AUCTION = 'no-such-auction-2026-09-05';

/** An audit belonging to seller A's event, seeded through the audit store. */
const AVI_AUDIT = 'avi-audit-2026-09-05';

const POLICY_BODY = baselinePolicyBody();

let nest: NestTestApp;
let aviPolicyId = '';
let aviProposalId = '';
let aviAuctionId = '';

type Http = NestTestApp['request'];

/** One id-anchored owner-only cell: foreign id must equal absent id. */
interface OwnedCell {
  route: string;
  owned: () => string;
  absent: string;
  send: (http: Http, principal: string, id: string) => Promise<{ status: number; body: unknown }>;
}

/** A seller-scoped surface with no id in the path. */
interface ScopedCell {
  route: string;
  /** Assert seller B cannot observe seller A's rows through this surface. */
  assert: (http: Http) => Promise<void>;
}

/**
 * Set the demo principal and hand the request BACK AT ITS OWN TYPE, so the
 * supertest chain (`.set`, `.send`, `.status`, `.body`) survives the helper.
 */
const principal = <T extends { set: (name: string, value: string) => unknown }>(
  request: T,
  value: string,
): T => {
  request.set(DEMO_PRINCIPAL_HEADER, value);
  return request;
};

async function outcome(
  promise: PromiseLike<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  const response = await promise;
  return { status: response.status, body: response.body };
}

const OWNED_CELLS: OwnedCell[] = [
  {
    route: 'POST /actions/events/:eventId/register',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.post(`/actions/events/${id}/register`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'GET /actions/events/:eventId/items',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/actions/events/${id}/items`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'GET /actions/events/:eventId/audit',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/actions/events/${id}/audit`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'POST /actions/events/:eventId/execute',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.post(`/actions/events/${id}/execute`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /auctions/start',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http.post('/auctions/start').set(DEMO_PRINCIPAL_HEADER, p).send({ eventId: id, productId: 'p-1' }),
      ),
  },
  {
    route: 'POST /chat/events/:eventId/transcript',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.post(`/chat/events/${id}/transcript`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /chat/events/:eventId/transcript/product-focus',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http
          .post(`/chat/events/${id}/transcript/product-focus`)
          .set(DEMO_PRINCIPAL_HEADER, p)
          .send({}),
      ),
  },
  {
    route: 'DELETE /chat/events/:eventId/messages/:messageId',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.delete(`/chat/events/${id}/messages/message-1`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'GET /events/:eventId/config',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) => outcome(http.get(`/events/${id}/config`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'GET /copilot/events/:eventId/proposals',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/copilot/events/${id}/proposals`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'POST /copilot/events/:eventId/turns',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.post(`/copilot/events/${id}/turns`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'DELETE /events/:eventId',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) => outcome(http.delete(`/events/${id}`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'PATCH /events/:eventId/lifecycle',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http
          .patch(`/events/${id}/lifecycle`)
          .set(DEMO_PRINCIPAL_HEADER, p)
          .send({ action: 'go-live' }),
      ),
  },
  // Seller-scoped policy surfaces anchored on the EVENT the draft is attached
  // to: a seller must not be able to hang a policy on another seller's event,
  // nor discover that the event exists by trying.
  {
    route: 'GET /v1/seller/policies/effective',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/v1/seller/policies/effective?eventId=${id}`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'POST /v1/seller/policies',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http
          .post('/v1/seller/policies')
          .set(DEMO_PRINCIPAL_HEADER, p)
          .send({ eventId: id, policy: POLICY_BODY }),
      ),
  },
  // Secondary identifiers (D-003): a policy revision id belonging to seller A
  // must be as invisible to seller B as an id that never existed.
  {
    route: 'GET /v1/seller/policies/:id',
    owned: () => aviPolicyId,
    absent: ABSENT_POLICY,
    send: (http, p, id) => outcome(http.get(`/v1/seller/policies/${id}`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'PATCH /v1/seller/policies/:id',
    owned: () => aviPolicyId,
    absent: ABSENT_POLICY,
    send: (http, p, id) =>
      outcome(
        http
          .patch(`/v1/seller/policies/${id}`)
          .set(DEMO_PRINCIPAL_HEADER, p)
          .send({ policy: POLICY_BODY }),
      ),
  },
  {
    route: 'POST /v1/seller/policies/:id/validate',
    owned: () => aviPolicyId,
    absent: ABSENT_POLICY,
    send: (http, p, id) =>
      outcome(http.post(`/v1/seller/policies/${id}/validate`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /v1/seller/policies/:id/publish',
    owned: () => aviPolicyId,
    absent: ABSENT_POLICY,
    send: (http, p, id) =>
      outcome(http.post(`/v1/seller/policies/${id}/publish`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'GET /v1/seller/policies/:id/audit',
    owned: () => aviPolicyId,
    absent: ABSENT_POLICY,
    send: (http, p, id) =>
      outcome(http.get(`/v1/seller/policies/${id}/audit`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  // Copilot proposal ids — the secondary identifiers D-003 names explicitly.
  {
    route: 'POST /copilot/proposals/:proposalId/approve',
    owned: () => aviProposalId,
    absent: ABSENT_PROPOSAL,
    send: (http, p, id) =>
      outcome(http.post(`/copilot/proposals/${id}/approve`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /copilot/proposals/:proposalId/skip',
    owned: () => aviProposalId,
    absent: ABSENT_PROPOSAL,
    send: (http, p, id) =>
      outcome(http.post(`/copilot/proposals/${id}/skip`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /copilot/proposals/:proposalId/confirm-action',
    owned: () => aviProposalId,
    absent: ABSENT_PROPOSAL,
    send: (http, p, id) =>
      outcome(
        http.post(`/copilot/proposals/${id}/confirm-action`).set(DEMO_PRINCIPAL_HEADER, p).send({}),
      ),
  },
  // Action audit id — rollback resolves the audit, then owner-checks its event.
  {
    route: 'POST /actions/audit/:auditId/rollback',
    owned: () => AVI_AUDIT,
    absent: ABSENT_AUDIT,
    send: (http, p, id) =>
      outcome(http.post(`/actions/audit/${id}/rollback`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  // Auction ids belonging to seller A's event.
  {
    route: 'POST /auctions/:id/cancel',
    owned: () => aviAuctionId,
    absent: ABSENT_AUCTION,
    send: (http, p, id) =>
      outcome(http.post(`/auctions/${id}/cancel`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  {
    route: 'POST /auctions/:id/close',
    owned: () => aviAuctionId,
    absent: ABSENT_AUCTION,
    send: (http, p, id) =>
      outcome(http.post(`/auctions/${id}/close`).set(DEMO_PRINCIPAL_HEADER, p).send({})),
  },
  // Rehearsal + run-of-show surfaces are anchored on the event id, so they are
  // owned cells, not bare principal checks.
  {
    route: 'GET /rehearsals/preflight/:eventId',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/rehearsals/preflight/${id}`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'POST /rehearsals/client-realtime/:eventId',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http.post(`/rehearsals/client-realtime/${id}`).set(DEMO_PRINCIPAL_HEADER, p).send({}),
      ),
  },
  {
    route: 'GET /events/:eventId/run-of-show',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(http.get(`/events/${id}/run-of-show`).set(DEMO_PRINCIPAL_HEADER, p)),
  },
  {
    route: 'PUT /events/:eventId/run-of-show',
    owned: () => AVI_EVENT,
    absent: ABSENT_EVENT,
    send: (http, p, id) =>
      outcome(
        http.put(`/events/${id}/run-of-show`).set(DEMO_PRINCIPAL_HEADER, p).send({ segments: [] }),
      ),
  },
];

/**
 * Surfaces whose only isolation contract is that they demand a seller
 * principal at all — they carry no per-seller resource to confuse with another
 * seller's. Classifying them here rather than pretending they are id-anchored
 * keeps the matrix honest about what each cell actually proves.
 */
const PRINCIPAL_CELLS: { route: string; send: (http: Http, principal?: string) => Promise<{ status: number; body: unknown }> }[] = [
  {
    route: 'GET /chat/metrics',
    send: (http, p) => {
      const request = http.get('/chat/metrics');
      if (p) request.set(DEMO_PRINCIPAL_HEADER, p);
      return outcome(request);
    },
  },
  {
    route: 'POST /transcription/deepgram-token',
    send: (http, p) => {
      const request = http.post('/transcription/deepgram-token');
      if (p) request.set(DEMO_PRINCIPAL_HEADER, p);
      return outcome(request.send({}));
    },
  },
];

const SCOPED_CELLS: ScopedCell[] = [
  {
    route: 'GET /events/mine',
    assert: async (http) => {
      const mine = await http.get('/events/mine').set(DEMO_PRINCIPAL_HEADER, MIRA);
      const ids = JSON.stringify(mine.body);
      expect(ids).toContain(MIRA_EVENT);
      expect(ids).not.toContain(AVI_EVENT);
    },
  },
];

beforeAll(async () => {
  nest = await bootNestTestApp({ metadata: { imports: [AppModule] } });
  // Each seller creates its own event through the real create seam (PUT config
  // publishes the directory row — EI-20426845001666103).
  await principal(nest.request.put(`/events/${AVI_EVENT}/config`), AVI)
    .send({ name: 'Avi drop' })
    .expect(200);
  await principal(nest.request.put(`/events/${MIRA_EVENT}/config`), MIRA)
    .send({ name: 'Mira drop' })
    .expect(200);

  // Secondary resources owned by seller A. Each is seeded through the same
  // seam production uses, so the ids under test are real rather than invented.
  const policy = await principal(nest.request.post('/v1/seller/policies'), AVI)
    .set('idempotency-key', 'cross-seller-matrix-policy-seed')
    .send({ eventId: AVI_EVENT, policy: POLICY_BODY });
  aviPolicyId = String((policy.body as { data?: { id?: string } })?.data?.id ?? '');

  // The auction needs inventory that seller A actually owns (D-002 anchors
  // non-event inventory ownership directly on the seller).
  await nest.module
    .get<{ seed: (productId: string, qty: number, reservedQty?: number, sellerId?: string) => Promise<unknown> }>(
      AUCTION_INVENTORY,
      { strict: false },
    )
    .seed('avi-product-1', 5, 0, 'seller-avi');

  const auction = await principal(nest.request.post('/auctions/start'), AVI).send({
    eventId: AVI_EVENT,
    eventItemId: 'avi-item-1',
    productId: 'avi-product-1',
    quantity: 1,
    startingPriceCents: 1000,
    durationSec: 600,
  });
  aviAuctionId = String((auction.body as { id?: string })?.id ?? '');

  const proposal = await nest.module
    .get<CopilotProposalService>(CopilotProposalService, { strict: false })
    .createManual(AVI_EVENT, { message: 'Seed proposal for the isolation matrix' } as never);
  aviProposalId = String((proposal as { id?: string })?.id ?? '');

  // A FULLY-SHAPED audit record. An earlier draft seeded `{ auditId, actionType,
  // status }` through an `as unknown as` cast; the store keys on `id`, so the
  // row landed under `undefined` and AVI_AUDIT was never a real id — which made
  // the rollback cell pass vacuously (both ids merely absent), and left every
  // audit reader dereferencing an `after` that was not there.
  const auditItem = {
    eventItemId: 'avi-item-1',
    eventId: AVI_EVENT,
    productId: 'avi-product-1',
    title: 'Avi headline drop',
    currentPriceCents: 1000,
    currentQuantity: 5,
    listedQuantity: 5,
    attributes: {},
  };
  await nest.module.get<ActionAuditStore>(ACTION_AUDIT_STORE, { strict: false }).record({
    id: AVI_AUDIT,
    eventId: AVI_EVENT,
    actorId: 'seller-avi',
    kind: 'price-adjust',
    productId: 'avi-product-1',
    reason: 'Seed audit for the isolation matrix',
    before: { item: { ...auditItem, currentPriceCents: 1200 }, offers: [] },
    after: { item: auditItem, offers: [] },
    createdAt: new Date().toISOString(),
  } satisfies ActionAuditRecord);

  // A cell that probes an empty or never-created id would silently pass for the
  // wrong reason, so every secondary identifier is proven real before use.
  expect({ aviPolicyId, aviAuctionId, aviProposalId }).toEqual({
    aviPolicyId: expect.stringMatching(/\S/),
    aviAuctionId: expect.stringMatching(/\S/),
    aviProposalId: expect.stringMatching(/\S/),
  });
  const seededAudits = await nest.module
    .get<ActionAuditStore>(ACTION_AUDIT_STORE, { strict: false })
    .list(AVI_EVENT);
  expect(seededAudits.map((audit) => audit.id)).toContain(AVI_AUDIT);
}, 60_000);

afterAll(async () => {
  await nest?.close();
});

/** `PUT config` is the CREATE seam, so an absent id succeeds by design. */
const CREATE_SEAM_ROUTES = ['PUT /events/:eventId/config'];

describe('two-seller access matrix — coverage', () => {
  it('exercises every seller-owned endpoint in the access registry', () => {
    const covered = [
      ...OWNED_CELLS.map((cell) => cell.route),
      ...SCOPED_CELLS.map((cell) => cell.route),
      ...PRINCIPAL_CELLS.map((cell) => cell.route),
      ...CREATE_SEAM_ROUTES,
    ].sort();
    expect(covered).toEqual(endpointsWithPolicy('seller-owned'));
  });
});

describe('two-seller access matrix — foreign ids are indistinguishable from absent ids', () => {
  for (const cell of OWNED_CELLS) {
    it(`${cell.route} hides seller A's resource from seller B`, async () => {
      const foreign = await cell.send(nest.request, MIRA, cell.owned());
      const absent = await cell.send(nest.request, MIRA, cell.absent);

      expect(foreign.status).toBe(404);
      expect(foreign).toEqual(absent);
    });
  }
});

describe('two-seller access matrix — seller-scoped surfaces', () => {
  for (const cell of SCOPED_CELLS) {
    it(`${cell.route} shows seller B only its own rows`, async () => {
      await cell.assert(nest.request);
    });
  }
});

describe('two-seller access matrix — surfaces that only require a seller', () => {
  for (const cell of PRINCIPAL_CELLS) {
    it(`${cell.route} refuses a caller with no demo principal`, async () => {
      const anonymous = await cell.send(nest.request);
      expect(anonymous.status).toBe(401);

      // ...and does not refuse for that reason once a seller identifies itself.
      const identified = await cell.send(nest.request, MIRA);
      expect(identified.status).not.toBe(401);
    });
  }
});

describe('two-seller access matrix — the create seam', () => {
  it('PUT /events/:eventId/config refuses to overwrite another seller\'s event', async () => {
    const before = await principal(nest.request.get(`/events/${AVI_EVENT}/config`), AVI);
    expect(before.status).toBe(200);

    const hijack = await principal(nest.request.put(`/events/${AVI_EVENT}/config`), MIRA)
      .send({ name: 'Hijacked by Mira' });
    expect(hijack.status).toBe(404);

    // The create seam is the one owner-only route where an ABSENT id must NOT
    // behave like a foreign one: saving a config is how a seller creates an
    // event, so seller B may freely create its own.
    const created = await principal(
      nest.request.put('/events/mira-second-drop-2026-09-05/config'),
      MIRA,
    ).send({ name: 'Mira second drop' });
    expect(created.status).toBe(200);

    const after = await principal(nest.request.get(`/events/${AVI_EVENT}/config`), AVI);
    expect(after.body).toEqual(before.body);
  });
});

/* -------------------------------------------------------------------------
 * The sync-query half of the matrix.
 *
 * Named sync queries are the SECOND private read path (D-003 classifies 16 of
 * them) and they are easy to leave behind, because they do not travel as
 * distinct HTTP routes: every one arrives as an entry in a single
 * `POST /sync/rest-query-batch` body. That transport also swallows failures —
 * a refused query comes back inside a 200 envelope as `{ rows: [], error }` —
 * so an HTTP-status assertion proves nothing here and the RESULT SHAPE is the
 * only honest thing to compare.
 * ---------------------------------------------------------------------- */

/** The batch envelope minus `version`, which is a nondeterministic Date.now(). */
type SyncOutcome = { rows: unknown[] | null; error: string | null };

async function syncQuery(
  name: string,
  args: Record<string, unknown>,
  principalValue?: string,
): Promise<SyncOutcome> {
  const request = nest.request.post('/sync/rest-query-batch');
  if (principalValue) request.set(DEMO_PRINCIPAL_HEADER, principalValue);
  const response = await request.send({ queries: [{ name, args }] });
  expect(response.status).toBe(201);
  const result = (response.body as { results?: SyncOutcome[] })?.results?.[0];
  return { rows: result?.rows ?? null, error: result?.error ?? null };
}

/** An event-id-anchored owner-only sync query. */
interface SyncOwnedCell {
  name: string;
  args: (eventId: string) => Record<string, unknown>;
}

const SYNC_OWNED_CELLS: SyncOwnedCell[] = [
  { name: 'event.actions.items', args: (eventId) => ({ eventId }) },
  { name: 'event.config', args: (eventId) => ({ eventId }) },
  { name: 'event.copilot.proposals', args: (eventId) => ({ eventId }) },
  { name: 'event.runOfShow', args: (eventId) => ({ eventId }) },
  { name: 'rehearsal.preflight', args: (eventId) => ({ eventId }) },
];

/** Owner-only sync queries with no event id to anchor on. */
const SYNC_SCOPED_QUERIES = ['events.mine'];

describe('two-seller sync-query matrix — coverage', () => {
  it('exercises every seller-owned sync query in the access registry', () => {
    const covered = [
      ...SYNC_OWNED_CELLS.map((cell) => cell.name),
      ...SYNC_SCOPED_QUERIES,
    ].sort();
    expect(covered).toEqual(syncQueriesWithPolicy('seller-owned'));
  });
});

describe('two-seller sync-query matrix — foreign ids are indistinguishable from absent ids', () => {
  for (const cell of SYNC_OWNED_CELLS) {
    it(`${cell.name} hides seller A's event from seller B`, async () => {
      const foreign = await syncQuery(cell.name, cell.args(AVI_EVENT), MIRA);
      const absent = await syncQuery(cell.name, cell.args(ABSENT_EVENT), MIRA);

      // It must actually refuse — an empty row set with no error would mean
      // the query ran for seller B and merely found nothing.
      expect(foreign.error).toEqual(expect.stringMatching(/\S/));
      expect(foreign).toEqual(absent);
    });

    it(`${cell.name} still answers seller A for its own event`, async () => {
      const owned = await syncQuery(cell.name, cell.args(AVI_EVENT), AVI);
      expect(owned.error).toBeNull();
    });
  }
});

describe('two-seller sync-query matrix — seller-scoped queries', () => {
  for (const name of SYNC_SCOPED_QUERIES) {
    it(`${name} shows each seller only its own rows`, async () => {
      const mine = await syncQuery(name, {}, MIRA);
      expect(mine.error).toBeNull();
      const serialized = JSON.stringify(mine.rows);
      expect(serialized).toContain(MIRA_EVENT);
      expect(serialized).not.toContain(AVI_EVENT);
    });

    it(`${name} refuses a caller with no demo principal`, async () => {
      const anonymous = await syncQuery(name, {});
      expect(anonymous.error).toEqual(expect.stringMatching(/\S/));
    });
  }
});

/**
 * Args for public queries that need more than an event id. Anything absent
 * here is called with `{ eventId }`, which is the shape all but one take.
 */
const PUBLIC_QUERY_ARGS: Record<string, Record<string, unknown>> = {
  'event.pricingHistory': { eventId: AVI_EVENT, productId: 'avi-product-1' },
};

describe('two-seller sync-query matrix — public surfaces stay shared', () => {
  // The isolation work must not privatise the buyer-facing reads. Every
  // public-viewer query is asserted to answer BOTH principals identically for
  // seller A's published event, which is the regression guard for "public
  // guide/catalog/auction views remain shared".
  for (const name of syncQueriesWithPolicy('public-viewer')) {
    it(`${name} answers seller A and seller B alike`, async () => {
      const args = PUBLIC_QUERY_ARGS[name] ?? { eventId: AVI_EVENT };
      const asOwner = await syncQuery(name, args, AVI);
      const asOther = await syncQuery(name, args, MIRA);

      expect(asOwner.error).toBeNull();
      expect(asOther).toEqual(asOwner);
    });
  }
});

/**
 * END-TO-END LIVE JOURNEY — the whole seller/buyer loop against a REAL deployment.
 *
 * Owner-commissioned 2026-08-19 after a prod incident where two independent
 * defects (an ownership-orphaned event 404ing, and a lineup pointing at a
 * foreign-owned product so the copilot told every buyer "out of stock") were
 * both invisible to the unit suites. Every assertion here is one a unit test
 * structurally cannot make: it needs a running API, a real database, a real
 * model provider, and real HTTP.
 *
 * ## Running it
 *
 *   SIDESTAGE_E2E_BASE_URL=https://sidestage.papercusp.com \
 *     npm run test:file -- apps/api/src/e2e/live-journey.e2e.test.ts
 *
 * Unset => the whole suite SKIPS, so `sidestage-node` stays hermetic (the
 * DATA_BACKEND=memory invariant guarded by db/database.module.test.ts).
 *
 * ## Why it is safe to re-run
 *
 * Every run mints its own event id (`e2e-<epoch>-<rand>`) and tears it down in
 * `afterAll`. It never reads, mutates, or asserts on demo/interview data. The
 * one shared resource it touches is the seller catalog, and it re-uses an
 * already-onboarded product rather than creating a new one where it can —
 * `storefront_product` carries UNIQUE (seller_id, group_id, region,
 * option_signature), so blind re-onboarding of the same variant COLLIDES on the
 * second run. That collision is exactly what stranded the interview event's
 * lineup, so `onboardOrReuse` treats it as an expected branch, not a failure.
 *
 * ## Discipline
 *
 * Assertions carry POSITIVE CONTROLS wherever an empty/absent result would
 * otherwise read as a pass. A journey step that cannot run is FAILED, never
 * silently skipped — a green run must mean the loop actually worked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.SIDESTAGE_E2E_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
const API = `${BASE}/api`;
const SELLER = process.env.SIDESTAGE_E2E_SELLER?.trim() || 'demo-seller';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EVENT_SCHEDULED = `e2e-${RUN}-sched`;
const EVENT_DIRECT = `e2e-${RUN}-direct`;
const BUYER = `buyer-e2e-${RUN}`;

/**
 * A model call is seconds; the deterministic no-credential generator is
 * sub-millisecond template substitution. This threshold is the only way to
 * catch prod silently falling back off Vertex — `provider` is NOT persisted on
 * copilot_proposal (measured 2026-08-19: the payload carries latencyMs and no
 * provider/providerError), so latency is the sole stored discriminator.
 */
const MODEL_LATENCY_FLOOR_MS = 250;

interface Res<T = unknown> {
  status: number;
  body: T;
  text: string;
}

async function call<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; principal?: string; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.principal ? { 'x-demo-principal': options.principal } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, text };
}

const asSeller = (method: string, path: string, body?: unknown) =>
  call(method, path, { body, principal: SELLER });
const asBuyer = (method: string, path: string, body?: unknown) =>
  call(method, path, { body, principal: BUYER });

/** Poll until `check` passes or the budget runs out. Returns the last value. */
async function until<T>(
  label: string,
  budgetMs: number,
  poll: () => Promise<T>,
  check: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await poll();
  while (!check(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    last = await poll();
  }
  if (!check(last)) {
    throw new Error(`${label}: condition never held within ${budgetMs}ms. Last: ${JSON.stringify(last).slice(0, 600)}`);
  }
  return last;
}

/**
 * Collection envelopes are NOT uniform across this API, and guessing wrong
 * yields an empty array that reads as "nothing there" instead of "wrong key" —
 * the false-absence trap. Measured 2026-08-19: `/catalog` returns `{ rows }`,
 * `/chat/.../messages` returns `{ items }`, `/actions/.../items` returns
 * `{ items }`. Accept the known envelopes, then FAIL loudly if none matched.
 */
function collection(body: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const record = (body ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

const catalogRows = (body: unknown) => collection(body, 'rows', 'variants', 'items');
const chatItems = (body: unknown) => collection(body, 'items', 'messages');

interface OwnedProduct {
  productId: string;
  priceCents: number;
  quantity: number;
  title: string;
}

/** The product the journey sells. Reused across runs — see the header note. */
let product: OwnedProduct;

describe.runIf(BASE !== '')(`live journey E2E (${BASE || 'skipped'})`, () => {
  beforeAll(async () => {
    const health = await call('GET', '/../healthz');
    expect(health.status, 'deployment is not answering healthz — nothing below can be trusted').toBe(200);
  }, 60_000);

  afterAll(async () => {
    // Unpublish is the seller-facing teardown (a soft delete that stops buyers
    // seeing it) — the API deliberately exposes no hard delete.
    for (const eventId of [EVENT_SCHEDULED, EVENT_DIRECT]) {
      await asSeller('DELETE', `/events/${eventId}`).catch(() => undefined);
    }
  }, 60_000);

  describe('1. inventory', () => {
    it('lists the source catalog (control: a non-empty catalog, or every later step is vacuous)', async () => {
      const res = await asSeller('GET', '/catalog?limit=5');
      expect(res.status).toBe(200);
      const rows = catalogRows(res.body);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length, 'empty source catalog — onboarding cannot be tested').toBeGreaterThan(0);
    }, 60_000);

    it('exposes at least one product this seller OWNS, onboarding one if needed', async () => {
      // Prefer an already-owned product: re-onboarding the same catalog variant
      // hits UNIQUE (seller_id, group_id, region, option_signature).
      const catalog = await asSeller('GET', '/catalog?limit=25');
      const variants = catalogRows(catalog.body);
      expect(variants.length).toBeGreaterThan(0);

      // Walk candidates until one onboards.
      let resolved: OwnedProduct | undefined;
      let lastRejection = '(no candidate was attempted)';
      for (const variant of variants.slice(0, 8)) {
        const sourceId = String(variant.id ?? variant.productId ?? '');
        if (!sourceId) continue;
        const onboard = await asSeller('POST', `/inventory/${sourceId}/onboard`, {
          quantity: 25,
          priceCents: Number(variant.priceCents ?? 4_999),
        });
        // REGRESSION GUARD (EI-20739798038041966): onboarding a product the seller
        // already stocks is an ORDINARY outcome — the seeded-listing natural-key
        // collision. It must be idempotent (2xx) or an honest 409. Prod answered
        // 500 here on 2026-08-19, which is indistinguishable from an outage.
        expect(
          onboard.status,
          `onboard returned ${onboard.status} — a re-onboard must never be a 5xx: ${onboard.text.slice(0, 200)}`,
        ).toBeLessThan(500);
        if (onboard.status >= 200 && onboard.status < 300) {
          const payload = onboard.body as { productId?: string; snapshot?: Record<string, unknown> };
          const productId = String(payload.productId ?? payload.snapshot?.productId ?? '');
          if (productId) {
            resolved = {
              productId,
              priceCents: Number(variant.priceCents ?? 4_999),
              quantity: 25,
              title: String(variant.title ?? 'E2E product'),
            };
            break;
          }
        }
        // Deliberately NO fallback to `GET /inventory/:sourceId`: that returns the
        // SOURCE catalog row, whose id this seller does not own. Feeding it onward
        // fails three steps later as "Event item … was not found" and buries the
        // real cause. Skip the candidate; if none onboards, fail loudly below.
        lastRejection = `${sourceId} -> ${onboard.status} ${onboard.text.slice(0, 160)}`;
      }

      expect(
        resolved,
        `no catalog variant could be onboarded for ${SELLER}. Last rejection: ${lastRejection}`,
      ).toBeDefined();
      product = resolved!;
      expect(product.productId.length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe('2. event setup and lineup', () => {
    it('creates an event via config save', async () => {
      const res = await asSeller('PUT', `/events/${EVENT_SCHEDULED}/config`, {
        name: `E2E Scheduled ${RUN}`,
        replyTone: 'warm',
      });
      expect([200, 201]).toContain(res.status);
      const check = await asSeller('GET', `/events/${EVENT_SCHEDULED}/config`);
      expect(check.status).toBe(200);
      expect((check.body as { eventId?: string }).eventId).toBe(EVENT_SCHEDULED);
    }, 60_000);

    it('adds owned inventory to the event lineup', async () => {
      const res = await asSeller('POST', `/actions/events/${EVENT_SCHEDULED}/register`, {
        policy: {
          tone: 'warm',
          automationLevel: 'confirm',
          allowAutoActions: false,
          blockedActionKinds: [],
          maxMarkdownPercent: 30,
        },
        items: [
          {
            eventItemId: `${EVENT_SCHEDULED}:${product.productId}`,
            eventId: EVENT_SCHEDULED,
            productId: product.productId,
            title: product.title,
            // D-024 renamed the lineup's wire fields (priceCents -> currentPriceCents,
            // quantity -> currentQuantity, onStage -> stageState). A deployment may be
            // either side of that rename — measured 2026-08-19: prod still answered
            // `priceCents`/`quantity`/`onStage` while the tree had the new names. Send
            // BOTH so this suite tests the DEPLOYMENT rather than asserting its version;
            // the receiving side ignores whichever pair it does not know.
            priceCents: product.priceCents,
            currentPriceCents: product.priceCents,
            quantity: product.quantity,
            currentQuantity: product.quantity,
            listedQuantity: product.quantity,
            referencePriceCents: product.priceCents,
            attributes: {},
            position: 0,
            stageState: 'queued',
            onStage: false,
          },
        ],
      });
      expect(res.status, `register failed: ${res.text.slice(0, 300)}`).toBeLessThan(300);

      const items = await asSeller('GET', `/actions/events/${EVENT_SCHEDULED}/items`);
      expect(items.status).toBe(200);
      const list = (items.body as { items: Record<string, unknown>[] }).items;
      expect(list.length, 'lineup is empty after register').toBeGreaterThan(0);
      // REGRESSION GUARD (the interview incident): a lineup row must resolve to
      // inventory THIS seller owns and that is actually sellable. A row pointing
      // at a foreign-owned product reads as availableQty 0 and makes the copilot
      // answer "out of stock" for a fully-stocked event.
      expect(Number(list[0].availableQty), 'lineup item has no sellable quantity').toBeGreaterThan(0);
    }, 60_000);
  });

  describe('3. lifecycle', () => {
    it('schedules an event with a start time', async () => {
      const startsAt = new Date(Date.now() + 3_600_000).toISOString();
      const res = await asSeller('PATCH', `/events/${EVENT_SCHEDULED}/lifecycle`, { action: 'schedule', startsAt });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect((res.body as { event: { status: string } }).event.status).toBe('scheduled');
    }, 60_000);

    it('takes a DRAFT event live directly, with no schedule step', async () => {
      await asSeller('PUT', `/events/${EVENT_DIRECT}/config`, { name: `E2E Direct ${RUN}`, replyTone: 'warm' });
      const res = await asSeller('PATCH', `/events/${EVENT_DIRECT}/lifecycle`, { action: 'go-live' });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect((res.body as { event: { status: string } }).event.status).toBe('live');
    }, 60_000);

    it('takes the scheduled event live too (the rest of the journey needs it live)', async () => {
      const res = await asSeller('PATCH', `/events/${EVENT_SCHEDULED}/lifecycle`, { action: 'go-live' });
      expect(res.status).toBe(200);
      expect((res.body as { event: { status: string } }).event.status).toBe('live');
    }, 60_000);
  });

  describe('4. ownership isolation (WI-39864 regression guard)', () => {
    it('refuses a DIFFERENT seller identity with 404, never leaking existence', async () => {
      const foreign = await call('GET', `/events/${EVENT_SCHEDULED}/config`, { principal: `seller-e2e-intruder-${RUN}` });
      expect(foreign.status, 'a foreign seller could read this event').toBe(404);
      // Control: the SAME request as the owner succeeds, so the 404 above is
      // about identity and not about a broken route.
      const owner = await asSeller('GET', `/events/${EVENT_SCHEDULED}/config`);
      expect(owner.status).toBe(200);
    }, 60_000);

    it('gives a nonexistent event the SAME 404 as a foreign one (no enumeration oracle)', async () => {
      const missing = await asSeller('GET', `/events/definitely-not-an-event-${RUN}/config`);
      expect(missing.status).toBe(404);
    }, 60_000);
  });

  describe('5. streaming credential', () => {
    it('issues a Deepgram token so the seller can actually start a stream', async () => {
      const res = await asSeller('POST', '/transcription/deepgram-token', {});
      expect(res.status, `deepgram token endpoint failed: ${res.text.slice(0, 200)}`).toBeLessThan(400);
      const body = res.body as Record<string, unknown>;
      const token = String(body.accessToken ?? body.token ?? body.key ?? body.access_token ?? '');
      expect(token.length, 'token endpoint returned 2xx but no usable token — STT would fail live').toBeGreaterThan(10);
    }, 60_000);
  });

  describe('6. staging', () => {
    it('pushes the product on stage', async () => {
      const res = await asSeller('POST', `/actions/events/${EVENT_SCHEDULED}/execute`, {
        action: { kind: 'push', productId: product.productId, reason: 'E2E staging the hero product' },
        clientRequestId: `e2e-push-${RUN}`,
      });
      expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);

      const items = await asSeller('GET', `/actions/events/${EVENT_SCHEDULED}/items`);
      const staged = (items.body as { items: Record<string, unknown>[] }).items
        .find((item) => item.productId === product.productId);
      expect(staged?.stageState, 'push did not move the item on stage').toBe('on-stage');
    }, 60_000);
  });

  describe('7. chat', () => {
    it('accepts a buyer message and reads it back', async () => {
      const send = await asBuyer('POST', `/chat/events/${EVENT_SCHEDULED}/messages`, {
        userId: BUYER,
        displayName: 'E2E Buyer',
        role: 'buyer',
        text: 'hello from the e2e journey',
      });
      expect(send.status, send.text.slice(0, 300)).toBe(201);

      const read = await asSeller('GET', `/chat/events/${EVENT_SCHEDULED}/messages?limit=20`);
      expect(read.status).toBe(200);
      const messages = chatItems(read.body);
      expect(messages.length, 'chat read returned no rows at all — wrong envelope or a broken read').toBeGreaterThan(0);
      expect(messages.some((m) => m.text === 'hello from the e2e journey'), 'sent message did not come back').toBe(true);
    }, 60_000);
  });

  describe('8. copilot — the product question', () => {
    it('routes a product question to seller review and drafts a GROUNDED reply', async () => {
      const send = await asBuyer('POST', `/chat/events/${EVENT_SCHEDULED}/messages`, {
        userId: BUYER,
        displayName: 'E2E Buyer',
        role: 'buyer',
        text: `how many ${product.title} do you have left and what is the price?`,
      });
      expect(send.status).toBe(201);
      const routed = (send.body as { grounding?: { route?: { destination?: string } } }).grounding?.route?.destination;
      expect(routed, 'a product question was not routed to seller review').toBe('seller-review');

      const proposals = await until(
        'copilot proposal',
        90_000,
        async () => (await asSeller('GET', `/copilot/events/${EVENT_SCHEDULED}/proposals`)).body as Record<string, unknown>[],
        (list) => Array.isArray(list) && list.some((p) => p.status === 'pending'),
      );
      const pending = proposals.find((p) => p.status === 'pending')!;
      expect(String(pending.reply ?? '').length, 'proposal has an empty reply').toBeGreaterThan(10);
      expect((pending.citations as unknown[])?.length, 'reply is ungrounded — no citations').toBeGreaterThan(0);
    }, 180_000);

    it('is served by a REAL model, not the deterministic no-credential fallback', async () => {
      // Prod silently losing Vertex looks identical to working, except the
      // replies get worse — and `provider` is not persisted, so latency is the
      // only stored discriminator. See MODEL_LATENCY_FLOOR_MS.
      const list = (await asSeller('GET', `/copilot/events/${EVENT_SCHEDULED}/proposals`)).body as Record<string, unknown>[];
      const latencies = list.map((p) => Number(p.latencyMs ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
      expect(latencies.length, 'no proposal recorded a latency — cannot tell which engine served it').toBeGreaterThan(0);
      expect(
        Math.max(...latencies),
        `every proposal answered in <${MODEL_LATENCY_FLOOR_MS}ms — prod has fallen back to the deterministic generator`,
      ).toBeGreaterThan(MODEL_LATENCY_FLOOR_MS);
      // A provider error must never be silently absorbed into a shipped reply.
      expect(list.some((p) => p.providerError), 'a proposal carries providerError — the model call failed').toBe(false);
    }, 120_000);

    it('FAILS CLOSED on a question the catalog cannot ground (no hallucination)', async () => {
      const send = await asBuyer('POST', `/chat/events/${EVENT_SCHEDULED}/messages`, {
        userId: BUYER,
        displayName: 'E2E Buyer',
        role: 'buyer',
        text: 'what is the tensile strength of the alloy and who manufactured it in 1974?',
      });
      expect(send.status).toBe(201);
      const list = await until(
        'blocked proposal',
        90_000,
        async () => (await asSeller('GET', `/copilot/events/${EVENT_SCHEDULED}/proposals`)).body as Record<string, unknown>[],
        (all) => Array.isArray(all) && all.some((p) => p.status === 'blocked'),
      );
      const blocked = list.find((p) => p.status === 'blocked')!;
      expect(String(blocked.error ?? '')).toMatch(/insufficient|not enough|verified/i);
    }, 180_000);
  });

  describe('9. voice transcript and the product auto-activator', () => {
    it('records a transcript moment from speech', async () => {
      const res = await asSeller('POST', `/chat/events/${EVENT_SCHEDULED}/transcript`, {
        text: `alright let's switch to the ${product.title}`,
        startMs: 0,
        endMs: 2_500,
      });
      expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    }, 60_000);

    it('classifies spoken words onto the product the seller is talking about', async () => {
      const res = await asSeller('POST', `/chat/events/${EVENT_SCHEDULED}/transcript/product-focus`, {
        activeProductId: null,
        requestSequence: 1,
        products: [
          { id: product.productId, label: product.title, aliases: [], brand: '', productType: '' },
        ],
        transcriptWindow: [
          { id: 'seg-1', text: `okay let's move on to the ${product.title} now` },
        ],
      });
      expect(res.status, res.text.slice(0, 300)).toBeLessThan(400);
      const body = res.body as { decision?: string; productId?: string | null; source?: string };
      expect(body.decision, 'classifier returned no decision').toBeDefined();
      // The semantic tier is credential-gated. 'unavailable' is a legitimate
      // runtime state, but it must be REPORTED, never disguised as a considered
      // answer — that ambiguity is what let prod run keyless for days.
      if (body.source === 'unavailable') {
        expect(body.decision).toBe('unknown');
      }
    }, 60_000);
  });

  describe('10. auction and bidding', () => {
    let auctionId = '';

    it('starts an auction on the staged item', async () => {
      const res = await asSeller('POST', '/auctions/start', {
        eventId: EVENT_SCHEDULED,
        eventItemId: `${EVENT_SCHEDULED}:${product.productId}`,
        productId: product.productId,
        quantity: 1,
        startingPriceCents: 1_000,
        durationSec: 300,
        availableQty: product.quantity,
      });
      expect(res.status, `auction start failed: ${res.text.slice(0, 300)}`).toBeLessThan(300);
      auctionId = String((res.body as { id?: string; auction?: { id?: string } }).id
        ?? (res.body as { auction?: { id?: string } }).auction?.id ?? '');
      expect(auctionId.length, 'auction start returned no id').toBeGreaterThan(0);
    }, 60_000);

    it('exposes the auction as active on the event', async () => {
      const res = await call('GET', `/auctions/events/${EVENT_SCHEDULED}/active`, { principal: BUYER });
      expect(res.status).toBe(200);
      expect(res.text, 'started auction is not visible as active').toContain(auctionId);
    }, 60_000);

    it('accepts a buyer bid above the current price', async () => {
      const res = await asBuyer('POST', `/auctions/${auctionId}/bids`, {
        bidderId: BUYER,
        displayName: 'E2E Buyer',
        amountCents: 1_500,
      });
      expect(res.status, `bid rejected: ${res.text.slice(0, 300)}`).toBeLessThan(300);

      const after = await call('GET', `/auctions/${auctionId}`, { principal: BUYER });
      expect(after.status).toBe(200);
      expect(after.text, 'the accepted bid is not reflected on the auction').toContain('1500');
    }, 60_000);

    it('REJECTS a bid below the current price (control: the bid rail actually bites)', async () => {
      const res = await asBuyer('POST', `/auctions/${auctionId}/bids`, {
        bidderId: BUYER,
        displayName: 'E2E Buyer',
        amountCents: 100,
      });
      expect(res.status, 'an underbid was accepted').toBeGreaterThanOrEqual(400);
    }, 60_000);

    it('closes the auction', async () => {
      const res = await asSeller('POST', `/auctions/${auctionId}/close`, {});
      expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
    }, 60_000);
  });
});

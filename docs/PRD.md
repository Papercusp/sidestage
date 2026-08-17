# SideStage — Product Requirements Document

SideStage is a real-time AI copilot for live-commerce sellers: one place to run
a live selling event — video, chat, catalog, inventory, auctions, checkout —
with an assistant whose replies and actions are grounded in the seller's own
catalog, listing, and policy data, and guarded before anything reaches a buyer.

## The problem

Live-commerce sellers juggle chat, product questions, listings, inventory, and
conversion at the same time, on camera. Mistakes are expensive in both
directions: a wrong price or inventory claim burns trust; slow answers lose the
sale. The wedge is a copilot that centralizes engagement and operational
actions while keeping automation grounded and controlled.

## Users

- **Seller (host)** — runs the event: camera, product lineup, chat triage,
  offers, auctions. Wants speed with control: nothing sent or changed without
  grounding, and risky actions gated behind approval.
- **Buyer (viewer)** — picks a live room from the channel guide (the left-hand
  sidebar listing every live and upcoming event): watches, chats, holds items,
  bids, checks out. Wants a fast, honest shop: live availability, real prices,
  instant answers.

## Product shape — one site, two work groups

A persistent channel guide (left sidebar) lists every live and upcoming room;
the top nav groups pages into buyer work and operator work.

| Page | Audience | Job |
| --- | --- | --- |
| **Watch** | buyers | Watch the stream, chat with the room, browse the drop, hold items, bid in the live auction, check out. |
| **Orders** | buyers | Review purchases and product moments. |
| **Studio** | host | Live console: camera + room controls, live transcript with product-mention detection driving the on-deck slot, copilot reply suggestions (approve/edit/skip), room chat with triage, lineup and run-of-show, and the event's guardrail settings (reply tone, always-ask policies: price changes, inventory claims, buyer-sensitive topics). |
| **History** | host | Review shipped build history. |
| **Tests** | host | Launch readiness: live preflight probes, a deterministic N-user × M-msg/s load rehearsal of the copilot seam, and the reply judge grading grounding/policy/price/tone before buyers ever see a reply. |
| **Architecture** | reviewers | How SideStage works, from the running app. |

A native mobile companion (iOS and Android) builds from the public
`sidestage-mobile` repo; the topbar app badges link to it.

## Requirements (from the challenge brief)

1. **Live chat ingestion with grounded replies** — the room chat streams into
   the copilot pipeline; suggested/automatic replies are grounded in catalog,
   listing, and policy data, with grounding sources attached.
2. **Guardrails before send** — price, availability, policy, and tone checks
   run server-side on every reply and action *before* anything is sent;
   uncertain replies stay in review.
3. **Listing/inventory actions** — push (to stage), swap, markdown, and stock
   adjustment as guarded actions with audit records; markdowns respect the
   configured cap and price floors.
4. **On-demand product research** — sub-2-second reply latency budget,
   tracked; research findings enter replies as labelled grounding sources.
5. **Depth area: agentic-write safety** — the guarded-action service (policy
   gate + audit + rollback), the deterministic reply judge, and the load
   simulator together prove the automation stays inside its guardrails under
   pressure.

## Commerce model

- **Catalog** — product groups × variants with per-variant price, condition,
  handling, and trigger-maintained availability. The demo event lineup uses a
  small seeded catalog of demo products; the production instance additionally
  carries a 1.1M-product real-world import behind browse and search. Search is
  Typesense-backed with a Postgres full-text fallback.
- **Inventory integrity** — every hold (buyer hold, auction quantity,
  event limit) is a source-tracked reservation in Postgres; availability is
  derived, never hand-counted; holds are idempotent per source and released on
  auction close without a winner.
- **Auctions** — one active auction per event with quantity holds taken at
  start; bids are ordered server-side; close produces a winner order that
  retains the reservation into checkout.
- **Checkout** — Stripe test-mode payments over the cart; orders persist with
  status; shipping via the box-packing estimator.

## Demo identity — no auth, switchable users

The demo deliberately ships with no authentication. Identity is a demo seam:
the topbar **User id** field (with the **Switch** button) sets the active
identity for the whole app — type any non-empty id to impersonate that user,
and buyer/seller surfaces role-prefix it so the two roles never collapse into
one participant. A first-time visitor gets an auto-minted anonymous id; seller
surfaces (Studio) resolve anonymous visitors to the seeded `demo-seller`
identity, which owns the demo catalog and the prefilled demo room. This makes
multi-user flows testable from one browser: switch ids to act as different
buyers, or clear back to the seed seller.

## The first seller workflow

The workflow SideStage ships first — run one live selling event end to end:

1. **Prep** (Studio → Event manager): create the event, reserve real catalog
   inventory into the lineup with event prices and quantity limits, set the
   guardrails (reply tone; always-ask policies for price changes, inventory
   claims, buyer-sensitive topics), plan the run of show.
2. **Go live** (Studio → Current event): start the camera; the room path
   publishes; buyers join from the channel guide.
3. **Sell with the copilot**: the live transcript detects product mentions and
   drives the on-deck slot; room chat streams into the copilot, which drafts
   grounded replies into the review queue (approve / edit / skip); guarded
   actions — push to stage, swap, markdown, stock adjustment, targeted offer,
   auction launch — run through the audited executor.
4. **Close**: end the event; holds settle or release; orders and product
   moments land in Orders; the seller reviews what sold and what the copilot
   handled.

## The copilot-to-automation ladder

Automation earns autonomy one rung at a time; every rung passes the same
server-side guardrail gate, and the seller's policy chooses the rung per
action class:

| Rung | Behavior | Gate |
| --- | --- | --- |
| **0 — Observe** | Transcript + product-mention detection annotate the room; nothing is sent. | — |
| **1 — Suggest** | Copilot drafts grounded replies into the review queue; seller approves, edits, or skips. | Grounding + policy checks decide what is even suggested. |
| **2 — Auto-send within guardrails** | Replies that pass grounding, price, availability, and tone checks send automatically; uncertain replies fall back to rung 1. | Deterministic server-side gate on every reply. |
| **3 — Guarded actions** | Listing/inventory writes (push, swap, markdown, stock, offer) execute through the audited executor with before/after records and rollback; always-ask policies force per-action confirmation. | Policy gate + audit + rollback. |
| **4 — Unattended writes** | Rejected for this build: no write path exists that bypasses the policy gate and audit. | Structurally absent. |

## Pilot plan — 3–5 sellers

- **Cohort**: 3–5 active live-commerce sellers (existing audience, weekly
  cadence, catalog of 50+ SKUs) recruited from wholesale/liquidation and
  collectibles niches, where price/availability mistakes are costliest.
- **Shape**: two weeks, each seller running their normal weekly events on
  SideStage. Week 1 at rung 1 (suggest-only) to calibrate grounding and tone
  against real rooms; week 2 graduates chat replies to rung 2 and enables
  rung-3 guarded actions with always-ask on markdowns.
- **Instrumentation**: every event already records the metrics below (judge
  scores, reply latencies, action audit trail, order attribution); the pilot
  adds a weekly seller debrief on trust: what they overrode, what they stopped
  checking.
- **Exit criteria**: sellers keep rung 2 enabled voluntarily in week 2+, and
  the metrics hit the targets below on at least half the cohort's events.

## Success metrics — GMV and operator load

- **GMV**: gross merchandise value per event and items sold per live hour,
  against each seller's trailing baseline; target **+15% GMV per event** by
  pilot end. Attribution: orders created during copilot-assisted events, with
  auction and hold conversion rates tracked separately.
- **Operator load**: seller interventions per 100 chat messages (edits +
  manual replies + overrides; target **≤ 25** by week 2), median
  chat-to-answer latency (target **< 5s** with copilot vs. minutes unaided),
  and share of replies auto-sent within guardrails (target **≥ 60%** at
  rung 2 with judge pass rate ≥ threshold on all four dimensions).

## Non-goals (this build)

- Multi-seller marketplaces, seller onboarding, or payments beyond Stripe
  test mode.
- Moderation tooling beyond the guardrail/judge path.
- Accounts/auth: the identity seam above is a demo affordance, not a login
  system.

## Success criteria

- A reviewer can clone, `npm install`, `npm run dev`, and `npm test` from the
  README alone and reach a working app (CI-verified).
- The public instance serves the real catalog at
  https://sidestage.papercusp.com.
- The judge rehearsal passes its threshold on the four dimensions
  (grounding, policy, price correctness, tone) and the load rehearsal covers
  the seven scripted scenario kinds.

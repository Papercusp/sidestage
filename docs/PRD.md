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

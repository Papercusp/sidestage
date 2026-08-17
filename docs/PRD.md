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
- **Buyer (viewer)** — joins a room from a share link: watches, chats, holds
  items, bids, checks out. Wants a fast, honest shop: live availability,
  real prices, instant answers.

## Product shape — one site, four tabs

| Tab | Audience | Job |
| --- | --- | --- |
| **Buyer** | buyers | Watch the stream, chat with the room, browse the drop, hold items, bid in the live auction, check out. |
| **Seller** | host | Live console: camera + room controls, live transcript with product-mention detection driving the on-deck slot, copilot reply suggestions (approve/edit/skip), room chat with triage, event lineup management. |
| **Config** | host | The event's terms and guardrails: name, reply tone, and the always-ask policies the copilot must respect (price changes, inventory claims, buyer-sensitive topics). |
| **Test** | host | Launch readiness: live preflight probes, a deterministic N-user × M-msg/s load rehearsal of the copilot seam, and the reply judge grading grounding/policy/price/tone before buyers ever see a reply. |

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

- **Catalog** — the real Restart catalog model (product groups × variants with
  per-variant price, condition, handling, and trigger-maintained
  availability). The demo ships with a seed; the production instance carries
  the full 1.1M-product import. Search is the same Typesense-backed search the
  Restart wholesale grid uses, with SQL fallback.
- **Inventory integrity** — every hold (buyer hold, auction quantity,
  event limit) is a source-tracked reservation in Postgres; availability is
  derived, never hand-counted; holds are idempotent per source and released on
  auction close without a winner.
- **Auctions** — one active auction per event with quantity holds taken at
  start; bids are ordered server-side; close produces a winner order that
  retains the reservation into checkout.
- **Checkout** — Square sandbox sessions over the cart; orders persist with
  status; shipping via the box-packing estimator.

## Non-goals (this build)

- Multi-seller marketplaces, seller onboarding, or payments beyond the Square
  sandbox.
- Mobile-native clients; the web app is responsive but desktop-first.
- Moderation tooling beyond the guardrail/judge path.

## Success criteria

- A reviewer can clone, `npm install`, `npm run dev`, and `npm test` from the
  README alone and reach a working app (CI-verified).
- The public instance serves the real catalog at
  https://sidestage.papercusp.com.
- The judge rehearsal passes its threshold on the four dimensions
  (grounding, policy, price correctness, tone) and the load rehearsal covers
  the seven scripted scenario kinds.

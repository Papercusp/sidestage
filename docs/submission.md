# SideStage submission packet

SideStage is a live-selling copilot for event sellers and buyers. This packet is
the reviewer-facing answer sheet for the contest submission: it records the
clean-clone commands, the shortest product walkthrough, the implementation
evidence, and the required AI-use disclosure.

Read first: [`PRD.md`](PRD.md) (product requirements) and [`TDD.md`](TDD.md)
(technical design) — then verify against the prototype and source.

## Submission fields

| Field | Answer |
| --- | --- |
| Project | SideStage — Live Selling Copilot |
| Repository | <https://github.com/Papercusp/sidestage> |
| Live demo | <https://sidestage.buyrestart.com> — the public instance, serving the real catalog. (The clean-clone path below remains the reviewer-verifiable route.) |
| Run command | `npm run dev` |
| Test command | `npm test` |
| Full local gate | `npm run check` followed by `npm run build` |
| Primary product surface | `apps/web` — the Buyer, Seller, Config, and Test tabs |
| API surface | `apps/api` — NestJS on port `3100`, with `/healthz` for readiness |
| Optional local infrastructure | `docker compose up -d` for Postgres, Typesense, Redis, and MediaMTX |

The repository is public and retains its incremental commit history. No private
checkout, credential, or local database is required for the default demo. Copy
`.env.example` to `.env`; its values are development placeholders only.

## Clean-clone path

```bash
git clone --recurse-submodules https://github.com/Papercusp/sidestage.git
cd sidestage
cp .env.example .env
npm install
npm run dev
```

The web shell is served at <http://localhost:5173>. The API health check is
<http://localhost:3100/healthz>. Start Docker Compose before using persistence,
catalog search, or MediaMTX streaming:

```bash
docker compose up -d
```

For a deterministic verification run:

```bash
npm test
npm run typecheck
npm run build
```

`npm run check` is the shorter equivalent of the first two commands.

## Reviewer walkthrough

1. Open the default Buyer tab. Inspect the seeded live catalog, product prices
   and availability, the room chat, and the event share link. Use **Hold item**
   to exercise the local buyer state; use the auction panel when the auction
   fixture is visible.
2. Open **Seller**. Keep the default `sunday-drop` room id, click **Start
   event**, and grant camera/microphone access when MediaMTX is running. The
   Seller view exposes the WHIP publisher, transcript/product mention seam,
   verified catalog copilot, event chat, and event manager in one workflow.
3. In **Config**, review the event name, reply tone, and the visible price,
   inventory, and buyer-sensitive-topic guardrails. These controls document the
   seller policy contract used by the copilot; the current preview save control
   is intentionally not presented as durable persistence.
4. In **Test**, review the preflight statuses, then run **Run load rehearsal**
   with the defaults (3 users, 2 messages per user per second, 4 seconds). The
   result reports scheduled messages, simulated clients, duration, and coverage
   across the scripted price, shipping, policy, variant, stock, offer, and bid
   prompts.
5. For API-backed flows, keep the API process from `npm run dev` running and
   use the copilot/catalog, chat, auction, and checkout seams from the UI. The
   guarded action and shipping packer contracts are available through the API
   and are directly covered by the API tests listed below.

## What is implemented

| Capability | Source and verification evidence |
| --- | --- |
| Four-tab seller/buyer shell and URL state | `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx` |
| Catalog grounding, cart, and sandbox checkout seam | `apps/api/src/scout`, `apps/api/src/cart`, `apps/api/src/checkout`, `apps/web/src/CopilotPanel.tsx` |
| Seller event creation, active item focus, chat, and transcript | `apps/web/src/events`, `apps/web/src/EventChat.tsx`, `apps/web/src/TranscriptPane.tsx` |
| WHIP/WHEP seller and buyer streaming | `apps/web/src/streaming.ts`, `apps/web/src/streaming.test.ts` |
| Price, markdown, availability, policy, and tone guardrails | `apps/api/src/copilot/guardrail.ts`, `apps/api/src/copilot/guardrail.test.ts`, `apps/api/src/copilot/copilot.pipeline.test.ts` |
| Guarded actions, immutable before/after audit records, and rollback | `apps/api/src/actions/action.service.ts`, `apps/api/src/actions/action.service.test.ts` |
| Auctions, quantity holds, bids, close, and buyer panel | `apps/api/src/auction`, `apps/web/src/AuctionPanel.tsx`, `apps/web/src/auction.test.tsx` |
| Deterministic reply judge and load rehearsal | `apps/api/src/judge`, `apps/web/src/judge.ts`, `apps/web/src/load-simulator.ts` and their focused tests |
| Restart-compatible catalog and variations data | `docs/data-model.md`, `docs/variations-schema.md`, `db/schema.sql`, `db/seed/demo.sql` |

The copilot pipeline sends only verified event/catalog/policy context to the
provider seam, requires citations for grounded replies, and returns a safe
fallback when context is incomplete. Action proposals are evaluated again at
the server boundary; seller policy controls whether an action is suggested,
awaits confirmation, or can execute through the audited executor.

## Why the Restart stack is reused

The public repo reuses the Restart-compatible shared libraries as pinned
submodules and keeps app-specific composition under `apps/`. This preserves the
catalog, variation, sync, SSE, and UI primitives that are useful to a live
commerce prototype while keeping the SideStage API and browser contract
reviewable in one clean clone. The mapping and data policy are documented in
[`docs/data-model.md`](data-model.md),
[`docs/variations-schema.md`](variations-schema.md), and
[`docs/config-policies.md`](config-policies.md).

## AI-use disclosure

- **What the AI wrote:** AI agents wrote the initial workspace scaffold and the
  majority of the prototype implementation, including the API modules, React
  surfaces, deterministic tests, data fixtures, and this submission packet.
  The public commit history keeps those increments visible instead of
  flattening them into one generated snapshot.
- **What the human rewrote or rejected:** Human review selected the Restart
  reuse strategy, set the four-tab product shape, and ratified the
  suggestion-first automation ladder, server-side guardrail gate, audit and
  rollback boundary, and clean-clone/public-repo requirements. Autonomous
  writes without the configured policy and audited executor were rejected.
- **What broke and how it was debugged:** During the judge integration, the
  professional-tone check carried an invalid surrogate-style emoji regex. The
  focused judge path exposed the malformed expression; it was replaced with a
  Unicode `Extended_Pictographic` check and kept behind the deterministic judge
  tests. The same focused-test workflow is used for guardrails, actions,
  auctions, chat, checkout, streaming, and load rehearsal.

## Known limits disclosed to reviewers

- The public deploy/live URL is not available yet because the separate P-027
  infrastructure item is blocked; this packet does not imply that a URL exists.
- The default demo can be explored without Docker, but persistence, search, and
  WHIP/WHEP media require the corresponding local services.
- The Config surface currently demonstrates the policy controls; its preview
  save button is not a claim that settings are persisted across sessions.
- Provider credentials are optional seams. Never commit a real token; use the
  ignored `.env` file for local experiments.

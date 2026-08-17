# SideStage submission packet

SideStage is a live-selling copilot for event sellers and buyers. This packet is
the reviewer-facing answer sheet for the contest submission: it records the
filled-in reply template, the clean-clone commands, the shortest product
walkthrough, the implementation evidence, and the required AI-use disclosure.

Read first: [`PRD.md`](PRD.md) (product requirements) and [`TDD.md`](TDD.md)
(technical design) — then verify against the prototype and source. That is the
review order the brief states, and both documents are kept in sync with
[`challenge-brief.md`](challenge-brief.md).

## Submission reply template (filled in)

Copy-ready answers for each required line of the brief's reply template:

- **PRD:** [`docs/PRD.md`](PRD.md) — first seller workflow, copilot-to-automation
  ladder, 3–5-seller pilot plan, GMV and operator-load success metrics.
- **TDD:** [`docs/TDD.md`](TDD.md) — streaming ingestion, catalog grounding,
  reply guardrails, action auditability and rollback, latency budgets,
  marketplace integrations.
- **Prototype:** <https://sidestage.papercusp.com> (live public instance), or
  `npm run dev` from a clean clone (details below).
- **Source code:** <https://github.com/Papercusp/sidestage> — public, full
  incremental commit history retained (never squashed).
- **Access notes / credentials:** None required. The repo is public, the live
  demo is unauthenticated, and the clean-clone demo runs from
  `.env.example` placeholders. Provider keys are optional seams; nothing
  requires a private credential to review.
- **What I personally built:** The product direction and every ratifying
  decision: the Restart reuse strategy, the surface layout (Watch / Orders /
  Studio / History / Tests / Architecture), the suggestion-first automation
  ladder, the server-side guardrail gate, the audit-and-rollback boundary, and
  the clean-clone/public-repo requirements. Continuous review and steering of
  the agent-written increments, including rejecting autonomous writes without
  policy and audit.
- **What I reused:** The Restart-compatible shared libraries pinned as
  submodules (catalog and variations data model, the sync transport ladder —
  WebSocket/Rocicorp Zero, SSE, and bounded polling — grid, drawer and UI
  primitives) — see
  [`docs/data-model.md`](data-model.md) and
  [`docs/variations-schema.md`](variations-schema.md); MediaMTX and coturn for
  WHIP/WHEP media; Stripe, EasyPost, Deepgram and Typesense as provider seams.
- **What the AI wrote, and what I rewrote or rejected:** AI agents wrote the
  workspace scaffold and the majority of the implementation (API modules, React
  surfaces, deterministic tests, fixtures, this packet). Human review rewrote
  the product shape decisions above and rejected autonomous writes that lacked
  the configured policy gate and audited executor. The public commit history
  keeps those increments visible instead of flattening them.
- **What broke and how I debugged it:** During the judge integration, the
  professional-tone check carried an invalid surrogate-style emoji regex; the
  focused judge test path exposed the malformed expression, and it was replaced
  with a Unicode `Extended_Pictographic` check kept behind the deterministic
  judge tests. The same focused-test workflow (fail → isolate in a focused
  spec → fix → re-run the suite) is used for guardrails, actions, auctions,
  chat, checkout, streaming, and load rehearsal.

## Part 2 — AI interview logistics

The interview starts **within 30 minutes of sending the submission** — plan the
submission and the 60-minute voice interview as one sitting. The
candidate-specific DeepInterview assignment **expires 72 hours** after the
challenge email (24 hours after the 48-hour build deadline). Keep this repo
open during the interview: it asks for exact files, functions, and commands,
which are reconciled against the repo afterward. Useful anchors are listed in
"What is implemented" below.

## Submission fields

| Field | Answer |
| --- | --- |
| Project | SideStage — Live Selling Copilot |
| Repository | <https://github.com/Papercusp/sidestage> |
| Live demo | <https://sidestage.papercusp.com> — the public instance, serving the real catalog. (The clean-clone path below remains the reviewer-verifiable route.) |
| Run command | `npm run dev` |
| Test command | `npm test` |
| Full local gate | `npm run check` followed by `npm run build` |
| Primary product surface | `apps/web` — the Watch, Orders, Studio, History, Tests, and Architecture surfaces |
| Native mobile app (buyer) | <https://github.com/Papercusp/sidestage-mobile> — v1.0.0 builds (signed Android APK + AAB, unsigned iOS IPA, provenance): <https://github.com/Papercusp/sidestage-mobile/releases/tag/v1.0.0> |
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

1. Open the default **Watch** surface. Inspect the seeded live catalog with
   prices and availability in the product rail, the room chat, and the buyer
   Scout drawer. Use **Hold item** to exercise a reservation; use the auction
   panel when the auction fixture is visible, and the cart drawer for the
   checkout seam.
2. Open **Studio**. Click **Start event** and grant camera/microphone access
   when MediaMTX is running. Studio is the full seller workflow in one place:
   the WHIP publisher, the live transcript and product-mention seam, the
   copilot **review queue** (grounded reply and action proposals awaiting
   approval), the run-of-show pane, event chat, and the event manager for
   lineup and staging.
3. Still in **Studio**, open the guardrail settings. The visible price,
   inventory, tone, and buyer-sensitive-topic guardrails document the seller
   policy contract used by the copilot, including the per-action automation
   ladder (suggest → confirm → auto). Settings save through the API and report
   their save state explicitly.
4. In **Tests**, review the preflight statuses, then run **Run load rehearsal**
   with the defaults (3 users, 2 messages per user per second, 4 seconds). The
   result reports scheduled messages, simulated clients, duration, and coverage
   across the scripted price, shipping, policy, variant, stock, offer, and bid
   prompts.
5. Open **Architecture** for the source-backed system map — including "How the
   LLM pipeline works" — and **History** for shipped plans and delivery
   evidence. For API-backed flows, keep the API process from `npm run dev`
   running; the guarded action and shipping packer contracts are available
   through the API and are directly covered by the API tests listed below.

## What is implemented

| Capability | Source and verification evidence |
| --- | --- |
| Six-surface shell (Watch, Orders, Studio, History, Tests, Architecture) with URL-routed state | `apps/web/src/App.tsx`, `apps/web/src/app-routing.ts`, `apps/web/src/App.test.tsx` |
| Catalog grounding, cart, and sandbox checkout seam | `apps/api/src/scout`, `apps/api/src/cart`, `apps/api/src/checkout`, `apps/web/src/CopilotPanel.tsx` |
| Seller event creation, active item focus, chat, and transcript | `apps/web/src/events`, `apps/web/src/EventChat.tsx`, `apps/web/src/TranscriptPane.tsx` |
| WHIP/WHEP seller and buyer streaming | `apps/web/src/streaming.ts`, `apps/web/src/streaming.test.ts` |
| Price, markdown, availability, policy, and tone guardrails | `apps/api/src/copilot/guardrail.ts`, `apps/api/src/copilot/guardrail.test.ts`, `apps/api/src/copilot/copilot.pipeline.test.ts` |
| Guarded actions, immutable before/after audit records, and rollback | `apps/api/src/actions/action.service.ts`, `apps/api/src/actions/action.service.test.ts` |
| Auctions, quantity holds, bids, close, and buyer panel | `apps/api/src/auction`, `apps/web/src/AuctionPanel.tsx`, `apps/web/src/auction.test.tsx` |
| Deterministic reply judge and load rehearsal | `apps/api/src/judge`, `apps/web/src/judge.ts`, `apps/web/src/load-simulator.ts` and their focused tests |
| Restart-compatible catalog and variations data | `docs/data-model.md`, `docs/variations-schema.md`, `db/schema.sql`, `db/seed/demo.sql` |
| Native mobile buyer apps (shared Rust core; UniFFI Kotlin/Swift bindings; Kotlin + Swift UIs) | [`Papercusp/sidestage-mobile`](https://github.com/Papercusp/sidestage-mobile) — `crates/`, `android/`, `ios/`; [v1.0.0 release](https://github.com/Papercusp/sidestage-mobile/releases/tag/v1.0.0) with signed APK + AAB, unsigned iOS IPA, and build-provenance manifest |

The reasoning behind each UI surface — why the shell splits into buyer and
operator work groups, why Studio names the event lifecycle in its tabs, why
the engagement overlay is video-owned, and the design-pass evidence for each
choice — is written up in [`TDD.md` § UI design rationale](TDD.md#ui-design-rationale--why-the-surfaces-are-shaped-the-way-they-are),
with the underlying mockup passes committed under `design/*`.

The copilot pipeline sends only verified event/catalog/policy context to the
provider seam, requires citations for grounded replies, and returns a safe
fallback when context is incomplete. Action proposals are evaluated again at
the server boundary; seller policy controls whether an action is suggested,
awaits confirmation, or can execute through the audited executor.

## Native mobile app (buyer)

The buyer surface also ships as native Android and iOS apps from the public
companion repo [`Papercusp/sidestage-mobile`](https://github.com/Papercusp/sidestage-mobile).
Builds are on the
[v1.0.0 release page](https://github.com/Papercusp/sidestage-mobile/releases/tag/v1.0.0):
a signed APK (direct sideload, reviewer-installable), a signed AAB (Play
bundle), an **unsigned** iOS IPA (`SideStage-unsigned-v1.0.0.ipa` — a build
artifact, not end-user installable; installing it requires re-signing with an
Apple Developer certificate), and a `release-provenance.json` recording the
source commit and artifact SHA-256 hashes. The builds target the live backend
at <https://sidestage.papercusp.com/api>.

Tech stack: the domain logic, API client, and sync live in a shared **Rust**
core (`crates/`), cross-compiled for all four Android ABIs (arm64-v8a,
armeabi-v7a, x86, x86_64) with `cargo-ndk`; **UniFFI** generates the Kotlin
bindings over that core (checksum-verified at build time); the UI is
**Kotlin** under `android/`, built with Gradle/AGP (min SDK 33, target
SDK 36, 16 KB-page-aligned native libraries). The iOS app under `ios/` is a
SwiftUI shell over the same Rust core (`aarch64-apple-ios` +
`SideStageCore.xcframework`, UniFFI Swift bindings, XcodeGen project, Xcode
16.4); its published v1.0.0 IPA is unsigned — signing requires an Apple
Developer certificate.

## Why the Restart stack is reused

The public repo reuses the Restart-compatible shared libraries as pinned
submodules and keeps app-specific composition under `apps/`. This preserves the
catalog, variation, sync-transport, and UI primitives that are useful to a live
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
  reuse strategy, set the product surface shape, and ratified the
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

- The public instance at <https://sidestage.papercusp.com> is live and serves
  the real catalog. It is a single-box deployment (one Hetzner host, Docker
  Compose behind Traefik) with no redundancy or autoscaling: it is a reviewable
  demo, not a high-availability service. Releases are pinned per-commit and a
  previous release can be restored with `./deploy/rollback.sh`; a failed health
  check rolls the deploy back automatically.
- The default demo can be explored without Docker, but persistence, search, and
  WHIP/WHEP media require the corresponding local services.
- Realtime application state runs on the shared sync library's WebSocket-first
  ladder: the app opens a WebSocket (Rocicorp Zero) session and steps down to
  SSE, then to bounded polling, on reachability failure only. The browser client
  is wired WebSocket-first in this build. The `zero-cache` sync server it
  connects to is provisioned in the Compose stack and documented in
  [`infra/zero/README.md`](../infra/zero/README.md), but it is **not yet running
  on the public instance**, so realtime state at
  <https://sidestage.papercusp.com> is served by the SSE rung today and the
  WebSocket rung steps down on connect. Reviewers should expect SSE on the
  public instance: no document in this packet claims WebSocket sync is serving
  it.
- Provider credentials are optional seams. Never commit a real token; use the
  ignored `.env` file for local experiments.

# SideStage

SideStage is a live-selling copilot for event sellers and buyers. The public
contest repo keeps the seller shell, API, streaming gateway, and shared Papercusp
libraries in one clean-clone-runnable npm workspace.

## Prerequisites

- Node.js 20.19+ and npm 10+
- Docker Compose (only needed for Postgres, Typesense, Redis, and MediaMTX)
- Git with submodule support

## Quick start

```bash
git clone --recurse-submodules https://github.com/Papercusp/sidestage.git
cd sidestage
cp .env.example .env
npm install
npm run dev
```

The web shell runs at <http://localhost:5173> and the API health endpoint is
<http://localhost:3100/healthz>. Start local infrastructure with
`docker compose up -d` before using persistence, search, or live media.

If the repository was cloned without submodules, initialize the pinned shared
libraries before installing:

```bash
git submodule update --init --recursive
```

## Verification

The reviewer-facing submission packet, walkthrough, and AI-use disclosure are in
[`docs/submission.md`](docs/submission.md).

The contest evaluator can run the project from a clean clone with these exact
commands:

Run command:

```bash
npm run dev
```

Test command:

```bash
npm test
```

For the complete local gate, run the test command plus the workspace typechecks
and production builds:

```bash
npm run check
npm run build
```

`npm run check` typechecks every workspace and runs the workspace tests. No
credentials belong in the repository; `.env.example` contains development-only
placeholders and the real `.env` is ignored.

## Workspace map

- `apps/web` — Vite + React seller/buyer SPA.
- `apps/api` — NestJS service; feature modules will be added here.
- `libs/` — pinned Papercusp shared submodules. Keep generic components in the
  shared libraries; app-specific composition belongs under `apps/`.
- `docker-compose.yml` — Postgres, Typesense, Redis zero-cache, and MediaMTX.

The UI starts with the blue-frost visual language: dark navy surfaces, frosted
panels, cyan accents, and semantic success/warning/danger tokens. Product flows
are layered onto this stable shell in later plan phases.

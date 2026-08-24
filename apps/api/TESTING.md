# TESTING — `@papercusp/sidestage-api`

## What this project's tests cover

- `apps/api/src/**/*.{test,spec}.ts` runs in the `sidestage-node` Vitest
  project. The suite covers the Nest modules, controllers, stores, guardrails,
  sync/parity contracts, database adapters, rehearsal/judge flows, and system
  test contracts.
- The default `sidestage-node` project sets `DATA_BACKEND=memory`, so ordinary
  API tests are hermetic. Tests that exercise a real Postgres store are opt-in
  with `SIDESTAGE_PG_INTEGRATION=1` and name that requirement in their file
  header.
- `apps/api/src/runtime-workspaces.test.ts`,
  `apps/api/src/vertex-env-wiring.test.ts`, and the other packaging/config
  specs check the production Docker image's workspace copies, Node engine
  floor, compose environment wiring, and runtime assumptions.

## What they don't cover

- Unit and contract tests do not prove that a freshly built image can start in
  Docker, reach its dependencies, or answer HTTP requests. Run the acceptance
  compose smoke below after Dockerfile, compose, bootstrap, or health changes.
- The default suite does not exercise a live Postgres, Typesense, Redis,
  MediaMTX, Traefik, TLS, or public DNS path. Provider calls and production
  credentials remain manual/integration concerns.
- Browser behavior belongs to the web project's guide; this guide covers the
  API process and its container boundary.

## Run after editing

- Editing one API module or spec →
  `npm run test:file -- apps/api/src/path/to/file.test.ts`.
- Editing a cross-cutting API service, module, or shared test helper →
  `npm run test --workspace @papercusp/sidestage-api`.
- Editing API TypeScript or its workspace dependencies →
  `npm run typecheck --workspace @papercusp/sidestage-api`.
- Editing `apps/api/Dockerfile`, `docker-compose*.yml`, runtime workspace
  packaging, or environment wiring →
  `npm run test:file -- apps/api/src/runtime-workspaces.test.ts apps/api/src/vertex-env-wiring.test.ts`
  followed by the Docker smoke below.
- Before handing off a broad API change → `npm run check` and then
  `npm run build` from the repository root. `check` runs the full test matrix
  and workspace typechecks; the separate build is the production compilation
  check.

For a real-Postgres integration spec, start the documented data stack first:

```bash
docker compose -f infra/docker-compose.data.yml up -d postgres
SIDESTAGE_PG_INTEGRATION=1 npm run test:file -- apps/api/src/db/path/to/file.integration.test.ts
```

## Local dev

From the repository root, copy `.env.example` to `.env` and run
`npm run dev`. The API listens on `API_PORT` (3110 by default) and its
unprefixed readiness endpoint is:

```bash
curl --fail --silent --show-error http://localhost:3110/healthz
```

The default demo can use the in-memory backend. For persistence, use
`docker compose -f infra/docker-compose.data.yml up -d postgres`; add
`docker compose up -d typesense redis mediamtx` for search, cache, and media.

## Docker runtime smoke

The acceptance overlay is the hermetic container check: it starts a fresh
Postgres, Typesense, Redis, MediaMTX, and API network, and its API healthcheck
fetches `http://127.0.0.1:3100/healthz`. From the repository root:

```bash
export SIDESTAGE_SHA="$(git rev-parse HEAD)"
export TYPESENSE_API_KEY=dev-typesense-key
export ACCEPTANCE_RUN_ID="api-guide-$(date +%s)"
export POSTGRES_USER=sidestage
export POSTGRES_PASSWORD=sidestage_dev
export POSTGRES_DB=sidestage
compose_args=(-p sidestage-api-smoke -f docker-compose.yml -f infra/docker-compose.acceptance.yml)
docker compose "${compose_args[@]}" up -d --build api
docker compose "${compose_args[@]}" exec -T api node -e '
  fetch("http://127.0.0.1:3100/healthz")
    .then(async (response) => {
      if (!response.ok) process.exit(1);
      const body = await response.json();
      if (body.status !== "ok" || body.service !== "sidestage-api" || body.sha !== process.env.SIDESTAGE_SHA) process.exit(1);
      console.log(body);
    })
    .catch(() => process.exit(1));
'
docker compose "${compose_args[@]}" down -v
```

Production does not publish the API port to the host. A production smoke must
therefore verify the public `/healthz` URL (or run the same fetch inside the
`api` container) and confirm that the reported `sha` equals the image SHA;
never treat `.deployed-sha` alone as proof that the running process is the
image that was intended.

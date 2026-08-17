# zero-cache — the WebSocket sync server

Runbook for the Rocicorp Zero sync tier: how it is wired on each tier, how to
bring it up, and the traps that have already cost time (here or on Restart).

## What it is

Browsers do not query Postgres. They hold a long-lived WebSocket to
**zero-cache**, which maintains its own SQLite replica of a subset of Postgres
via **logical replication** and serves materialized views from it.

```
browser ──WS /zero──► Traefik ──:4848──► zero-cache ──logical repl──► Postgres
                                              │                    (zero_publication)
                                              └──HTTP──► api :3100   (queries/mutations)
                                                         ZERO_QUERY_URL
                                                         ZERO_MUTATE_URL
```

zero-cache resolves **no** queries itself and bakes in **no** schema file — it
delegates both to the API over `ZERO_QUERY_URL` / `ZERO_MUTATE_URL`. See
[Status](#status--what-is-not-wired-yet) for what that means today.

## Files

| Path | What it is |
| --- | --- |
| `db/zero-publication.sql` | The publication (19 tables) zero-cache subscribes to. Idempotent. |
| `infra/zero/Dockerfile` | The prod image. Pins `@rocicorp/zero` from `package-lock.json`. |
| `scripts/zero-cache-start.sh` | Local-dev launcher (stale-lock recovery + heap). |
| `apps/api/src/sync/zero-publication.parity.test.ts` | Gate-run drift guard: publication ⇄ `libs/zero` contract. |
| `docker-compose.prod.yml` | Prod `zero-cache` service + Traefik labels + `sidestage-zero-replica` volume. |
| `infra/docker-compose.data.yml` | Dev Postgres (`wal_level=logical`, publication mount). |
| `docker-compose.yml` | Acceptance **base** — carries `wal_level=logical` too. |
| `infra/docker-compose.acceptance.yml` | Acceptance override; re-lists the publication mount. |

## Tiers

There are three, and **there is no `staging`** in this repo (no `ENV_TIER` /
`APP_ENV` / `DEPLOY_ENV` anywhere, no staging compose or host). "Staging" in the
P-003 brief maps to the acceptance stack.

| Tier | Postgres | zero-cache |
| --- | --- | --- |
| local dev | `infra/docker-compose.data.yml` (project `sidestage-data`, `127.0.0.1:55434`) | `scripts/zero-cache-start.sh` on the host |
| acceptance | `docker-compose.yml` + `infra/docker-compose.acceptance.yml` (ephemeral, always fresh) | not run — the publication exists so replication is *testable* |
| prod | `docker-compose.prod.yml` on `178.156.254.59:/opt/SideStage` | `zero-cache` service in the same compose |

## Local dev

```bash
docker compose -f infra/docker-compose.data.yml up -d postgres
# only needed on a pre-existing volume — see "The publication" below
docker compose -f infra/docker-compose.data.yml exec -T postgres \
  psql -U sidestage -d sidestage < db/zero-publication.sql
./scripts/zero-cache-start.sh
```

The launcher defaults `ZERO_UPSTREAM_DB` to
`postgresql://sidestage:sidestage_dev@127.0.0.1:55434/sidestage`, puts the
replica at `.zero/replica.db` (git-ignored — it is multi-GB), and clears stale
SQLite lock holders before starting. Override with `ZERO_UPSTREAM_DB`,
`DATABASE_URL`, `ZERO_REPLICA_FILE`, or `ZERO_HEAP_MB`.

`fuser` (package `psmisc`) must be installed or the launcher cannot clear stale
locks; it warns loudly rather than failing, but a later `SQLITE_BUSY: database is
locked` is then yours to clear by hand.

## The publication

### It is mounted, but the mount only fires on an empty volume

Every compose mounts `db/zero-publication.sql` into
`docker-entrypoint-initdb.d/`. That directory runs **only on first init of an
empty data directory**. An existing dev volume or the live prod volume will
*never* see the file that way. Apply it explicitly:

```bash
docker compose -f infra/docker-compose.data.yml exec -T postgres \
  psql -U sidestage -d sidestage < db/zero-publication.sql
```

### ⚠ Re-running the file does NOT widen an existing publication

`db/zero-publication.sql` guards `CREATE PUBLICATION` with
`IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='zero_publication')`.
On any database where the publication **already exists** — an established dev
volume, and prod — re-running the file is a **silent no-op**. It exits 0 and adds
nothing. So after adding a table to the contract, widening a *live* server needs:

```sql
ALTER PUBLICATION zero_publication ADD TABLE public.<name>;
```

The drift guard test protects the **file** (what a fresh database gets). No test
can see a live server's publication — that is what this paragraph is for.

### wal_level needs a RESTART, not a reload

`wal_level` is `postmaster`-scoped. `SELECT pg_reload_conf()` will not change it,
and `docker compose restart postgres` is what you want (the compose `command:`
already sets it, so this is only an issue on a container started before that
change landed). Under `wal_level=replica` the publication is created *happily*
and nothing ever replicates — Postgres warns only at `CREATE PUBLICATION`
("wal_level is insufficient to publish logical changes"), never at connect time.
The failure therefore looks like a silent, empty sync, not an error.

### Verify

```sql
SHOW wal_level;                        -- must be 'logical'
SELECT count(*) FROM pg_publication_tables WHERE pubname = 'zero_publication';
SELECT * FROM pg_publication_tables WHERE pubname = 'zero_publication';
SELECT slot_name, active, replay_lsn FROM pg_replication_slots;
```

Expect **19** tables. In the third query's `attnames`, confirm
`product_catalog.search_tsv` and `storefront_product.availableQty` do **not**
appear — the first is narrowed away by an explicit 27-column list, the second is
auto-excluded by PG16 as a generated column.

## Prod

**Never probe prod from the dev box** — the router's DNS is poisoned and the
results are misleading. Always `ssh root@178.156.254.59` first. Prod lives in
`/opt/SideStage` as its own compose project and must never touch `/opt/Restart`.

```bash
ssh root@178.156.254.59
cd /opt/SideStage

# 1. wal_level (the compose command: sets it; the running container predates it)
docker compose -f docker-compose.prod.yml up -d postgres   # recreate, not restart
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U sidestage -d sidestage -c 'SHOW wal_level'       # must print: logical

# 2. the publication — by hand; the initdb mount will not fire on this volume
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U sidestage -d sidestage -v ON_ERROR_STOP=1 < db/zero-publication.sql

# 3. zero-cache
docker compose -f docker-compose.prod.yml up -d --build zero-cache
docker compose -f docker-compose.prod.yml logs -f zero-cache
```

`ZERO_ADMIN_PASSWORD` is **fail-closed** (`${ZERO_ADMIN_PASSWORD:?}`): without it
in `.env.production`, `docker compose config` refuses to render at all. Optional
overrides: `ZERO_SHARD_ID` (default `sidestage`), `ZERO_HEAP_MB` (default
`12288`), `PUBLIC_HOSTNAME` (default `sidestage.buyrestart.com`).

The first sync is a full snapshot of ~3.5 GB and takes minutes; that is why the
container healthcheck has a 180s `start_period`.

### Traefik

Two labels are load-bearing:

- **`priority=10`** on router `sidestage-zero`. The web router is a `priority=1`
  catch-all on the *same* host; without the higher priority it swallows the
  WebSocket upgrade and the client silently degrades instead of erroring.
- **sticky cookie `zero_instance`**. A view-syncer connection is stateful — each
  client must return to the instance holding its materialized views. Without
  stickiness, scaling to a second replica corrupts query results rather than
  failing loudly.

### Sizing knobs you should not "optimize"

- **`NODE_OPTIONS=--max-old-space-size=12288` — do not tune down.** The initial
  snapshot is loaded into the JS heap. The published set measured **3476 MB** on
  2026-08-17 (`product_catalog` 2637 MB, `storefront_product` 836 MB, all 17
  others < 2 MB together). A smaller heap OOMs mid-sync, restarts, and never
  converges — Restart logged 92920 restarts in 30 days on a comparable snapshot
  before raising it. This is a knob where the conservative-looking value is the
  dangerous one.
- **Healthcheck `interval=5s` — keep it well under 20s.** zero-dispatcher
  self-drains (exits 0) if it sees no `/keepalive` within ~20s, so Docker's 30s
  default is *slower than the drain timeout* and produces an endless
  exit-and-restart loop.
- **`node:22-alpine` — do not align down to node:20** like `apps/api`/`apps/web`.
  `@rocicorp/zero` declares `engines.node >= 22`.
- **The version pin is derived from `package-lock.json`, never installed bare.**
  `npm install @rocicorp/zero` floats to latest on every rebuild; on Restart that
  skewed the server to 1.5.0 against a locked 1.3.0 client and crashlooped the
  change-streamer. The image build asserts the installed version equals the
  lockfile version, so the build itself proves the pin. Current pin: **1.8.0**.

## Adding a table to the sync contract

1. Add it to `libs/zero/src/schema.ts` (with its `.from('<pg_name>')`).
2. Add it to `db/zero-publication.sql`.
3. `npx vitest run apps/api/src/sync/zero-publication.parity.test.ts` — the drift
   guard derives the expected set dynamically from `REPLICATED_TABLES`, so a
   missing entry on either side fails by name.
4. On every **already-provisioned** database, `ALTER PUBLICATION … ADD TABLE`
   (see the no-op trap above). Fresh databases get it from the mount.

The table must have a **primary key or replica identity**. Publishing a keyless
table does not merely fail to replicate — every `UPDATE`/`DELETE` on it starts
erroring at the application layer ("cannot update table … because it does not
have a replica identity and publishes updates"). This is why
`storefront_product_option` gained
`PRIMARY KEY (variant_id, axis_id, value_id)` in the publication SQL, matching
the contract's declared `primaryKey` exactly.

## No grant script

Restart ships `bin/grant-zero-app-access.sh` because it splits a superuser role
from the app role, which then cannot touch zero's `zero_0` metadata schema.
SideStage has exactly **one** login role — `sidestage`, `SUPERUSER` +
`REPLICATION`, verified live — and the API connects as it, so it owns `zero_0`
outright. Do not port that script.

## Deliberate divergence from Restart

Restart converted `availableQty` from a `GENERATED` column into a
trigger-maintained regular column so it could replicate. SideStage instead
derives it client-side (`Math.max(0, qty - reservedQty)`) — no migration, no
trigger. **Do not align this back to Restart.**

## Status — what is not wired yet

This item (P-003) provisions the **infrastructure**. Two things are deliberately
outside it:

- **`ZERO_QUERY_URL` / `ZERO_MUTATE_URL` point at handlers that do not exist
  yet.** The API today exposes only `POST /sync/rest-query-batch`; there is no
  `/api/zero/query` or `/api/zero/mutate` route. Those are **P-004** (the
  transport flip). Until P-004 lands, a running zero-cache replicates fine but
  cannot serve client queries — do not read that as a provisioning fault.
- **Prod has not been brought up.** Nothing in this item was applied to
  `178.156.254.59`: the publication is not created there and `wal_level` is
  still `replica`. The prod section above is the procedure to do it, not a
  record that it was done.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Publication exists, `pg_replication_slots` empty, nothing syncs | `wal_level` is still `replica`. Recreate Postgres (§ wal_level). |
| `SQLITE_BUSY: database is locked: journal_mode = delete` | Orphan replicator holding the replica lock. `scripts/zero-cache-start.sh` clears it; needs `fuser`. |
| Container restarts every ~20–30s, logs look clean | Healthcheck interval ≥ the ~20s dispatcher drain timeout. |
| Restarts with heap/OOM traces, sync never completes | `ZERO_HEAP_MB` set too low. Leave it at 12288. |
| `cannot update table … does not have a replica identity` | A keyless table was published. Give it a PK. |
| WS connects but client silently falls back to polling | Traefik `priority` on `sidestage-zero` lost to the web catch-all. |
| Query results inconsistent across reloads with >1 replica | Sticky cookie `zero_instance` missing. |
| A newly-contracted table never appears in the replica | Re-running the SQL was a no-op. `ALTER PUBLICATION … ADD TABLE`. |

#!/usr/bin/env bash
#
# Provision + VERIFY zero-cache's logical replication on a deployed database.
# The production half of what scripts/zero-cache-start.sh does for local dev.
#
# WHY THIS EXISTS (WI-39712)
#   scripts/zero-cache-start.sh carries two preflights that catch the two ways
#   zero replication silently breaks — a non-logical wal_level, and a publication
#   that has drifted from db/zero-publication.sql. Those preflights NEVER RUN in
#   production: infra/zero/Dockerfile's CMD is ["node_modules/.bin/zero-cache"]
#   and docker-compose.prod.yml overrides no command/entrypoint, so the container
#   execs the binary directly. The dev launcher is not the fix for that — it ends
#   in `exec npx zero-cache-dev`, kills lock holders with fuser, and defaults to a
#   dev database URL. It is a DEV launcher and says so in its own header.
#
#   Worse, until this script existed nothing in the deploy pipeline applied
#   db/zero-publication.sql AT ALL. scripts/db-apply.sh applies db/schema.sql only;
#   the prod compose mounts db/*.sql into docker-entrypoint-initdb.d, which runs
#   ONLY on first init of an empty data directory — never on an existing volume.
#   Production's publication existed on 2026-08-17 solely because an agent applied
#   it BY HAND during the cutover. A fresh production, or one that gains a table,
#   would have had no publication or a drifted one, and clients would fail at
#   CONNECT with a ProtocolError naming the missing table.
#
# ORDERING — this must run AFTER `docker compose up -d`, not with the schema apply.
#   wal_level is set by the postgres `command:` flags, and a compose `command:`
#   change does nothing to an ALREADY-CREATED container until it is recreated. On
#   the deploy that first introduces those flags, the pre-`up` server still reports
#   wal_level=replica, so a check placed beside db-apply.sh would abort the very
#   deploy that fixes it. deploy/deploy.sh therefore calls this after Build + up
#   and before the health gate. (The tables this publication names are created by
#   the earlier db-apply.sh step, so they already exist by then.)
#
# EXIT CODES
#   0  publication applied and verified
#   1  usage / unreachable / unparsable — nothing was mutated
#   2  FATAL replication fault (wal_level, or declared-but-not-live drift)
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLICATION_FILE="$ROOT_DIR/db/zero-publication.sql"
PUBLICATION_NAME="${ZERO_APP_PUBLICATIONS:-zero_publication}"

[[ -f "$PUBLICATION_FILE" ]] || {
  echo "zero-replication-apply: publication file not found at $PUBLICATION_FILE" >&2
  exit 1
}

# Two execution branches, mirroring scripts/db-apply.sh exactly so both honour the
# same env: a direct URL for a host with psql, else `docker compose exec postgres`.
if [[ -n "${SIDESTAGE_DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null 2>&1 || {
    echo "zero-replication-apply: psql is required when SIDESTAGE_DATABASE_URL is set" >&2
    exit 1
  }
  pg_query() { psql "$SIDESTAGE_DATABASE_URL" -tAc "$1" 2>/dev/null || true; }
  pg_apply_file() { psql "$SIDESTAGE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"; }
else
  COMPOSE_FILE="${SIDESTAGE_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.data.yml}"
  COMPOSE_ARGS=(-f "$COMPOSE_FILE")
  if [[ -n "${SIDESTAGE_COMPOSE_ENV_FILE:-}" ]]; then
    [[ -f "$SIDESTAGE_COMPOSE_ENV_FILE" ]] || {
      echo "zero-replication-apply: compose env file not found at $SIDESTAGE_COMPOSE_ENV_FILE" >&2
      exit 1
    }
    COMPOSE_ARGS+=(--env-file "$SIDESTAGE_COMPOSE_ENV_FILE")
  fi
  # POSTGRES_USER / POSTGRES_DB are read INSIDE the container: an env file is
  # consumed by Compose for interpolation, not exported into this shell, so a
  # host-side default could silently target the wrong production database.
  #
  # ⚠ THE `</dev/null` IS LOAD-BEARING, not defensive tidying. `docker compose
  # exec -T` FORWARDS STDIN, so when this script is itself piped to a shell
  # (`ssh host 'bash -s' < script`) the first exec CONSUMES THE REST OF THE
  # SCRIPT and everything after it silently never runs. Cost a live cutover an
  # hour on 2026-08-17. Every query exec below closes stdin; only pg_apply_file,
  # which deliberately feeds the .sql file on stdin, does not.
  # ⚠ THE QUERY IS PASSED AS A POSITIONAL ARG, never interpolated into the sh
  # script text. Interpolating it inside single quotes -- `-tAc '$1'` -- breaks
  # the moment the query itself contains a single quote, which every predicate
  # here does (`where pubname='zero_publication'`): the embedded quotes close and
  # reopen the shell string, psql receives a BARE IDENTIFIER, and errors with
  # `column "zero_publication" does not exist`. Combined with the `2>/dev/null
  # || true` below that failure is indistinguishable from a real empty result,
  # so the caller concludes "publication has no tables" and the deploy
  # auto-rolls-back -- against a database whose publication is perfectly fine.
  # That cost four production deploys on 2026-08-17. The `wal_level` query
  # survived only because it happens to contain no quotes, which is exactly the
  # positive control that shows the instrument, not the database, was broken.
  # `sh -c '<script>' sh "$1"` binds the query to $1 INSIDE the container shell,
  # so no amount of quoting in the SQL can reach the script text.
  pg_query() {
    docker compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -c \
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh "$1" </dev/null 2>/dev/null || true
  }
  pg_apply_file() {
    docker compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -c \
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' < "$1"
  }
fi

# --- 1. wal_level must be logical, checked on the LIVE server -----------------
# Checked BEFORE creating anything: CREATE PUBLICATION SUCCEEDS under
# wal_level=replica (Postgres only WARNs), so provisioning first would leave a
# publication that lists every table while nothing can ever stream — the exact
# shape that stayed hidden for four days in dev. Note also that
# `show max_replication_slots` / `show max_wal_senders` both answer 10 whether or
# not the flags took effect, because 10 is the PG16 default for both; wal_level is
# the only one of the three that can reveal a stale container.
#
# The probe RETRIES rather than failing on the first empty answer. This script
# runs immediately after `docker compose up -d`, and a postgres that is still
# accepting-connections-any-second-now would otherwise read exactly like an
# unreachable one — aborting a perfectly good deploy. That false-fail shape (a
# probe treating "not yet" as "broken") is the same one that cost this pipeline a
# deploy on 2026-08-17; see WI-39708.
ZERO_REPLICATION_PROBE_ATTEMPTS="${ZERO_REPLICATION_PROBE_ATTEMPTS:-10}"
ZERO_REPLICATION_PROBE_SLEEP="${ZERO_REPLICATION_PROBE_SLEEP:-3}"
wal_level=""
for _attempt in $(seq 1 "$ZERO_REPLICATION_PROBE_ATTEMPTS"); do
  wal_level="$(pg_query 'show wal_level')"
  wal_level="${wal_level//[$'\r\n']/}"
  [[ -n "$wal_level" ]] && break
  sleep "$ZERO_REPLICATION_PROBE_SLEEP"
done

if [[ -z "$wal_level" ]]; then
  echo "zero-replication-apply: FATAL: could not read wal_level after $ZERO_REPLICATION_PROBE_ATTEMPTS attempts — the database is not reachable." >&2
  echo "  Nothing was applied. Check that the postgres service is up and healthy." >&2
  exit 1
fi

if [[ "$wal_level" != "logical" ]]; then
  cat >&2 <<EOF
zero-replication-apply: FATAL: upstream has wal_level=$wal_level, but zero-cache
  requires 'logical'. Logical replication is OFF, so nothing can stream.

  The compose file is very likely ALREADY correct and the CONTAINER is the stale
  part — a compose 'command:' change is not applied to an existing container.
  Recreate it (the named volume persists, so no data is lost):

    docker compose -f ${SIDESTAGE_COMPOSE_FILE:-docker-compose.prod.yml} up -d postgres

  Confirm with: docker inspect <postgres container> --format '{{.Config.Cmd}}'
  (a bare [postgres] means the flags are still not applied).
EOF
  exit 2
fi
echo "zero-replication-apply: wal_level=logical ok"

# --- 2. apply the publication (idempotent) ------------------------------------
# db/zero-publication.sql guards its CREATE with IF NOT EXISTS, so this is a
# no-op once the publication exists. That same guard is why step 3 below is not
# redundant with this one: re-running the file can never WIDEN an existing
# publication, so a table appended to the file after provisioning silently never
# lands. Applying and verifying are two different jobs.
pg_apply_file "$PUBLICATION_FILE"
echo "zero-replication-apply: applied db/zero-publication.sql"

# --- 3. the LIVE publication must match the DECLARED one ----------------------
# The declared list is parsed from the file rather than from the Zero contract on
# purpose: apps/api/src/sync/zero-publication.parity.test.ts already guarantees
# contract == file, so checking file == live here CHAINS onto it to give
# contract == live without re-deriving the contract in bash.
# (The same parse lives in scripts/zero-cache-start.sh's dev preflight. Keep the
# two identical — if you change one, change both.)
#
# The `|| true` is load-bearing under `set -Eeuo pipefail` on line 38: grep exits
# 1 when it matches nothing, and with pipefail a failing command substitution in
# an assignment ABORTS THE SCRIPT — which would make the degradation branches
# below unreachable.
declared_tables="$(
  sed -n '/CREATE PUBLICATION zero_publication FOR TABLE/,/^      );/p' \
    "$PUBLICATION_FILE" 2>/dev/null |
    grep -oE 'public\.[a-z_]+' | sed 's/^public\.//' | sort -u || true
)"
live_tables="$(
  pg_query "select tablename from pg_publication_tables where pubname='$PUBLICATION_NAME'" |
    tr -d '\r' | sed '/^$/d' | sort -u || true
)"

if [[ -z "$declared_tables" ]]; then
  echo "zero-replication-apply: FATAL: could not parse the declared table list from $PUBLICATION_FILE." >&2
  echo "  Refusing to report a clean bill of health from a parse that found nothing." >&2
  exit 1
fi

if [[ -z "$live_tables" ]]; then
  cat >&2 <<EOF
zero-replication-apply: FATAL: publication '$PUBLICATION_NAME' has no tables even
  though db/zero-publication.sql was just applied. Either the CREATE was skipped
  by its IF NOT EXISTS guard against an EMPTY publication of the same name, or the
  publication is named differently than ZERO_APP_PUBLICATIONS expects.
EOF
  exit 2
fi

# Declared-but-not-live is the failure that silently breaks clients.
missing="$(comm -23 <(echo "$declared_tables") <(echo "$live_tables") | tr '\n' ' ')"
# Live-but-not-declared still replicates, so it is a warning, not a stop.
extra="$(comm -13 <(echo "$declared_tables") <(echo "$live_tables") | tr '\n' ' ')"

if [[ -n "${missing// /}" ]]; then
  cat >&2 <<EOF
zero-replication-apply: FATAL: publication '$PUBLICATION_NAME' is MISSING table(s)
  that db/zero-publication.sql declares:

    ${missing}

  Re-running the file will NOT fix this — its CREATE is guarded by IF NOT EXISTS,
  so it is a no-op against an existing publication. Widening replication on a live
  database takes an explicit ALTER:

$(for t in ${missing}; do
  echo "    ALTER PUBLICATION $PUBLICATION_NAME ADD TABLE public.${t};"
done)

  This is NOT applied automatically: a table joining a publication must have a
  replica identity, and adding one that lacks a primary key makes UPDATE/DELETE
  ERROR OUT at the application rather than merely fail to replicate. Check the
  table's key first (db/zero-publication.sql does exactly that for
  storefront_product_option), then run the ALTER.

  Left unfixed, a client querying one of those tables fails at CONNECT time with a
  ProtocolError ("... does not exist or is not one of the replicated tables").
EOF
  exit 2
fi

if [[ -n "${extra// /}" ]]; then
  echo "zero-replication-apply: WARN: publication has table(s) the file does not declare: ${extra}" >&2
fi

echo "zero-replication-apply: ok — publication '$PUBLICATION_NAME' matches db/zero-publication.sql ($(echo "$declared_tables" | wc -l) tables)"

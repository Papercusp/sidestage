#!/usr/bin/env bash
#
# zero-cache launcher for LOCAL DEVELOPMENT, with stale-replica-lock recovery.
#
# Why this wrapper exists rather than a bare `npx zero-cache-dev`:
#
# 1. STALE SQLITE LOCKS. When zero-cache stops or crashes, its replicator worker
#    can survive as an orphan holding an exclusive lock on the SQLite replica
#    file. The next start then dies with
#      SQLITE_BUSY: database is locked: journal_mode = delete
#    and :4848 stays DOWN, which makes the web app's WebSocket upgrade probe
#    fail and fall back to SSE (or, in Firefox, hang the page). Clearing the
#    lock on every start makes zero-cache self-heal instead of needing a manual
#    kill. We kill ONLY holders of THIS replica file and its -wal/-wal2/-shm
#    siblings, so an unrelated zero-cache on another replica is never touched.
#
# 2. V8 HEAP. The initial replication snapshot is loaded into the JS heap, and
#    the SideStage published set is BIG — measured 2026-08-17 against the live
#    dev database (20 tables in publication `zero_publication`, 3476 MB total):
#      product_catalog     2637 MB
#      storefront_product   836 MB
#      (all 18 others together < 2 MB)
#    Node's default heap (~2 GB) cannot hold that snapshot, and the failure mode
#    is not a clean error: the node OOMs mid-sync, restarts, and never
#    converges. The Restart project hit 92920 restarts in 30 days on a snapshot
#    of comparable size (~3.8 GB) before raising the heap to 12288 MB, so that
#    is the default here too. Override with ZERO_HEAP_MB on a memory-tight box,
#    but understand that setting it too LOW reproduces the crashloop — this is
#    one of the few knobs where the conservative-looking value is the dangerous
#    one.
#
# Note on grants: Restart needs a companion grant script because it splits
# postgres_app (superuser) from restart_app (the app role), so the app role
# cannot touch the zero_0 metadata schema that zero-cache provisions. SideStage
# has a SINGLE role (POSTGRES_USER, verified SUPERUSER + REPLICATION on the live
# database), and the API connects as that same role — it owns zero_0 outright,
# so no grant step is needed or wanted here.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# The dev database is infra/docker-compose.data.yml (compose project
# `sidestage-data`, published on 127.0.0.1:55434) — NOT the root
# docker-compose.yml postgres, which is a separate, normally-idle stack.
DEFAULT_DEV_DB="postgresql://sidestage:sidestage_dev@127.0.0.1:55434/sidestage"

export ZERO_UPSTREAM_DB="${ZERO_UPSTREAM_DB:-${DATABASE_URL:-$DEFAULT_DEV_DB}}"
export ZERO_CHANGE_DB="${ZERO_CHANGE_DB:-$ZERO_UPSTREAM_DB}"
export ZERO_REPLICA_FILE="${ZERO_REPLICA_FILE:-$ROOT_DIR/.zero/replica.db}"
# Must match the publication created by db/zero-publication.sql.
export ZERO_APP_PUBLICATIONS="${ZERO_APP_PUBLICATIONS:-zero_publication}"

# --- synced-query / custom-mutator delegation ---------------------------------
# zero-cache does NOT evaluate queries or mutations itself: it forwards each one
# to the API over these two URLs (verified in @rocicorp/zero 1.8.0 —
# out/zero/src/zero-cache-dev.js reads ZERO_QUERY_URL and ZERO_MUTATE_URL by
# those exact names). Leave them unset and every client read fails at the
# view-syncer with no route to ask, which looks like a client/schema bug rather
# than missing config — so they are defaulted here, not left to the caller.
#
# ⚠ THE PATH IS NOT THE SAME AS PRODUCTION, and the difference is not a typo.
# apps/api/src/main.ts:19 applies a global prefix ONLY when API_PREFIX is set.
# docker-compose.prod.yml and infra/docker-compose.acceptance.yml both set
# API_PREFIX=api, which is why those files point zero-cache at
# `/api/zero/query`. Local dev sets no prefix, so the same handler is served at
# a BARE `/zero/query`. Copying the prod URL into a dev shell yields a 404 that
# surfaces as an opaque view-syncer failure. Derived from API_PREFIX below so
# the two can never drift apart.
API_ZERO_PREFIX="$(printf '%s' "${API_PREFIX:-}" | sed -E 's#^/+|/+$##g')"
[[ -n "$API_ZERO_PREFIX" ]] && API_ZERO_PREFIX="/$API_ZERO_PREFIX"
DEFAULT_API_ORIGIN="http://127.0.0.1:${API_PORT:-3100}"
export ZERO_QUERY_URL="${ZERO_QUERY_URL:-${DEFAULT_API_ORIGIN}${API_ZERO_PREFIX}/zero/query}"
export ZERO_MUTATE_URL="${ZERO_MUTATE_URL:-${DEFAULT_API_ORIGIN}${API_ZERO_PREFIX}/zero/mutate}"

mkdir -p "$(dirname "$ZERO_REPLICA_FILE")"

# --- 0. preflight: upstream must actually have logical WAL --------------------
# zero-cache dies mid-init with `Postgres must be configured with "wal_level =
# logical"`, which sounds like a config-file problem. On 2026-08-17 it was NOT:
# infra/docker-compose.data.yml already DECLARED `-c wal_level=logical`, and had
# for days. The running container simply predated that declaration —
# `docker inspect` showed its Cmd was a bare ["postgres"] — because a compose
# `command:` change does nothing to an ALREADY-CREATED container until it is
# recreated. So the upstream error sends you to fix a file that is already
# correct, which is the worst kind of error message.
#
# Two things kept it hidden for four days, and both defeat the obvious check:
#   * `show max_replication_slots` / `show max_wal_senders` both answer 10 —
#     which looks like the -c flags took effect, but 10 is ALSO the postgres 16
#     default for both. wal_level is the only one of the three whose configured
#     value differs from its default, so it is the only one that can reveal this.
#   * CREATE PUBLICATION SUCCEEDS under wal_level=replica (postgres only warns),
#     so `zero_publication` existed and listed all 19 tables while nothing could
#     ever stream. Every static check passed.
#
# Hence: check the LIVE server, not the compose file, and name the recreate as
# the remedy. Advisory-but-loud — a non-default upstream, or no psql on PATH,
# skips the check rather than blocking a legitimate setup.
if command -v psql >/dev/null 2>&1; then
  wal_level="$(psql "$ZERO_UPSTREAM_DB" -tAc 'show wal_level' 2>/dev/null || true)"
  if [[ -z "$wal_level" ]]; then
    echo "[zero-cache-start] NOTE: could not read wal_level from upstream (not reachable yet?); skipping preflight" >&2
  elif [[ "$wal_level" != "logical" ]]; then
    cat >&2 <<EOF
[zero-cache-start] FATAL: upstream has wal_level=$wal_level, but zero-cache
  requires 'logical'. Logical replication is OFF, so nothing can stream — note
  that the publication may still exist and look complete; postgres only WARNS
  when you create one under wal_level=replica.

  If this is the default dev stack, the compose file is very likely ALREADY
  correct and the CONTAINER is the stale part — a compose 'command:' change is
  not applied to an existing container. Recreate it (the named volume persists,
  so no data is lost):

    docker compose -f infra/docker-compose.data.yml up -d postgres

  Then confirm with:  docker inspect sidestage-data-postgres-1 --format '{{.Config.Cmd}}'
  (a bare [postgres] means the flags are still not applied).
EOF
    exit 1
  fi
  echo "[zero-cache-start] preflight ok: wal_level=$wal_level"

  # --- 0b. preflight: the LIVE publication must match the DECLARED one --------
  # db/zero-publication.sql wraps CREATE PUBLICATION in
  # `IF NOT EXISTS (SELECT 1 FROM pg_publication ...)`, so once the publication
  # exists the whole file is a permanent no-op. A table APPENDED to that file
  # afterwards is therefore never added to an already-provisioned database —
  # the declared object and the live object silently diverge.
  #
  # This is not hypothetical: `targeted_offer` was added to the file on
  # 2026-08-17 and never reached the dev publication. Every STATIC check passed
  # (the file lists it, and zero-publication.parity.test.ts — which reads the
  # FILE, by design, and says so in its own header — stayed green), while the
  # first real WS client died with a ProtocolError naming the missing table.
  #
  # Why compare against the FILE rather than the Zero contract: the parity test
  # already guarantees contract == file. Checking file == live here CHAINS onto
  # that to give contract == live, without re-deriving the contract in bash or
  # needing a TS runtime at launch time.
  # The `|| true` on both is load-bearing under `set -Eeuo pipefail` (line 38):
  # `grep` exits 1 when it matches nothing and psql exits non-zero when the
  # upstream is unreachable, and with pipefail a failing command substitution in
  # an assignment ABORTS THE SCRIPT. Without it, the two "skipping the
  # publication preflight" branches below are unreachable and an unparsable file
  # or a not-yet-up database kills the launcher instead of degrading. (Same
  # reason the wal_level probe above ends in `|| true`.)
  declared_tables="$(
    sed -n '/CREATE PUBLICATION zero_publication FOR TABLE/,/^      );/p' \
      "$ROOT_DIR/db/zero-publication.sql" 2>/dev/null |
      grep -oE 'public\.[a-z_]+' | sed 's/^public\.//' | sort -u || true
  )"
  live_tables="$(
    psql "$ZERO_UPSTREAM_DB" -tAc \
      "select tablename from pg_publication_tables where pubname='$ZERO_APP_PUBLICATIONS'" \
      2>/dev/null | sed '/^$/d' | sort -u || true
  )"
  if [[ -z "$declared_tables" ]]; then
    echo "[zero-cache-start] NOTE: could not parse the declared table list from db/zero-publication.sql; skipping the publication preflight" >&2
  elif [[ -z "$live_tables" ]]; then
    echo "[zero-cache-start] NOTE: publication '$ZERO_APP_PUBLICATIONS' has no tables yet (fresh database?); skipping the publication preflight" >&2
  else
    # Declared-but-not-live is the failure that silently breaks clients.
    missing="$(comm -23 <(echo "$declared_tables") <(echo "$live_tables") | tr '\n' ' ')"
    # Live-but-not-declared is the reverse drift: it still replicates, so it is
    # a warning, not a stop.
    extra="$(comm -13 <(echo "$declared_tables") <(echo "$live_tables") | tr '\n' ' ')"
    if [[ -n "${missing// /}" ]]; then
      cat >&2 <<EOF
[zero-cache-start] FATAL: publication '$ZERO_APP_PUBLICATIONS' is MISSING table(s)
  that db/zero-publication.sql declares:

    ${missing}

  Re-running db/zero-publication.sql will NOT fix this — its CREATE is guarded
  by IF NOT EXISTS, so it is a no-op against an existing publication. Widening
  replication on a live database takes an explicit ALTER:

$(for t in ${missing}; do
  echo "    ALTER PUBLICATION $ZERO_APP_PUBLICATIONS ADD TABLE public.${t};"
done)

  Left unfixed, a client querying one of those tables fails at CONNECT time with
  a ProtocolError ("... does not exist or is not one of the replicated tables").
EOF
      exit 1
    fi
    if [[ -n "${extra// /}" ]]; then
      echo "[zero-cache-start] WARN: publication has table(s) the file does not declare: ${extra}" >&2
    fi
    echo "[zero-cache-start] preflight ok: publication matches db/zero-publication.sql ($(echo "$declared_tables" | wc -l) tables)"
  fi
else
  echo "[zero-cache-start] NOTE: psql not on PATH; skipping the wal_level + publication preflights" >&2
fi

# --- 1. clear stale lock holders on this replica ------------------------------
if command -v fuser >/dev/null 2>&1; then
  for f in "$ZERO_REPLICA_FILE" "$ZERO_REPLICA_FILE-wal" \
           "$ZERO_REPLICA_FILE-wal2" "$ZERO_REPLICA_FILE-shm"; do
    if [[ -e "$f" ]] && fuser -s "$f" 2>/dev/null; then
      echo "[zero-cache-start] clearing stale lock holder(s) on $f"
      fuser -k "$f" 2>/dev/null || true
    fi
  done
  sleep 0.5
else
  # Not fatal: a clean box has no orphan to clear. Say so loudly, because if
  # zero-cache then dies with SQLITE_BUSY this is the missing piece.
  echo "[zero-cache-start] WARNING: fuser not found (install psmisc);" \
       "cannot clear stale replica locks automatically" >&2
fi

# --- 2. heap ------------------------------------------------------------------
ZERO_HEAP_MB="${ZERO_HEAP_MB:-12288}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${ZERO_HEAP_MB}"

# Redact the userinfo before logging: the connection string carries a password,
# and this line otherwise prints it verbatim into dev consoles and any CI/deploy
# log that runs the script.
redacted_upstream="$(printf '%s' "${ZERO_UPSTREAM_DB%%\?*}" | sed -E 's#://[^/@]*@#://***:***@#')"
echo "[zero-cache-start] upstream=$redacted_upstream"
echo "[zero-cache-start] replica=$ZERO_REPLICA_FILE publication=$ZERO_APP_PUBLICATIONS heap=${ZERO_HEAP_MB}MB"
# Printed because the #1 dev failure here is zero-cache pointing at a path the
# API does not serve (see the API_PREFIX note above); the URL in the log is the
# fastest way to tell that apart from a genuine query bug.
echo "[zero-cache-start] query=$ZERO_QUERY_URL mutate=$ZERO_MUTATE_URL"

# --- 3. run -------------------------------------------------------------------
# zero-cache-dev runs the replication-manager and view-syncer in ONE process,
# which is the right shape for local dev; production runs the `zero-cache`
# binary from infra/zero/Dockerfile instead.
cd "$ROOT_DIR"
exec npx zero-cache-dev "$@"

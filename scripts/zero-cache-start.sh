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
#    dev database (19 tables in publication `zero_publication`, 3476 MB total):
#      product_catalog     2637 MB
#      storefront_product   836 MB
#      (all 17 others together < 2 MB)
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

mkdir -p "$(dirname "$ZERO_REPLICA_FILE")"

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

# --- 3. run -------------------------------------------------------------------
# zero-cache-dev runs the replication-manager and view-syncer in ONE process,
# which is the right shape for local dev; production runs the `zero-cache`
# binary from infra/zero/Dockerfile instead.
cd "$ROOT_DIR"
exec npx zero-cache-dev "$@"

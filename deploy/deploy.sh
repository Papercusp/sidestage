#!/usr/bin/env bash
# deploy.sh — Ship SideStage to production (sidestage.buyrestart.com).
#
# Mimics the Restart deploy pattern (see /home/marsh-office/Restart/deploy):
# export one immutable snapshot of the working tree (tracked edits plus
# non-ignored new files) and rsync it to /opt/SideStage on the shared Hetzner
# box, then docker compose build + up there. A COMPLETELY INDEPENDENT stack:
# own compose project, containers, volumes, hostname. It never touches
# /opt/Restart or the restart-* containers.
#
# Usage:
#   ./deploy/deploy.sh              # build + up all services
#   ./deploy/deploy.sh --dry-run    # show what would ship, change nothing
#
# Requirements on the dev box: ssh key ($SSH_KEY, default the papercusp frame
# key) authorized as root on the prod host. Requirements on prod (one-time):
# /opt/SideStage/.env.production with the database/search, checkout-provider,
# warehouse-origin, and public-hostname values required by docker-compose.prod.yml.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$(git rev-parse --show-toplevel)"

PROD_HOST="${PROD_HOST:-178.156.254.59}"
PROD_SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercusp-latitude-frame}"
PROD_DIR="/opt/SideStage"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
DEPLOYED_SHA_FILE="$PROD_DIR/.deployed-sha"
HISTORY_FILE="$PROD_DIR/.deploy-history"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

SSH=(ssh -i "$PROD_SSH_KEY" -o ConnectTimeout=10 "root@$PROD_HOST")

say() { echo "==> $*"; }

SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sidestage-deploy.XXXXXX")"
trap 'rm -rf -- "$SNAPSHOT_DIR"' EXIT INT TERM
bash "$SCRIPT_DIR/snapshot-source.sh" "$PWD" "$SNAPSHOT_DIR"
SNAPSHOT_FILE_COUNT="$(find "$SNAPSHOT_DIR" \( -type f -o -type l \) -print | wc -l | tr -d ' ')"

say "Shipping $(git rev-parse --short HEAD) to $PROD_HOST:$PROD_DIR"
if $DRY_RUN; then
  say "[dry-run] would rsync $SNAPSHOT_FILE_COUNT snapshot files, then: $COMPOSE build && up -d"
  exit 0
fi

"${SSH[@]}" "mkdir -p $PROD_DIR"

# Prod-side state: files that live in $PROD_DIR but are NOT part of the source
# snapshot, so `rsync --delete` deletes every one of them unless excluded.
#   .env.production  secrets, created once by hand on prod
#   .deployed-sha    what is actually live -- rollback.sh targets it, and
#                    PREV_SHA (below) reads it to get an auto-rollback target
#   .deploy-history  the rollback menu
# Before 2026-08-14 only .env.production was excluded, so EVERY deploy wiped
# .deployed-sha and .deploy-history moments before PREV_SHA read them. Two
# silent consequences: PREV_SHA was always empty, making the auto-rollback on
# an unhealthy deploy inert (nothing to restore TO); and .deploy-history never
# held more than the single entry the running deploy had just appended, so
# `rollback.sh` with no --to could never find a previous sha. Both failures are
# invisible until the incident when you need them. Guarded by rollback.test.mjs.
PROD_STATE_FILES=(.env.production .deployed-sha .deploy-history)
RSYNC_EXCLUDES=()
for state_file in "${PROD_STATE_FILES[@]}"; do
  RSYNC_EXCLUDES+=(--exclude="/$state_file")
done

say "rsync immutable working-tree snapshot ($SNAPSHOT_FILE_COUNT files)"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" \
  -e "ssh -i $PROD_SSH_KEY" "$SNAPSHOT_DIR/" "root@$PROD_HOST:$PROD_DIR/"

say "Checking .env.production exists on prod"
"${SSH[@]}" "test -f $PROD_DIR/.env.production" || {
  echo "ERROR: $PROD_DIR/.env.production is missing on prod. Create it with:" >&2
  echo "  POSTGRES_PASSWORD=… TYPESENSE_API_KEY=… EASYPOST_API_KEY=…" >&2
  echo "  WAREHOUSE_FROM_STREET1=… WAREHOUSE_FROM_CITY=… WAREHOUSE_FROM_STATE=… WAREHOUSE_FROM_ZIP=…" >&2
  echo "  SQUARE_APP_ID=… SQUARE_LOCATION_ID=… SQUARE_ACCESS_TOKEN=…" >&2
  echo "  PUBLIC_HOSTNAME=sidestage.buyrestart.com" >&2
  exit 2
}

# Compose owns the required-variable contract. Validate it before the expensive
# build so checkout can never silently deploy with empty rates or payments.
say "Validating required production configuration"
"${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=config-check $COMPOSE config --quiet"

SHA="$(git rev-parse HEAD)"
# Capture what is live BEFORE we overwrite anything, so a failed health check
# has somewhere to roll back TO.
PREV_SHA="$("${SSH[@]}" "cat $DEPLOYED_SHA_FILE 2>/dev/null" || true)"
PREV_SHA="${PREV_SHA//[$'\r\n']/}"

say "Build + up on prod (SIDESTAGE_SHA=${SHA:0:7}, previous=${PREV_SHA:0:7})"
"${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$SHA $COMPOSE build --pull api web && SIDESTAGE_SHA=$SHA $COMPOSE up -d --remove-orphans"

# The sha is recorded ONLY after the health check passes -- see below. Writing
# it before the check (the pre-2026-08-14 order) left prod asserting a sha it
# had never verified whenever a deploy came up unhealthy.

say "Health check"
healthy=false
for attempt in $(seq 1 20); do
  if "${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" >/dev/null 2>&1 \
     || "${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$SHA $COMPOSE exec -T api node -e 'fetch(\"http://127.0.0.1:3100/healthz\").then(r=>{if(!r.ok)throw 0})'" >/dev/null 2>&1; then
    say "API healthy (attempt $attempt)"
    healthy=true
    break
  fi
  sleep 3
done

if ! $healthy; then
  echo "ERROR: API health check failed after 20 attempts" >&2
  if [[ -n "$PREV_SHA" ]]; then
    echo "==> AUTO-ROLLBACK to ${PREV_SHA:0:7}" >&2
    if bash "$SCRIPT_DIR/rollback.sh" --to "$PREV_SHA"; then
      echo "ERROR: deploy of ${SHA:0:7} failed health check; prod rolled back to ${PREV_SHA:0:7}" >&2
      exit 3
    fi
    echo "FATAL: rollback to ${PREV_SHA:0:7} ALSO failed -- prod needs hands" >&2
    exit 4
  fi
  echo "FATAL: no previous sha recorded, cannot auto-rollback -- prod needs hands" >&2
  exit 4
fi

say "Recording deployed sha (health check passed)"
"${SSH[@]}" "
  set -e
  cd $PROD_DIR
  docker tag sidestage-api:$SHA sidestage-api:latest
  docker tag sidestage-web:$SHA sidestage-web:latest
  printf '%s\t%s\tdeploy\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" $SHA >> $HISTORY_FILE
  printf '%s' $SHA > $DEPLOYED_SHA_FILE
"

say "Verifying /healthz reports the sha we just shipped"
served="$("${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" 2>/dev/null || true)"
case "$served" in
  *"$SHA"*) say "OK: /healthz reports ${SHA:0:7}" ;;
  *) echo "WARN: /healthz did not report $SHA (got: ${served:-<no response>}). Expected on the first deploy after the sha-reporting change." >&2 ;;
esac

say "Done. Public: https://\$PUBLIC_HOSTNAME (Traefik routes once DNS resolves)."

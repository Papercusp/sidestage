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
#   ./deploy/deploy.sh              # build + up all services (SHIPS TO PROD)
#   ./deploy/deploy.sh --dry-run    # show what would ship, change nothing
#   ./deploy/deploy.sh --help       # print this header, touch nothing
#
# Any unrecognised argument is REFUSED (exit 2) rather than ignored: the
# default action of this script is an irreversible production deploy.
#
# Requirements on the dev box: ssh key ($SSH_KEY, default the papercusp frame
# key) authorized as root on the prod host. Requirements on prod (one-time):
# /opt/SideStage/.env.production with the database/search, checkout-provider,
# warehouse-origin, and public-hostname values required by docker-compose.prod.yml.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/deploy-lock.sh"
cd "$(git rev-parse --show-toplevel)"

PROD_HOST="${PROD_HOST:-178.156.254.59}"
PROD_SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercusp-latitude-frame}"
PROD_DIR="/opt/SideStage"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
DEPLOYED_SHA_FILE="$PROD_DIR/.deployed-sha"
HISTORY_FILE="$PROD_DIR/.deploy-history"
# The api container EXPOSES 3100 but deliberately does NOT publish it to the
# host: Traefik reaches it over the `coolify` docker network (see the traefik.*
# labels on the api service in docker-compose.prod.yml, which route
# Host(...) && (PathPrefix(/api) || Path(/healthz)) to container port 3100).
# So the PUBLIC url -- never a host-loopback port -- is the real health
# contract, and /healthz is routed for exactly that purpose. Probing
# http://127.0.0.1:3100 from the prod host fails exit 7 on a PERFECTLY HEALTHY
# prod; every probe here did that until 2026-08-14, silently falling through to
# the container leg. Prod's .env.production does not define PUBLIC_HOSTNAME, so
# default it to the same value docker-compose.prod.yml defaults to.
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-sidestage.buyrestart.com}"
HEALTH_URL="https://$PUBLIC_HOSTNAME/healthz"
# ARGUMENT PARSING -- deliberately mirrors deploy/rollback.sh's case loop.
# Until 2026-08-14 this was a single exact-match test on $1:
#     [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
# which recognised --dry-run ONLY in position 1 and SILENTLY IGNORED every
# other argument, falling through into a REAL PRODUCTION DEPLOY. All of
# `deploy.sh --help`, `deploy.sh --dry-runn` (typo), `deploy.sh -n`, and
# `deploy.sh --verbose --dry-run` (safe flag present, but not $1) therefore
# shipped to prod. That is not hypothetical: `deploy.sh --help` was run on
# 2026-08-14T17:20Z believing it printed usage, and rsync'd 748 files to
# /opt/SideStage + applied prod schema before it was killed -- which in turn
# aborted a concurrent deploy with `tuple concurrently updated` (WI-38904).
# An unrecognised argument now REFUSES rather than deploying: for a script
# whose default action is irreversible, silence on an unknown flag is the
# most dangerous branch available. (WI-38905)
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    # Print the whole comment header, up to (not including) `set -euo pipefail`,
    # so --help cannot silently drop the Requirements section when the header
    # grows. Derived, never a hardcoded line range: a literal '2,18p' already
    # truncated this once when the usage block gained three lines.
    -h|--help)
      header_end=$(( $(grep -n '^set -euo pipefail' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1) - 1 ))
      sed -n "2,${header_end}p" "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "deploy.sh: unknown argument: $1" >&2
      echo "deploy.sh: refusing to deploy on an unrecognised argument -- this script's" >&2
      echo "           default action ships to production. Run with --help for usage." >&2
      exit 2
      ;;
  esac
done

SSH=(ssh -i "$PROD_SSH_KEY" -o ConnectTimeout=10 "root@$PROD_HOST")

say() { echo "==> $*"; }

# health_probe <sha> -- set HEALTH_BODY to the /healthz body from the first leg
# that answers, and HEALTH_LEG to that leg ("public" | "container" | "none").
#
# Call this function DIRECTLY, never through command substitution. Bash runs a
# command substitution in a subshell, which discards the HEALTH_LEG assignment
# and makes a container-only fallback print as the impossible "none" leg.
#
# ORDER MATTERS. The PUBLIC url is the real contract: it exercises DNS + TLS +
# Traefik + the app, and its body carries the sha the running image was built
# from, so ONE probe satisfies both the health gate and the sha verification.
# It runs from the DEPLOY HOST (no ssh) precisely so it tests the path a real
# user takes. The container-exec leg is a LAST RESORT: it proves only that the
# process is alive inside its own namespace and cannot see a broken ingress,
# which is most of what a deploy can break -- so falling back to it is REPORTED,
# never silent.
HEALTH_LEG=none
HEALTH_BODY=""
health_probe() {
  local target_sha="$1" body
  HEALTH_LEG=none
  HEALTH_BODY=""
  if body="$(curl -sf --max-time 6 "$HEALTH_URL" 2>/dev/null)"; then
    HEALTH_LEG=public
    HEALTH_BODY="$body"
    return 0
  fi
  if body="$("${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$target_sha $COMPOSE exec -T api node -e 'fetch(\"http://127.0.0.1:3100/healthz\").then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))'" 2>/dev/null)"; then
    HEALTH_LEG=container
    HEALTH_BODY="$body"
    return 0
  fi
  return 1
}

SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sidestage-deploy.XXXXXX")"
cleanup() {
  sidestage_release_release_lock
  rm -rf -- "$SNAPSHOT_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash "$SCRIPT_DIR/snapshot-source.sh" "$PWD" "$SNAPSHOT_DIR"
SNAPSHOT_FILE_COUNT="$(find "$SNAPSHOT_DIR" \( -type f -o -type l \) -print | wc -l | tr -d ' ')"

say "Shipping $(git rev-parse --short HEAD) to $PROD_HOST:$PROD_DIR"
if $DRY_RUN; then
  say "[dry-run] would rsync $SNAPSHOT_FILE_COUNT snapshot files, then: $COMPOSE build && up -d"
  exit 0
fi

sidestage_acquire_release_lock

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

# Existing Postgres volumes do not replay /docker-entrypoint-initdb.d when the
# schema file changes. Apply the repository's idempotent schema before building
# or replacing either application container, so a DDL failure leaves the known-
# good release running and the API cannot crash-loop on a missing new table.
say "Applying idempotent production schema"
"${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_COMPOSE_FILE=docker-compose.prod.yml SIDESTAGE_COMPOSE_ENV_FILE=.env.production bash scripts/db-apply.sh"

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
  if health_probe "$SHA"; then
    say "API healthy via $HEALTH_LEG leg (attempt $attempt)"
    if [[ "$HEALTH_LEG" != public ]]; then
      echo "WARN: $HEALTH_URL did not answer; health was confirmed only INSIDE the" >&2
      echo "      container. DNS/TLS/Traefik ingress is NOT verified by this run." >&2
    fi
    healthy=true
    break
  fi
  sleep 3
done

if ! $healthy; then
  echo "ERROR: API health check failed after 20 attempts" >&2
  if [[ -n "$PREV_SHA" ]]; then
    echo "==> AUTO-ROLLBACK to ${PREV_SHA:0:7}" >&2
    if SIDESTAGE_DEPLOY_LOCK_HELD=1 bash "$SCRIPT_DIR/rollback.sh" --to "$PREV_SHA"; then
      echo "ERROR: deploy of ${SHA:0:7} failed health check; prod rolled back to ${PREV_SHA:0:7}" >&2
      exit 3
    fi
    echo "FATAL: rollback to ${PREV_SHA:0:7} ALSO failed -- prod needs hands" >&2
    exit 4
  fi
  echo "FATAL: no previous sha recorded, cannot auto-rollback -- prod needs hands" >&2
  exit 4
fi

# VERIFY BEFORE RECORDING -- the same principle the health gate above follows:
# never write a sha into .deployed-sha that we have not proven prod is serving.
# Until 2026-08-14 this ran AFTER the record step and read a host-loopback port
# that is never published, so `served` was unconditionally empty and the check
# ALWAYS took a WARN branch whose text pre-excused its own failure ("Expected on
# the first deploy after the sha-reporting change"). It was vacuous on every run
# it ever made, while printing a benign-looking message.
say "Verifying /healthz reports the sha we just shipped"
served=""
sha_ok=false
for attempt in $(seq 1 5); do
  if health_probe "$SHA"; then
    served="$HEALTH_BODY"
    if [[ "$served" == *"$SHA"* ]]; then
      sha_ok=true
      break
    fi
  else
    served="$HEALTH_BODY"
  fi
  sleep 3
done

if ! $sha_ok; then
  echo "ERROR: prod does not report the sha just deployed." >&2
  echo "       expected: $SHA" >&2
  echo "       /healthz (leg: $HEALTH_LEG) returned: ${served:-<no response>}" >&2
  echo "       $DEPLOYED_SHA_FILE was left at ${PREV_SHA:0:7} -- it still names the" >&2
  echo "       last sha prod was PROVEN to serve. Investigate before rolling back:" >&2
  echo "         curl -s $HEALTH_URL" >&2
  exit 5
fi
say "OK: /healthz (leg: $HEALTH_LEG) reports ${SHA:0:7}"

say "Recording deployed sha (health check + sha verification passed)"
"${SSH[@]}" "
  set -e
  cd $PROD_DIR
  docker tag sidestage-api:$SHA sidestage-api:latest
  docker tag sidestage-web:$SHA sidestage-web:latest
  printf '%s\t%s\tdeploy\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" $SHA >> $HISTORY_FILE
  printf '%s' $SHA > $DEPLOYED_SHA_FILE
"

say "Done. Public: https://$PUBLIC_HOSTNAME (verified serving ${SHA:0:7} via $HEALTH_LEG leg)."

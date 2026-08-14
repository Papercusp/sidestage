#!/usr/bin/env bash
# rollback.sh — Return SideStage prod to a previously deployed sha.
#
# This is fast because deploy.sh tags every image it builds as
# sidestage-{api,web}:<sha> and appends the sha to $PROD_DIR/.deploy-history.
# Rolling back is therefore a retag + `up -d --no-build` -- no rebuild, no
# rsync, no dependency on the dev box still having the old tree checked out.
#
# Usage:
#   ./deploy/rollback.sh                  # roll back to the previous deploy
#   ./deploy/rollback.sh --to <sha>       # roll back to a specific sha
#   ./deploy/rollback.sh --list           # show what is rollback-able
#   ./deploy/rollback.sh --dry-run        # show the plan, change nothing
#
# Exits non-zero if the target images are absent on prod (i.e. that sha was
# never tagged, so it is NOT actually recoverable) -- deliberately, so a
# rollback that cannot work fails loudly instead of half-running.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

PROD_HOST="${PROD_HOST:-178.156.254.59}"
PROD_SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercusp-latitude-frame}"
PROD_DIR="/opt/SideStage"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
DEPLOYED_SHA_FILE="$PROD_DIR/.deployed-sha"
HISTORY_FILE="$PROD_DIR/.deploy-history"

TARGET=""
DRY_RUN=false
LIST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TARGET="${2:?--to needs a sha}"; shift 2 ;;
    --list) LIST=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "rollback.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

SSH=(ssh -i "$PROD_SSH_KEY" -o ConnectTimeout=10 "root@$PROD_HOST")
say() { echo "==> $*"; }

CURRENT="$("${SSH[@]}" "cat $DEPLOYED_SHA_FILE 2>/dev/null" || true)"
CURRENT="${CURRENT//[$'\r\n']/}"

if $LIST; then
  say "Currently deployed: ${CURRENT:0:7}"
  say "Deploy history (newest last):"
  "${SSH[@]}" "cat $HISTORY_FILE 2>/dev/null" || echo "  (no history yet)"
  say "Rollback-able (images actually present on prod):"
  "${SSH[@]}" "docker images --format '{{.Repository}}:{{.Tag}}' | grep '^sidestage-api:' | grep -v ':latest$' | sed 's/^sidestage-api:/  /'" || echo "  (none)"
  exit 0
fi

# Default target: the newest history entry that is NOT what is running now.
if [[ -z "$TARGET" ]]; then
  TARGET="$("${SSH[@]}" "awk -v cur='$CURRENT' -F'\t' '\$2 != cur { last = \$2 } END { print last }' $HISTORY_FILE 2>/dev/null" || true)"
  TARGET="${TARGET//[$'\r\n']/}"
  [[ -n "$TARGET" ]] || { echo "ERROR: no previous sha in $HISTORY_FILE to roll back to. Use --to <sha>, or --list." >&2; exit 2; }
fi

if [[ "$TARGET" == "$CURRENT" ]]; then
  echo "ERROR: $TARGET is already the deployed sha -- nothing to roll back." >&2
  exit 2
fi

say "Rolling back: ${CURRENT:0:7} -> ${TARGET:0:7}"

# Refuse before touching anything if the target is not actually recoverable.
say "Checking target images exist on prod"
if ! "${SSH[@]}" "docker image inspect sidestage-api:$TARGET >/dev/null 2>&1 && docker image inspect sidestage-web:$TARGET >/dev/null 2>&1"; then
  echo "ERROR: sidestage-api:$TARGET and/or sidestage-web:$TARGET are not present on prod." >&2
  echo "       That sha is NOT rollback-able. See: ./deploy/rollback.sh --list" >&2
  exit 2
fi

if $DRY_RUN; then
  say "[dry-run] would: SIDESTAGE_SHA=$TARGET $COMPOSE up -d --no-build api web"
  say "[dry-run] would: retag :latest -> $TARGET, record $TARGET in .deployed-sha, append rollback to history"
  exit 0
fi

START=$(date +%s)

say "Switching containers to ${TARGET:0:7} (no rebuild)"
"${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$TARGET $COMPOSE up -d --no-build api web"

say "Health check"
healthy=false
for attempt in $(seq 1 20); do
  if "${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" >/dev/null 2>&1; then
    say "API healthy (attempt $attempt)"
    healthy=true
    break
  fi
  sleep 3
done

if ! $healthy; then
  echo "FATAL: rollback to ${TARGET:0:7} came up unhealthy -- prod needs hands." >&2
  echo "       .deployed-sha was left at ${CURRENT:0:7} (not updated), so it still" >&2
  echo "       reflects the last sha that PASSED a health check." >&2
  exit 3
fi

say "Recording rollback (health check passed)"
"${SSH[@]}" "
  set -e
  docker tag sidestage-api:$TARGET sidestage-api:latest
  docker tag sidestage-web:$TARGET sidestage-web:latest
  printf '%s\t%s\trollback (from %s)\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" $TARGET $CURRENT >> $HISTORY_FILE
  printf '%s' $TARGET > $DEPLOYED_SHA_FILE
"

ELAPSED=$(( $(date +%s) - START ))

served="$("${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" 2>/dev/null || true)"
case "$served" in
  *"$TARGET"*) say "Verified: /healthz reports ${TARGET:0:7}" ;;
  *) echo "WARN: /healthz did not report $TARGET (got: ${served:-<no response>}). Expected for images built before /healthz reported a sha." >&2 ;;
esac

say "Rollback complete: ${CURRENT:0:7} -> ${TARGET:0:7} in ${ELAPSED}s"

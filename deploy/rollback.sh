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

# What prod RECORDS as live. This is an assertion written by the last deploy --
# it can be stale (a deploy that died between `up -d` and the record, or an
# operator switching containers by hand), so it is not on its own trusted.
RECORDED="$("${SSH[@]}" "cat $DEPLOYED_SHA_FILE 2>/dev/null" || true)"
RECORDED="${RECORDED//[$'\r\n']/}"

# What prod is ACTUALLY RUNNING, straight from the process. Since 2026-08-14
# /healthz reports the sha baked into the image, so reality is observable
# rather than inferred -- which is the whole point of baking it in. Empty when
# the image predates that change (it reports "unknown") or the API is down.
observed_sha() {
  "${SSH[@]}" "cd $PROD_DIR && $COMPOSE exec -T api node -e '
    fetch(\"http://127.0.0.1:3100/healthz\")
      .then(r => r.json())
      .then(j => console.log(/^[0-9a-f]{40}$/.test(j.sha || \"\") ? j.sha : \"\"))
      .catch(() => console.log(\"\"))
  '" 2>/dev/null | tr -d '\r\n' || true
}
RUNNING="$(observed_sha)"

# Prefer observed reality over the recorded claim.
CURRENT="${RUNNING:-$RECORDED}"

if [[ -n "$RUNNING" && -n "$RECORDED" && "$RUNNING" != "$RECORDED" ]]; then
  echo "WARN: prod is RUNNING ${RUNNING:0:7} but $DEPLOYED_SHA_FILE records ${RECORDED:0:7}." >&2
  echo "      The record is STALE -- trusting what the process reports." >&2
fi

if $LIST; then
  say "Currently deployed: ${CURRENT:0:7}"
  say "Deploy history (newest last):"
  "${SSH[@]}" "cat $HISTORY_FILE 2>/dev/null" || echo "  (no history yet)"
  say "Rollback-able (images actually present on prod):"
  "${SSH[@]}" "docker images --format '{{.Repository}}:{{.Tag}}' | grep '^sidestage-api:' | grep -v ':latest$' | sed 's/^sidestage-api:/  /'" || echo "  (none)"
  exit 0
fi

# Resolve a SHORT sha against the tags actually present on prod. Everything an
# operator reads during an incident -- git log, --list output, a chat message --
# prints 7 chars, but the image tags are full 40-char shas. Before 2026-08-14 a
# short sha fell straight through to the image-presence check below and was
# rejected as "that sha is NOT rollback-able": false, and alarming at precisely
# the moment you least want to doubt your rollback. Ambiguity is reported with
# the candidates rather than guessed at.
if [[ -n "$TARGET" && ! "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then
  mapfile -t PROD_TAGS < <(
    "${SSH[@]}" "docker images --format '{{.Tag}}' sidestage-api" 2>/dev/null | tr -d '\r' | grep -v '^latest$' | sort -u
  )
  MATCHES=()
  for tag in "${PROD_TAGS[@]}"; do
    [[ -n "$tag" && "$tag" == "$TARGET"* ]] && MATCHES+=("$tag")
  done
  case "${#MATCHES[@]}" in
    1) say "Resolved sha prefix '$TARGET' -> ${MATCHES[0]:0:7}"; TARGET="${MATCHES[0]}" ;;
    0) echo "ERROR: no image on prod has a sha starting with '$TARGET'." >&2
       echo "       See what IS rollback-able: ./deploy/rollback.sh --list" >&2
       exit 2 ;;
    *) echo "ERROR: sha prefix '$TARGET' is ambiguous on prod -- it matches:" >&2
       printf '         %s\n' "${MATCHES[@]}" >&2
       echo "       Re-run with more characters." >&2
       exit 2 ;;
  esac
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
# TWO-TIER, mirroring deploy.sh. The api container EXPOSES 3100 but does not
# PUBLISH it to the host (it is reached through Traefik), so the host-port curl
# alone fails with exit 7 on a perfectly healthy prod -- it could never pass.
# Until 2026-08-14 that was this script's only probe, so EVERY rollback ended
# in "FATAL: came up unhealthy -- prod needs hands" and skipped the record step,
# leaving .deployed-sha pointing at a release that was no longer running. A
# rollback tool that always reports failure is worse than none: it trains the
# operator to ignore it during the one event it exists for.
healthy=false
for attempt in $(seq 1 20); do
  if "${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" >/dev/null 2>&1 \
    || "${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$TARGET $COMPOSE exec -T api node -e 'fetch(\"http://127.0.0.1:3100/healthz\").then(r=>{if(!r.ok)throw 0})'" >/dev/null 2>&1; then
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

# Independent confirmation: ask the RUNNING PROCESS what it was built from,
# rather than trusting the record we just wrote. Three outcomes, deliberately
# kept distinct -- the pre-2026-08-14 version collapsed the last two into one
# reassuring "expected for older images" line, so a genuine mismatch (we rolled
# to X and prod is serving Y) was reported in the same words as the benign
# can't-tell case.
served="$(observed_sha)"
if [[ "$served" == "$TARGET" ]]; then
  say "Verified: /healthz reports ${TARGET:0:7}"
elif [[ -z "$served" ]]; then
  say "Note: this image reports no sha (built before /healthz carried one),"
  say "      so the rollback could not be independently confirmed."
else
  echo "WARN: rolled to ${TARGET:0:7} but /healthz reports ${served:0:7} -- prod is" >&2
  echo "      not serving what we just recorded. Investigate before trusting" >&2
  echo "      $DEPLOYED_SHA_FILE." >&2
fi

say "Rollback complete: ${CURRENT:0:7} -> ${TARGET:0:7} in ${ELAPSED}s"

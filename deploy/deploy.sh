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
# /opt/SideStage/.env.production with POSTGRES_PASSWORD, TYPESENSE_API_KEY,
# PUBLIC_HOSTNAME.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$(git rev-parse --show-toplevel)"

PROD_HOST="${PROD_HOST:-178.156.254.59}"
PROD_SSH_KEY="${SSH_KEY:-$HOME/.ssh/papercusp-latitude-frame}"
PROD_DIR="/opt/SideStage"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
DEPLOYED_SHA_FILE="$PROD_DIR/.deployed-sha"
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

say "rsync immutable working-tree snapshot ($SNAPSHOT_FILE_COUNT files)"
rsync -az --delete --exclude='/.env.production' \
  -e "ssh -i $PROD_SSH_KEY" "$SNAPSHOT_DIR/" "root@$PROD_HOST:$PROD_DIR/"

say "Checking .env.production exists on prod"
"${SSH[@]}" "test -f $PROD_DIR/.env.production" || {
  echo "ERROR: $PROD_DIR/.env.production is missing on prod. Create it with:" >&2
  echo "  POSTGRES_PASSWORD=… TYPESENSE_API_KEY=… PUBLIC_HOSTNAME=sidestage.buyrestart.com" >&2
  exit 2
}

say "Build + up on prod"
"${SSH[@]}" "cd $PROD_DIR && $COMPOSE build --pull api web && $COMPOSE up -d --remove-orphans"

say "Recording deployed sha"
git rev-parse HEAD | "${SSH[@]}" "cat > $DEPLOYED_SHA_FILE"

say "Health check"
for attempt in $(seq 1 20); do
  if "${SSH[@]}" "curl -sf --max-time 4 http://127.0.0.1:3100/healthz -H 'Host: sidestage'" >/dev/null 2>&1 \
     || "${SSH[@]}" "cd $PROD_DIR && $COMPOSE exec -T api node -e 'fetch(\"http://127.0.0.1:3100/healthz\").then(r=>{if(!r.ok)throw 0})'" >/dev/null 2>&1; then
    say "API healthy (attempt $attempt)"
    break
  fi
  [[ "$attempt" == 20 ]] && { echo "ERROR: API health check failed after 20 attempts" >&2; exit 3; }
  sleep 3
done

say "Done. Public: https://\$PUBLIC_HOSTNAME (Traefik routes once DNS resolves)."

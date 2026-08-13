#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/db/schema.sql"
SEED_FILE="$ROOT_DIR/db/seed/demo.sql"

if [[ -n "${SIDESTAGE_DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null 2>&1 || {
    echo "psql is required when SIDESTAGE_DATABASE_URL is set" >&2
    exit 1
  }
  psql "$SIDESTAGE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE" -f "$SEED_FILE"
  exit 0
fi

COMPOSE_FILE="${SIDESTAGE_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.data.yml}"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "${POSTGRES_USER:-sidestage}" -d "${POSTGRES_DB:-sidestage}" \
  -v ON_ERROR_STOP=1 -f - < "$SCHEMA_FILE"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "${POSTGRES_USER:-sidestage}" -d "${POSTGRES_DB:-sidestage}" \
  -v ON_ERROR_STOP=1 -f - < "$SEED_FILE"

echo "Seeded SideStage demo catalog into ${POSTGRES_DB:-sidestage}."

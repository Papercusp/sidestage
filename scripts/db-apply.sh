#!/usr/bin/env bash
#
# Apply db/schema.sql to an EXISTING database.
#
# Postgres runs /docker-entrypoint-initdb.d only when it initialises an empty
# volume, so a table added to schema.sql after a dev database exists never lands
# there and the API 500s on it at request time. This is the remedy the boot-time
# schema guard points at (apps/api/src/db/schema-guard.ts).
#
# Schema ONLY — no seed data. scripts/seed-catalog.sh is the schema+seed path for
# standing a database up from nothing; this one is safe to run against a database
# that already holds real rows.
#
# schema.sql is idempotent (every CREATE TABLE/INDEX is IF NOT EXISTS, every
# CREATE TRIGGER is preceded by DROP TRIGGER IF EXISTS, every function is CREATE
# OR REPLACE), so re-running it is a no-op on an up-to-date database. Verified by
# double-apply: both passes exit 0.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/db/schema.sql"

[[ -f "$SCHEMA_FILE" ]] || {
  echo "db-apply: schema file not found at $SCHEMA_FILE" >&2
  exit 1
}

# Direct-URL branch, mirroring scripts/seed-catalog.sh so both honour the same env.
if [[ -n "${SIDESTAGE_DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null 2>&1 || {
    echo "db-apply: psql is required when SIDESTAGE_DATABASE_URL is set" >&2
    exit 1
  }
  psql "$SIDESTAGE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE"
  echo "db-apply: schema applied via SIDESTAGE_DATABASE_URL."
  exit 0
fi

COMPOSE_FILE="${SIDESTAGE_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.data.yml}"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "${POSTGRES_USER:-sidestage}" -d "${POSTGRES_DB:-sidestage}" \
  -v ON_ERROR_STOP=1 -f - < "$SCHEMA_FILE"

echo "db-apply: schema applied to ${POSTGRES_DB:-sidestage}. Restart the API to clear the boot guard."

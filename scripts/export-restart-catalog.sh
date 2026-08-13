#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_FILE="${1:-$ROOT_DIR/db/seed/restart-catalog.sql}"
SOURCE_URL="${RESTART_DATABASE_URL:-${DATABASE_URL:-}}"

if [[ -z "$SOURCE_URL" ]]; then
  echo "Set RESTART_DATABASE_URL (or DATABASE_URL) to the Restart Postgres URL." >&2
  exit 2
fi

command -v pg_dump >/dev/null 2>&1 || {
  echo "pg_dump is required to export Restart catalog data." >&2
  exit 1
}

mkdir -p "$(dirname -- "$OUTPUT_FILE")"

TEMP_DUMP="$(mktemp "${TMPDIR:-/tmp}/sidestage-catalog.XXXXXX.sql")"
trap 'rm -f "$TEMP_DUMP"' EXIT

# The image metadata is stored in product_catalog.images in Restart. Exporting
# both tables keeps the catalog rows and their storefront variants together;
# production credentials and unrelated tables are never written to the repo.
pg_dump "$SOURCE_URL" \
  --data-only \
  --column-inserts \
  --no-owner \
  --no-privileges \
  --table=product_catalog \
  --table=storefront_product \
  > "$TEMP_DUMP"

# pg_dump is intentionally forward-compatible only within limits. Host tools
# can be newer than the Postgres image used by clean-clone (for example,
# pg_dump 18 emits transaction_timeout while Postgres 16 does not know it).
# Remove that harmless session setting so the two-table data dump restores on
# the pinned Postgres 16 image.
sed '/^SET transaction_timeout = 0;$/d' "$TEMP_DUMP" > "$OUTPUT_FILE"

echo "Exported Restart product_catalog + storefront_product to ${OUTPUT_FILE#$ROOT_DIR/}."

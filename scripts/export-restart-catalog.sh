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
  > "$OUTPUT_FILE"

echo "Exported Restart product_catalog + storefront_product to ${OUTPUT_FILE#$ROOT_DIR/}."

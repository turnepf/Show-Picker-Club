#!/usr/bin/env bash
#
# Apply pending D1 migrations to the production shows-db, tracked in a
# schema_migrations table we own (NOT wrangler's, since the existing
# migrations were applied by hand via `wrangler d1 execute`).
#
# First run = BASELINE: the table is created empty, so every migration that
# already exists in the repo is recorded as applied WITHOUT re-running it.
# That's correct because production already has them and schema.sql reflects
# the full current schema. Introduce this runner in a commit with no new
# migration, so the baseline matches what's actually applied.
#
# Every run after that applies (and records) only files not yet in the table.
#
# Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
set -euo pipefail

DB="shows-db"
DIR="migrations"

run_sql() { wrangler d1 execute "$DB" --remote --command "$1"; }

# Tracking table.
run_sql "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));"

# Current applied set (one filename per line).
applied="$(wrangler d1 execute "$DB" --remote --json \
  --command "SELECT name FROM schema_migrations ORDER BY name;" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);const rows=(Array.isArray(r)?(r[0]&&r[0].results):r.results)||[];console.log(rows.map(x=>x.name).join('\n'));}catch(e){console.log('');}});")"

applied_count="$(printf '%s' "$applied" | grep -c . || true)"

files="$(ls "$DIR"/*.sql 2>/dev/null | sort || true)"
if [ -z "$files" ]; then echo "No migration files found."; exit 0; fi

if [ "$applied_count" -eq 0 ]; then
  echo "First run — baselining existing migrations as already applied:"
  for f in $files; do
    name="$(basename "$f")"
    echo "  baseline: $name"
    run_sql "INSERT OR IGNORE INTO schema_migrations(name) VALUES ('$name');"
  done
  echo "Baseline complete. New migrations will auto-apply on future deploys."
  exit 0
fi

pending=0
for f in $files; do
  name="$(basename "$f")"
  if printf '%s\n' "$applied" | grep -qxF "$name"; then continue; fi
  echo "Applying migration: $name"
  wrangler d1 execute "$DB" --remote --file="$f"
  run_sql "INSERT OR IGNORE INTO schema_migrations(name) VALUES ('$name');"
  pending=$((pending + 1))
done
[ "$pending" -eq 0 ] && echo "Migrations up to date." || echo "Applied $pending migration(s)."

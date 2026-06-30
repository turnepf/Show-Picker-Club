#!/usr/bin/env bash
#
# Member engagement report: for every member, how long since their last login
# and whether they've done anything beyond the starter seeds. Use it to decide
# who to prune for inactivity.
#
# Columns:
#   days_since_login  — whole days since last_login_at (NULL = no login recorded
#                       since login tracking shipped in migration 013; these are
#                       "unknown", not necessarily inactive — sorted to the end)
#   show_status       — engaged  : has at least one real (non-seed) show
#                       seed_only : still has nothing but the 8 starter seeds
#                       no_shows  : no non-archived shows at all
#
# Oldest logins first, so the people most likely to prune float to the top.
#
# Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
# Pass --local to run against the local dev D1 copy instead of production.
set -euo pipefail

DB="shows-db"
REMOTE="--remote"
[ "${1:-}" = "--local" ] && REMOTE="--local"

wrangler d1 execute "$DB" $REMOTE --command "
SELECT
  m.slug,
  m.name,
  m.last_login_at,
  CASE
    WHEN m.last_login_at IS NULL THEN NULL
    ELSE CAST(julianday('now') - julianday(m.last_login_at) AS INT)
  END AS days_since_login,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM shows s WHERE s.member_slug = m.slug AND s.archived = 0
    ) THEN 'no_shows'
    WHEN NOT EXISTS (
      SELECT 1 FROM shows x
      WHERE x.member_slug = m.slug AND x.archived = 0
        AND (x.added_by <> 'seed' OR x.created_at IS NOT NULL OR x.updated_at IS NOT NULL)
    ) THEN 'seed_only'
    ELSE 'engaged'
  END AS show_status
FROM members m
ORDER BY days_since_login DESC NULLS LAST, m.name;
"

#!/usr/bin/env bash
#
# Export a member's lists as a Trakt.tv bulk-import CSV, for testing what a
# Trakt integration would actually carry across. Writes to ~/Downloads by
# default and prints a summary of what went in and what got skipped.
#
# Trakt's CSV format is: id,type,watched_at,watchlisted_at,rating,rated_at
# We emit tmdb_id as the id column, since shows.tmdb_id is set by the
# enrichment pipeline and Trakt resolves TMDB ids natively.
#
# How the four lists map — the important part, because Trakt has no column
# for "partly watched":
#
#   Loved      -> watched_at      Watched it. Caught up on everything aired.
#   Awaiting   -> watched_at      Finished the current season; also caught up.
#   Watching   -> watchlisted_at  In progress. Deliberately NOT watched_at:
#                                 a `type=show` row with watched_at marks
#                                 EVERY aired episode watched, which would
#                                 fabricate history for a show you're partway
#                                 through. Watchlisting is the honest option
#                                 this format allows.
#   Next Up    -> watchlisted_at  Want to watch, haven't started.
#
# Ratings come from show_ratings at season_number = 0 (the overall rating),
# for this member only — ratings are pooled across every member's copy of a
# title, so the member_slug filter matters.
#
# Timestamps: D1 stores 'YYYY-MM-DD HH:MM:SS'; Trakt wants ISO 8601, hence
# the space -> 'T' swap and the 'Z'. watched_at falls back to the literal
# "unknown" (which Trakt accepts) when a row has no usable date.
#
# Skipped rows: archived shows, untouched starter seeds (added_by='seed' with
# no updated_at — the operator's auto-picks, not yours), and anything with no
# tmdb_id, which has no importable identifier. The skip counts are printed.
#
# Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
#
# Usage:
#   bash scripts/trakt-export.sh
#   bash scripts/trakt-export.sh --member whitt
#   bash scripts/trakt-export.sh --out /tmp/test.csv
#   bash scripts/trakt-export.sh --local
set -euo pipefail

DB="shows-db"
REMOTE="--remote"
MEMBER="patrick"
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local)  REMOTE="--local" ;;
    --member) shift; MEMBER="${1:-}" ;;
    --out)    shift; OUT="${1:-}" ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

[ -n "$MEMBER" ] || { echo "--member needs a slug" >&2; exit 1; }
[ -n "$OUT" ] || OUT="$HOME/Downloads/showpicker-trakt-$MEMBER.csv"

# Every included row must have a tmdb_id, be active, and not be an untouched
# starter seed. Kept in one place so the export and the skip report agree.
INCLUDE="s.member_slug = '$MEMBER'
     AND s.archived = 0
     AND NOT (COALESCE(s.added_by, '') = 'seed' AND s.updated_at IS NULL)"

# Build each CSV line in SQL so the client side stays a dumb pipe. No column
# in Trakt's format is free text, so nothing here needs quoting or escaping.
ROWS_SQL="
SELECT s.tmdb_id || ',' ||
  CASE WHEN s.tmdb_type = 'movie' OR s.movie = 1 THEN 'movie' ELSE 'show' END || ',' ||
  CASE WHEN s.list IN ('recommending', 'waiting')
       THEN COALESCE(REPLACE(s.updated_at, ' ', 'T') || 'Z',
                     REPLACE(s.created_at, ' ', 'T') || 'Z',
                     'unknown')
       ELSE '' END || ',' ||
  CASE WHEN s.list IN ('watching', 'next')
       THEN COALESCE(REPLACE(s.created_at, ' ', 'T') || 'Z',
                     REPLACE(s.updated_at, ' ', 'T') || 'Z',
                     '')
       ELSE '' END || ',' ||
  COALESCE(CAST(r.rating AS TEXT), '') || ',' ||
  CASE WHEN r.rating IS NULL THEN ''
       ELSE COALESCE(REPLACE(r.updated_at, ' ', 'T') || 'Z', '') END AS line
FROM shows s
LEFT JOIN show_ratings r
       ON r.tmdb_id = s.tmdb_id
      AND r.tmdb_type = s.tmdb_type
      AND r.season_number = 0
      AND r.member_slug = s.member_slug
WHERE $INCLUDE
  AND s.tmdb_id IS NOT NULL
ORDER BY CASE s.list WHEN 'watching' THEN 1 WHEN 'waiting' THEN 2
                     WHEN 'recommending' THEN 3 WHEN 'next' THEN 4 ELSE 5 END,
         s.title COLLATE NOCASE
"

SUMMARY_SQL="
SELECT s.list AS line,
       COUNT(*) AS n,
       SUM(CASE WHEN s.tmdb_id IS NULL THEN 1 ELSE 0 END) AS no_tmdb_id
FROM shows s
WHERE $INCLUDE
GROUP BY s.list
"

# wrangler prints a banner before the JSON, and that banner contains '[' in
# its ANSI codes — so find the array by the line that opens it, not by the
# first bracket in the stream.
extract() {
  node -e '
    let buf = "";
    process.stdin.on("data", d => buf += d);
    process.stdin.on("end", () => {
      const lines = buf.split("\n");
      const start = lines.findIndex(l => l.trim() === "[" || l.trim().startsWith("[{"));
      if (start < 0) { console.error("no JSON array in wrangler output"); process.exit(1); }
      const payload = JSON.parse(lines.slice(start).join("\n"));
      const rows = (payload[0] && payload[0].results) || [];
      process.stdout.write(JSON.stringify(rows));
    });
  '
}

mkdir -p "$(dirname "$OUT")"

printf 'tmdb_id,type,watched_at,watchlisted_at,rating,rated_at\n' > "$OUT"
wrangler d1 execute "$DB" $REMOTE --json --command "$ROWS_SQL" \
  | extract \
  | node -e '
      let buf = "";
      process.stdin.on("data", d => buf += d);
      process.stdin.on("end", () => {
        const rows = JSON.parse(buf);
        if (rows.length) process.stdout.write(rows.map(r => r.line).join("\n") + "\n");
      });
    ' >> "$OUT"

EXPORTED=$(( $(wc -l < "$OUT") - 1 ))

echo
echo "Wrote $EXPORTED rows to $OUT"
echo
wrangler d1 execute "$DB" $REMOTE --json --command "$SUMMARY_SQL" \
  | extract \
  | node -e '
      const LABELS = { watching: "Watching", waiting: "Awaiting",
                       recommending: "Loved", next: "Next Up" };
      const TARGET = { watching: "watchlisted", waiting: "watched",
                       recommending: "watched", next: "watchlisted" };
      let buf = "";
      process.stdin.on("data", d => buf += d);
      process.stdin.on("end", () => {
        const rows = JSON.parse(buf);
        let skipped = 0;
        for (const r of rows) {
          const label = LABELS[r.line] || r.line;
          const target = TARGET[r.line] || "?";
          skipped += r.no_tmdb_id;
          console.log(
            "  " + label.padEnd(10) +
            String(r.n - r.no_tmdb_id).padStart(4) + " exported as " + target +
            (r.no_tmdb_id ? "   (" + r.no_tmdb_id + " skipped, no tmdb_id)" : "")
          );
        }
        if (skipped) {
          console.log();
          console.log("  " + skipped + " row(s) skipped for having no tmdb_id — they have no");
          console.log("  identifier Trakt can resolve. Opening each in the app and");
          console.log("  re-picking it from search would populate one.");
        }
      });
    '
echo

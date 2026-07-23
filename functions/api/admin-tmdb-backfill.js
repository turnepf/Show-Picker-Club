import { isAdmin } from '../_shared/admin.js';
import { searchTmdbId } from '../_shared/enrichment.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Permanently dismissed titles (see migrations/052) — confirmed by hand to
// have no TMDB entry at all. /api/admin-tmdb-backfill creates this table on
// demand (identical statement to the migration) so deploy order doesn't
// matter.
const CREATE_IGNORES_TABLE = `CREATE TABLE IF NOT EXISTS tmdb_backfill_ignores (
  ltitle TEXT NOT NULL PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
)`;

// One-time backfill: rows added before migration 049 have no
// tmdb_id/tmdb_type. Member ratings need that pair to pool across every
// member's independent copy of the same title, so this walks rows missing
// it, re-runs a lightweight TMDB search (searchTmdbId — id/type only, no
// detail/cast/rating fetch), and writes the id/type onto every copy sharing
// that title (a lookup for one member's copy covers everyone's). Titles
// TMDB can't confidently match come back in `unresolved` for a one-time
// manual review — this is a single-use pass, not an ongoing queue like
// /url-cleanup, since it only needs to run once at launch.
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  await env.DB.prepare(CREATE_IGNORES_TABLE).run();

  if (body.action === 'dismiss') {
    // Confirmed by hand to have no TMDB entry — stop surfacing it in
    // `unresolved`. Scoped by title (case-insensitive), same grouping the
    // backfill itself uses.
    const title = String(body.title || '').trim();
    if (!title) return json({ error: 'title required' }, 400);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO tmdb_backfill_ignores (ltitle) VALUES (LOWER(?))'
    ).bind(title).run();
    return json({ ok: true });
  }

  // Soft cap per invocation, well under Cloudflare's subrequest ceiling —
  // call repeatedly until `remaining` hits 0. searchTmdbId costs 1-2
  // subrequests/title (vs. fetchEnrichment's ~7 for a full add/edit), so
  // this can run a much bigger batch per call than a full-enrichment pass.
  const maxTitles = parseInt(body.max_titles ?? '100', 10);

  const { results: rows } = await env.DB.prepare(
    `SELECT id, title, movie FROM shows
     WHERE tmdb_id IS NULL
       AND LOWER(title) NOT IN (SELECT ltitle FROM tmdb_backfill_ignores)
     GROUP BY LOWER(title)
     ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC
     LIMIT ?`
  ).bind(maxTitles).all();

  let matched = 0;
  const unresolved = [];
  for (const row of rows) {
    const found = await searchTmdbId(row.title, env, !!row.movie);
    if (found.tmdbId) {
      const result = await env.DB.prepare(
        `UPDATE shows SET tmdb_id = ?, tmdb_type = ?
         WHERE LOWER(title) = LOWER(?) AND tmdb_id IS NULL`
      ).bind(found.tmdbId, found.tmdbType, row.title).run();
      matched += result.meta.changes;
    } else {
      // Stamp enriched_at on a miss so this title rotates to the back of the
      // queue next call (same idiom as admin-url-cleanup.js's re_enrich) —
      // without this, an unresolved title keeps the oldest enriched_at and
      // wins the ORDER BY race every single call, starving the rest of the
      // backlog of a turn.
      await env.DB.prepare(
        `UPDATE shows SET enriched_at = datetime('now')
         WHERE LOWER(title) = LOWER(?) AND tmdb_id IS NULL`
      ).bind(row.title).run();
      unresolved.push({ id: row.id, title: row.title, movie: !!row.movie, reason: found.reason });
    }
  }

  const { cnt: remaining } = (await env.DB.prepare(
    `SELECT COUNT(DISTINCT LOWER(title)) AS cnt FROM shows
     WHERE tmdb_id IS NULL
       AND LOWER(title) NOT IN (SELECT ltitle FROM tmdb_backfill_ignores)`
  ).first()) || { cnt: 0 };

  return json({ ok: true, processed: rows.length, matched, remaining, unresolved });
}

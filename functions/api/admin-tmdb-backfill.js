import { isAdmin } from '../_shared/admin.js';
import { fetchEnrichment } from '../_shared/enrichment.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// One-time backfill: rows added before migration 049 have no
// tmdb_id/tmdb_type. Member ratings need that pair to pool across every
// member's independent copy of the same title, so this walks rows missing
// it, re-runs the title search, and writes the id/type onto every copy
// sharing that title (a fetch for one member's copy covers everyone's).
// Titles TMDB can't confidently match come back in `unresolved` for a
// one-time manual review — this is a single-use pass, not an ongoing queue
// like /url-cleanup, since it only needs to run once at launch.
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  // Soft cap per invocation, well under Cloudflare's subrequest ceiling —
  // call repeatedly until `remaining` hits 0.
  const maxTitles = parseInt(body.max_titles ?? '40', 10);

  const { results: rows } = await env.DB.prepare(
    `SELECT id, title, movie FROM shows
     WHERE tmdb_id IS NULL
     GROUP BY LOWER(title)
     ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC
     LIMIT ?`
  ).bind(maxTitles).all();

  let matched = 0;
  const unresolved = [];
  for (const row of rows) {
    const enriched = await fetchEnrichment(row.title, env, !!row.movie);
    if (enriched.tmdbId) {
      const result = await env.DB.prepare(
        `UPDATE shows SET tmdb_id = ?, tmdb_type = ?
         WHERE LOWER(title) = LOWER(?) AND tmdb_id IS NULL`
      ).bind(enriched.tmdbId, enriched.tmdbType, row.title).run();
      matched += result.meta.changes;
    } else {
      unresolved.push({ id: row.id, title: row.title, movie: !!row.movie });
    }
  }

  const { cnt: remaining } = (await env.DB.prepare(
    `SELECT COUNT(DISTINCT LOWER(title)) AS cnt FROM shows WHERE tmdb_id IS NULL`
  ).first()) || { cnt: 0 };

  return json({ ok: true, processed: rows.length, matched, remaining, unresolved });
}

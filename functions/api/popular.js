import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';
import { getSession } from '../_shared/auth.js';
import { TRENDING_LISTS_SQL } from '../_shared/trending-lists.js';
import { sameShowJoin, showKeySql } from '../_shared/same-show.js';

// One card per show: copies pinned to different TMDB entries that share a
// title (three 2026 films are called "The Odyssey") stay separate cards, and
// each card's poster, link and rating come from a copy of that same entry.
const SAME_AS_S = sameShowJoin('x', 's');
const SHOW_KEY = showKeySql('s');

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

// How many trending titles the endpoint will return. Clients draw the first
// TRENDING_PAGE and expand to the rest behind a "Show more", so the default is
// what a client gets when it asks for nothing, and the cap is what stops a
// hand-written ?limit= from turning this into a full table scan with an actor
// join per row.
const TRENDING_DEFAULT = 10;
const TRENDING_MAX = 50;

// Trending is a DAILY SNAPSHOT, recomputed at most once per UTC day. The
// ranking below is the most expensive read in the product — correlated
// title-matched subqueries across the whole shows table — and this endpoint is
// public and sits on every platform's launch screen, so every uncached hit
// paid that cost. On 2026-09-01 bot traffic against the public surface burned
// the free tier's entire daily D1 rows_read budget through it and took the
// API down for everyone. The first request of a day computes the full
// TRENDING_MAX ranking into trending_cache; every other request that day —
// including every anonymous bot hit — reads one row. New adds surface in
// Trending the next UTC day; per-viewer member naming still happens fresh on
// every request, so nothing session-scoped is ever cached.
async function computeTrending(env) {
  // Top shows by how many members added them in the last 30 days — a rolling
  // "what the club is picking up right now" feed. The RANKING uses only recent
  // adds, but the DISPLAY fields (poster, logo, rating, network) are pulled
  // from the best available row for the title regardless of when it was added —
  // otherwise a show trending on brand-new (un-enriched) rows shows no poster
  // even though an older copy on someone's list already has the art.
  const { results } = await env.DB.prepare(
    `SELECT LOWER(s.title) as ltitle, s.title, s.movie, s.tmdb_id, s.tmdb_type,
       MIN(s.id) as id,
       COUNT(DISTINCT s.member_slug) as member_count,
       GROUP_CONCAT(DISTINCT s.member_slug) as member_slugs,
       (SELECT x.poster_url FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0 AND x.poster_url IS NOT NULL LIMIT 1) as poster_url,
       (SELECT x.network_logo_url FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0 AND x.network_logo_url IS NOT NULL LIMIT 1) as network_logo_url,
       (SELECT x.rating FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0 AND x.rating IS NOT NULL LIMIT 1) as rating,
       (SELECT x.genres FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0 AND x.genres IS NOT NULL LIMIT 1) as genres,
       (SELECT x.network FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0 AND x.network IS NOT NULL LIMIT 1) as network,
       (SELECT x.network_url FROM shows_v x WHERE ${SAME_AS_S} AND x.archived = 0
          AND x.network_url IS NOT NULL AND x.network_url NOT LIKE '%/search%' AND x.network_url NOT LIKE '%/s?%'
          AND x.network_url NOT LIKE '%?q=%' AND x.network_url NOT LIKE '%?query=%' LIMIT 1) as network_url
     FROM shows_v s
     WHERE s.archived = 0
       AND s.member_slug NOT IN (${EXCLUDED_SQL})
       -- Seeded rows are the operator's auto-pick, not a member endorsement.
       -- A row "counts" only once a member has actually touched it
       -- (added themselves, or had a list manually loaded by the operator).
       AND COALESCE(s.added_by, '') != 'seed'
       -- Only adds from the last 30 days feed the ranking.
       AND s.created_at >= datetime('now', '-30 days')
       -- Watching/Awaiting/Loved only. Next Up is the maybe-pile, and counting
       -- it let a title nobody had started trend on bookmarks alone.
       AND s.list IN (${TRENDING_LISTS_SQL})
     GROUP BY ${SHOW_KEY}
     ORDER BY member_count DESC, CAST(rating AS REAL) DESC
     LIMIT ?1`
  ).bind(TRENDING_MAX).all();

  // Pull actors for the whole snapshot in one query rather than one per show.
  // Include imdb_id so the front end can render clickable IMDB links —
  // matching the {name, imdb_id} shape the member-page endpoints return. A
  // plain name string would parse to imdb_id:null and render as
  // non-clickable tags.
  const showIds = results.map(s => s.id);
  const byShow = new Map();
  if (showIds.length) {
    const { results: acts } = await env.DB.prepare(
      `SELECT show_id, name, imdb_id FROM actors_v
        WHERE show_id IN (${showIds.map(() => '?').join(',')})
        ORDER BY show_id, ord`
    ).bind(...showIds).all();
    for (const a of acts) {
      if (!byShow.has(a.show_id)) byShow.set(a.show_id, []);
      byShow.get(a.show_id).push({ name: a.name, imdb_id: a.imdb_id });
    }
  }
  for (const show of results) {
    show.actors = byShow.get(show.id) || null;
  }
  return results;
}

export async function onRequestGet(context) {
  const { env, request } = context;

  const asked = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isFinite(asked) && asked > 0
    ? Math.min(Math.trunc(asked), TRENDING_MAX)
    : TRENDING_DEFAULT;

  // Serve today's snapshot if one exists; compute and store it otherwise. The
  // snapshot always holds the full TRENDING_MAX ranking regardless of what
  // this particular request asked for, so a later ?limit= expansion slices the
  // same cached ranking instead of forcing a recompute. The .catch()es keep
  // the endpoint alive if the trending_cache table isn't there yet (a preview
  // DB that predates migration 067): reads fall through to a fresh compute,
  // which is exactly the old behavior.
  const day = new Date().toISOString().slice(0, 10);
  let rows = null;
  const cached = await env.DB.prepare('SELECT payload FROM trending_cache WHERE day = ?')
    .bind(day).first().catch(() => null);
  if (cached) {
    try { rows = JSON.parse(cached.payload); } catch { rows = null; }
  }
  if (!Array.isArray(rows)) {
    rows = await computeTrending(env);
    // Snapshot before the per-viewer pass below mutates the rows, and keep
    // the table at one row rather than accumulating a row per day.
    const payload = JSON.stringify(rows);
    await env.DB.prepare('DELETE FROM trending_cache WHERE day != ?').bind(day).run().catch(() => {});
    await env.DB.prepare('INSERT OR REPLACE INTO trending_cache (day, payload) VALUES (?, ?)')
      .bind(day, payload).run().catch(() => {});
  }

  const results = rows.slice(0, limit);

  // Map slugs to first names. Members.name is the possessive display
  // name ("Carter's Shows") — splitting on space gave "Carter's", which
  // showed up wrong in the "Watching: ..." line. Use the dedicated
  // first_name column instead, falling back to name's first token only
  // if first_name is missing for some reason.
  // Who gets named on a Trending row: only members of the viewer's own
  // groups. Trending itself is public — the titles are the club's taste, and
  // a stranger who just installed the app should see them — but "Added by"
  // names people, and a name is exactly what someone with no account has no
  // relationship to. Logged out, there are no groups, so there are no names.
  const session = await getSession(request, env);
  const { results: members } = session ? await env.DB.prepare(
    `SELECT m.slug, m.name, m.first_name FROM members m
      WHERE m.slug = ?1 OR m.slug IN (
        SELECT gm.member_slug FROM group_members gm
         WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?1))`
  ).bind(session.member_slug).all().catch(() => ({ results: [] })) : { results: [] };
  const nameMap = {};
  for (const h of members) {
    nameMap[h.slug] = h.first_name || (h.name || '').split(' ')[0];
  }

  // Add member names to each show
  for (const show of results) {
    show.members = (show.member_slugs || '').split(',')
      .map(s => nameMap[s])
      .filter(Boolean)   // outside my groups (or logged out) → not named at all
      .sort();
    delete show.member_slugs;
  }

  return new Response(JSON.stringify({ shows: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

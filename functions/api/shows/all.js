// Returns all active shows across every member, for the cross-library
// search. Includes member info so results can show "on Watching · William".
import { getSession } from '../../_shared/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  // Every member's library — members only. Catalog fields only: personal
  // fields (notes, watching_with, recommended_by, added_by) never appear
  // here, and member names are display names (first name, plus last initial
  // only when two members share a first name) — full names stay server-side.
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.network, s.network_url, s.rating, s.movie,
            s.full_series, s.list, s.member_slug, s.genres,
            -- Artwork is per-row and backfills row-by-row; borrow from any
            -- active copy of the same title so no member's result lacks a
            -- poster another member's copy already has.
            COALESCE(s.poster_url, (SELECT x.poster_url FROM shows x
              WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
                AND x.poster_url IS NOT NULL LIMIT 1)) AS poster_url,
            COALESCE(s.network_logo_url, (SELECT x.network_logo_url FROM shows x
              WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
                AND x.network_logo_url IS NOT NULL LIMIT 1)) AS network_logo_url,
            s.seasons_released, s.next_season_date, s.season_end_date,
            m.name AS member_raw_name, m.first_name AS member_raw_first,
            m.last_initial AS member_last_initial,
            (SELECT json_group_array(json_object('name', a.name, 'imdb_id', a.imdb_id))
             FROM actors a WHERE a.show_id = s.id) AS actors
     FROM shows s
     JOIN members m ON m.slug = s.member_slug
     WHERE s.archived = 0
       -- Your libraries: yours, plus the members you share a group with.
       -- Searching every library meant results labelled with the name of
       -- someone you have no relationship with — the same reason the roster
       -- came off the home screens and Vibe is group-scoped.
       AND (s.member_slug = ?1 OR s.member_slug IN (
             SELECT gm.member_slug FROM group_members gm
              WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?1)
           ))
     ORDER BY s.title COLLATE NOCASE`
  ).bind(session.member_slug).all();

  // First-name display, disambiguated with a last initial only on collision
  // (same policy as /api/members).
  const firstNameCounts = {};
  const memberFirst = new Map();
  for (const r of results) {
    if (memberFirst.has(r.member_slug)) continue;
    const fn = r.member_raw_first || (r.member_raw_name || '').split(' ')[0];
    memberFirst.set(r.member_slug, fn);
    firstNameCounts[fn] = (firstNameCounts[fn] || 0) + 1;
  }
  for (const r of results) {
    const fn = memberFirst.get(r.member_slug);
    r.member_first_name = fn;
    r.member_name = firstNameCounts[fn] > 1 && r.member_last_initial
      ? `${fn} ${r.member_last_initial}`
      : fn;
    delete r.member_raw_name;
    delete r.member_raw_first;
    delete r.member_last_initial;
  }
  return new Response(JSON.stringify({ shows: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

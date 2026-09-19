// Returns all active shows across every member, for the cross-library
// search. Includes member info so results can show "on Watching · William".
//
// `?q=` filters server-side and is optional: without it the response is
// exactly what it has always been, so the web and Apple clients that filter
// locally are unaffected. It exists for Roku, which has to run on hardware
// going back about eight years — downloading, parsing and retaining the whole
// club library is the single heaviest thing that channel did, and on a 512MB
// 2017 box it is the thing most likely to fall over as the club grows.
// Filtering here means the device receives matches instead of everything.
import { getSession } from '../../_shared/auth.js';

// Ceiling on a filtered response. A one-letter query matches most of the
// library, and the point of the parameter is to bound what a small device
// receives — an unbounded `q` would just be the old problem with extra steps.
const SEARCH_DEFAULT_LIMIT = 100;
const SEARCH_MAX_LIMIT = 200;

// LIKE treats % and _ as wildcards, so a member searching for "50%" or
// "Mr_Robot" would otherwise get a pattern rather than the text they typed —
// and a bare "%" would match the entire library, which is precisely the
// request this parameter exists to prevent.
function likePattern(q) {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped.toLowerCase()}%`;
}

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
  const url = new URL(request.url);
  // A blank or whitespace-only q reads as "no filter" rather than "match
  // nothing" — an empty search box should not look like an empty library.
  const q = (url.searchParams.get('q') || '').trim();
  const filtered = q.length > 0;

  const rawLimit = parseInt(url.searchParams.get('limit'), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;

  // Matches what the clients match on locally: title, network, genre, cast.
  // Cast lives in its own table, so it is an EXISTS rather than a column.
  const filterSql = filtered
    ? `AND (LOWER(s.title) LIKE ?2 ESCAPE '\\'
            OR LOWER(COALESCE(s.network, '')) LIKE ?2 ESCAPE '\\'
            OR LOWER(COALESCE(s.genres, '')) LIKE ?2 ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id
                        AND LOWER(a.name) LIKE ?2 ESCAPE '\\'))`
    : '';
  const limitSql = filtered ? `LIMIT ${limit}` : '';

  const stmt = env.DB.prepare(
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
       ${filterSql}
     ORDER BY s.title COLLATE NOCASE
     ${limitSql}`
  );
  const { results } = await (filtered
    ? stmt.bind(session.member_slug, likePattern(q))
    : stmt.bind(session.member_slug)).all();

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

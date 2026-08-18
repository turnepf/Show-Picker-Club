import { getSession } from '../_shared/auth.js';
import { TRENDING_LISTS } from '../_shared/trending-lists.js';

const LISTS_SQL = TRENDING_LISTS.map(l => `'${l}'`).join(',');

// How many actors the page shows. Nico's framing was "favorite actors and
// their other shows", and a favourite you have to scroll to isn't one.
const TOP_N = 10;

// Favourite actors, derived rather than picked.
//
// There is no "favourite" flag anywhere and deliberately so: the signal is
// already in the library. An actor who keeps turning up across the shows you
// watch, await and loved IS a favourite, and asking members to curate a
// second list to say so would just decay. Next Up is excluded for the same
// reason Trending excludes it — bookmarking a show is not yet a statement
// about who's in it.
//
// Owner-only. This reads one member's whole library in aggregate, which is a
// sharper picture of taste than the list titles a group-mate can already see,
// so it stays on the session's own member and takes no ?member= parameter.
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Group on the person, not the string: the same actor arrives with a
  // tmdb_person_id from enrichment, and credits that predate it fall back to
  // the lowercased name. Counting DISTINCT title rather than rows keeps a
  // member who holds the same show on two lists from double-counting its cast.
  const { results: top } = await env.DB.prepare(
    `SELECT
       MIN(a.name) as name,
       MAX(a.imdb_id) as imdb_id,
       a.tmdb_person_id as tmdb_person_id,
       COUNT(DISTINCT LOWER(s.title)) as show_count
     FROM actors a
     JOIN shows s ON s.id = a.show_id
     WHERE s.member_slug = ?1
       AND s.archived = 0
       AND s.list IN (${LISTS_SQL})
     GROUP BY COALESCE(a.tmdb_person_id, LOWER(a.name))
     HAVING show_count > 0
     ORDER BY show_count DESC, name COLLATE NOCASE
     LIMIT ${TOP_N}`
  ).bind(session.member_slug).all();

  // The titles behind each count, so the row can say why the actor is there.
  // One query for the whole page rather than one per actor.
  const keys = top.map(a => a.tmdb_person_id ?? null);
  const names = top.map(a => (a.name || '').toLowerCase());
  const byActor = new Map();
  if (top.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT DISTINCT a.tmdb_person_id, LOWER(a.name) as lname, s.title
         FROM actors a
         JOIN shows s ON s.id = a.show_id
        WHERE s.member_slug = ?1
          AND s.archived = 0
          AND s.list IN (${LISTS_SQL})
          AND (a.tmdb_person_id IN (${keys.map(() => '?').join(',')})
               OR LOWER(a.name) IN (${names.map(() => '?').join(',')}))
        ORDER BY s.title COLLATE NOCASE`
    ).bind(session.member_slug, ...keys, ...names).all();
    for (const r of rows) {
      const k = r.tmdb_person_id ?? r.lname;
      if (!byActor.has(k)) byActor.set(k, []);
      byActor.get(k).push(r.title);
    }
  }

  const actors = top.map(a => ({
    name: a.name,
    imdb_id: a.imdb_id || null,
    tmdb_person_id: a.tmdb_person_id ?? null,
    show_count: a.show_count,
    shows: byActor.get(a.tmdb_person_id ?? (a.name || '').toLowerCase()) || [],
  }));

  return new Response(JSON.stringify({ actors }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

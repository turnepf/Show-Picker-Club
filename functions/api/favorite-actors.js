import { getSession } from '../_shared/auth.js';
import { TRENDING_LISTS } from '../_shared/trending-lists.js';

const LISTS_SQL = TRENDING_LISTS.map(l => `'${l}'`).join(',');

// How many actors the page shows. Nico's framing was "favorite actors and
// their other shows", and a favourite you have to scroll to isn't one.
const TOP_N = 10;

// Who a credit is FOR. Grouping on the raw row split real people in half:
// credits written before migration 060 carry no tmdb_person_id, so an actor
// with two pre-060 shows and two post-060 shows read as two strangers with
// two shows each — which is exactly how a library full of favourites renders
// as a wall of "2 shows". A legacy name-only credit resolves to the id the
// member's own library already knows for that name, then to the id the club's
// `people` bank knows, and only a name nobody has ever resolved stays keyed
// by the lowercased name.
const PERSON_KEY = `COALESCE(a.tmdb_person_id, own.pid, glob.pid, LOWER(a.name))`;

// `own` before `glob` on purpose: two humans can share a name, and the id the
// member's own enriched rows carry is more likely to be the person on their
// list than the club-wide MIN.
const PERSON_JOINS = `
     LEFT JOIN (SELECT LOWER(a2.name) AS name_lower, MIN(a2.tmdb_person_id) AS pid
                  FROM actors a2
                  JOIN shows s2 ON s2.id = a2.show_id
                 WHERE s2.member_slug = ?1 AND a2.tmdb_person_id IS NOT NULL
                 GROUP BY LOWER(a2.name)) own
       ON own.name_lower = LOWER(a.name)
     LEFT JOIN (SELECT name_lower, MIN(tmdb_person_id) AS pid
                  FROM people GROUP BY name_lower) glob
       ON glob.name_lower = LOWER(a.name)`;

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

  // Counting DISTINCT title rather than rows keeps a member who holds the
  // same show on two lists from double-counting its cast.
  const { results: top } = await env.DB.prepare(
    `SELECT
       ${PERSON_KEY} as person_key,
       MIN(a.name) as name,
       MAX(a.imdb_id) as imdb_id,
       COUNT(DISTINCT LOWER(s.title)) as show_count
     FROM actors a
     JOIN shows s ON s.id = a.show_id
     ${PERSON_JOINS}
     WHERE s.member_slug = ?1
       AND s.archived = 0
       AND s.list IN (${LISTS_SQL})
     GROUP BY person_key
     ORDER BY show_count DESC, name COLLATE NOCASE
     LIMIT ${TOP_N}`
  ).bind(session.member_slug).all();

  // The member's own copies behind each count — enough for a client to draw
  // its standard show row and open the show card, not just name the title.
  // One query for the whole page rather than one per actor.
  const byActor = new Map();
  if (top.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT ${PERSON_KEY} as person_key,
              s.id as show_id, s.title, s.network, s.rating, s.poster_url, s.movie
         FROM actors a
         JOIN shows s ON s.id = a.show_id
         ${PERSON_JOINS}
        WHERE s.member_slug = ?1
          AND s.archived = 0
          AND s.list IN (${LISTS_SQL})
          AND ${PERSON_KEY} IN (${top.map(() => '?').join(',')})
        ORDER BY s.title COLLATE NOCASE, s.id`
    ).bind(session.member_slug, ...top.map(a => a.person_key)).all();
    for (const r of rows) {
      let entry = byActor.get(r.person_key);
      if (!entry) { entry = { seen: new Set(), cards: [] }; byActor.set(r.person_key, entry); }
      // One card per distinct title: a copy on two lists is one show, and the
      // ORDER BY makes which copy wins deterministic (the oldest row).
      const t = (r.title || '').toLowerCase();
      if (entry.seen.has(t)) continue;
      entry.seen.add(t);
      entry.cards.push({
        id: r.show_id,
        title: r.title,
        network: r.network || null,
        rating: r.rating || null,
        poster_url: r.poster_url || null,
        movie: r.movie ? 1 : 0,
      });
    }
  }

  // `shows` (bare titles) predates `show_cards` and stays for clients that
  // decode it as [String] — dropping or reshaping it would fail their whole
  // response, not just this field.
  const actors = top.map(a => {
    const cards = byActor.get(a.person_key)?.cards || [];
    return {
      name: a.name,
      imdb_id: a.imdb_id || null,
      tmdb_person_id: typeof a.person_key === 'number' ? a.person_key : null,
      show_count: a.show_count,
      shows: cards.map(c => c.title),
      show_cards: cards,
    };
  });

  return new Response(JSON.stringify({ actors }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

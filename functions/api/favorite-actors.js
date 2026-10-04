import { getSession } from '../_shared/auth.js';
// How many actors the page shows. Nico's framing was "favorite actors and
// their other shows", and a favourite you have to scroll to isn't one.
const TOP_N = 10;

// Below this many rated titles the list still works, but the ratings aren't
// doing much yet — the client offers Rate my backlog alongside the actors.
const RATING_GOAL = 8;

// How much one title says about the people in it. Ratings lead: a show you
// rated highly is the clearest statement of taste the library holds, so it
// outweighs one you merely have on a list, and it counts even once archived.
//
//   rated 10 → 4, 9 → 3, 8 → 2
//   Loved, whatever you rated it → at least 2 (Loved trumps a low rating)
//   Watching / Awaiting, unrated → 1
//   rated 7 or below (not Loved), or archived and not rated 8+ → 0, left out
//
// Next Up never counts — bookmarking a show is not yet a statement about who's
// in it, the same reason Trending excludes it — and is filtered in WHERE.
// Only the overall rating (season 0) is read: one great season shouldn't make
// a favourite of the whole cast.
const WEIGHT = `CASE
       WHEN r.rating >= 8 THEN r.rating - 6
       WHEN s.archived = 0 AND s.list = 'recommending' THEN 2
       WHEN s.archived = 0 AND r.rating IS NULL AND s.list IN ('watching', 'waiting') THEN 1
       ELSE 0
     END`;

const RATING_JOIN = `
     LEFT JOIN show_ratings r
       ON r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
      AND r.season_number = 0 AND r.member_slug = s.member_slug`;

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
                  FROM actors_v a2
                  JOIN shows_v s2 ON s2.id = a2.show_id
                 WHERE s2.member_slug = ?1 AND a2.tmdb_person_id IS NOT NULL
                 GROUP BY LOWER(a2.name)) own
       ON own.name_lower = LOWER(a.name)
     LEFT JOIN (SELECT name_lower, MIN(tmdb_person_id) AS pid
                  FROM people GROUP BY name_lower) glob
       ON glob.name_lower = LOWER(a.name)`;

// Favourite actors, derived rather than picked.
//
// There is no "favourite" flag anywhere and deliberately so: the signal is
// already in the library and in the member's ratings. An actor who keeps
// turning up across the shows you rated highly, loved, or are watching IS a
// favourite, and asking members to curate a second list to say so would just
// decay. Actors rank by the summed WEIGHT of their titles, so a few 10s beat
// a pile of unrated shows.
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

  // One row per (person, title) at that title's best weight: a member holding
  // the same show on two lists, or an archived copy beside a live one, must
  // not double-count its cast. Titles weighing nothing drop out here.
  const { results: top } = await env.DB.prepare(
    `SELECT person_key,
            MIN(name) as name,
            MAX(imdb_id) as imdb_id,
            COUNT(*) as show_count,
            SUM(w) as score
       FROM (SELECT ${PERSON_KEY} as person_key,
                    LOWER(s.title) as title_lower,
                    MIN(a.name) as name,
                    MAX(a.imdb_id) as imdb_id,
                    MAX(${WEIGHT}) as w
               FROM actors_v a
               JOIN shows_v s ON s.id = a.show_id
               ${RATING_JOIN}
               ${PERSON_JOINS}
              WHERE s.member_slug = ?1
                AND s.list != 'next'
              GROUP BY person_key, title_lower
             HAVING w > 0)
      GROUP BY person_key
      ORDER BY score DESC, show_count DESC, name COLLATE NOCASE
      LIMIT ${TOP_N}`
  ).bind(session.member_slug).all();

  // How many titles the member has given an overall rating, counted the way
  // the backlog counts them (off Next Up, one per title).
  const rated = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM (
       SELECT DISTINCT s.tmdb_id, s.tmdb_type
         FROM shows_v s
         JOIN show_ratings r
           ON r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
          AND r.season_number = 0 AND r.member_slug = s.member_slug
        WHERE s.member_slug = ?1 AND s.list != 'next')`
  ).bind(session.member_slug).first();
  const ratedCount = (rated && rated.cnt) || 0;

  // The member's own copies behind each count — enough for a client to draw
  // its standard show row and open the show card, not just name the title.
  // One query for the whole page rather than one per actor.
  const byActor = new Map();
  if (top.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT ${PERSON_KEY} as person_key,
              s.id as show_id, s.title, s.network, s.rating, s.poster_url, s.movie,
              s.archived, r.rating as my_rating, ${WEIGHT} as w
         FROM actors_v a
         JOIN shows_v s ON s.id = a.show_id
         ${RATING_JOIN}
         ${PERSON_JOINS}
        WHERE s.member_slug = ?1
          AND s.list != 'next'
          AND ${WEIGHT} > 0
          AND ${PERSON_KEY} IN (${top.map(() => '?').join(',')})
        ORDER BY s.title COLLATE NOCASE, w DESC, s.archived, s.id`
    ).bind(session.member_slug, ...top.map(a => a.person_key)).all();
    for (const r of rows) {
      let entry = byActor.get(r.person_key);
      if (!entry) { entry = { seen: new Set(), cards: [] }; byActor.set(r.person_key, entry); }
      // One card per distinct title: a copy on two lists is one show, and the
      // ORDER BY makes which copy wins deterministic — the one that earned the
      // title its place, then a live copy over an archived one, then the
      // oldest row.
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
        archived: r.archived ? 1 : 0,
        my_rating: r.my_rating ?? null,
        weight: r.w,
      });
    }
    // Strongest reasons first, so the 10 you gave a show leads its actor.
    for (const entry of byActor.values()) {
      entry.cards.sort((x, y) => y.weight - x.weight
        || x.title.localeCompare(y.title, undefined, { sensitivity: 'base' }));
      for (const c of entry.cards) delete c.weight;
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

  // `rated_count` against `rating_goal` is how a client decides to offer Rate
  // my backlog: the list is always returned, and ratings are what sharpen it.
  return new Response(JSON.stringify({
    actors,
    rated_count: ratedCount,
    rating_goal: RATING_GOAL,
    needs_ratings: ratedCount < RATING_GOAL,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

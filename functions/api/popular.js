import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

export async function onRequestGet(context) {
  const { env } = context;

  // Top shows by how many members added them in the last 30 days — a rolling
  // "what the club is picking up right now" feed. The RANKING uses only recent
  // adds, but the DISPLAY fields (poster, logo, rating, network) are pulled
  // from the best available row for the title regardless of when it was added —
  // otherwise a show trending on brand-new (un-enriched) rows shows no poster
  // even though an older copy on someone's list already has the art.
  const { results } = await env.DB.prepare(
    `SELECT LOWER(s.title) as ltitle, s.title, s.movie,
       MIN(s.id) as id,
       COUNT(DISTINCT s.member_slug) as member_count,
       GROUP_CONCAT(DISTINCT s.member_slug) as member_slugs,
       (SELECT x.poster_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.poster_url IS NOT NULL LIMIT 1) as poster_url,
       (SELECT x.network_logo_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.network_logo_url IS NOT NULL LIMIT 1) as network_logo_url,
       (SELECT x.rating FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.rating IS NOT NULL LIMIT 1) as rating,
       (SELECT x.genres FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.genres IS NOT NULL LIMIT 1) as genres,
       (SELECT x.network FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.network IS NOT NULL LIMIT 1) as network,
       (SELECT x.network_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
          AND x.network_url IS NOT NULL AND x.network_url NOT LIKE '%/search%' AND x.network_url NOT LIKE '%/s?%'
          AND x.network_url NOT LIKE '%?q=%' AND x.network_url NOT LIKE '%?query=%' LIMIT 1) as network_url
     FROM shows s
     WHERE s.archived = 0
       AND s.member_slug NOT IN (${EXCLUDED_SQL})
       -- Seeded rows are the operator's auto-pick, not a member endorsement.
       -- A row "counts" only once a member has actually touched it
       -- (added themselves, or had a list manually loaded by the operator).
       AND COALESCE(s.added_by, '') != 'seed'
       -- Only adds from the last 30 days feed the ranking.
       AND s.created_at >= datetime('now', '-30 days')
     GROUP BY LOWER(s.title)
     ORDER BY member_count DESC, CAST(rating AS REAL) DESC
     LIMIT 10`
  ).all();

  // Pull actors for each (one query per show; n=10 max). Include imdb_id so
  // the front end can render clickable IMDB links — matching the {name, imdb_id}
  // shape the member-page endpoints return. A plain name string would parse to
  // imdb_id:null and render as non-clickable tags.
  for (const show of results) {
    const { results: acts } = await env.DB.prepare(
      'SELECT name, imdb_id FROM actors WHERE show_id = ?'
    ).bind(show.id).all();
    show.actors = acts.length
      ? acts.map(a => ({ name: a.name, imdb_id: a.imdb_id }))
      : null;
  }

  // Map slugs to first names. Members.name is the possessive display
  // name ("Carter's Shows") — splitting on space gave "Carter's", which
  // showed up wrong in the "Watching: ..." line. Use the dedicated
  // first_name column instead, falling back to name's first token only
  // if first_name is missing for some reason.
  const { results: members } = await env.DB.prepare(
    'SELECT slug, name, first_name FROM members'
  ).all();
  const nameMap = {};
  for (const h of members) {
    nameMap[h.slug] = h.first_name || (h.name || '').split(' ')[0];
  }

  // Add member names to each show
  for (const show of results) {
    show.members = (show.member_slugs || '').split(',').map(s => nameMap[s] || s).sort();
    delete show.member_slugs;
  }

  return new Response(JSON.stringify({ shows: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

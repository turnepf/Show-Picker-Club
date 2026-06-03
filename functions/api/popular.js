import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

export async function onRequestGet(context) {
  const { env } = context;

  const { results } = await env.DB.prepare(
    `SELECT LOWER(s.title) as ltitle, s.title, s.rating, s.network, s.network_url, s.movie,
       MAX(s.genres) as genres,
       MIN(s.id) as id,
       COUNT(DISTINCT s.member_slug) as member_count,
       GROUP_CONCAT(DISTINCT s.member_slug) as member_slugs
     FROM shows s
     WHERE s.archived = 0
       AND s.member_slug NOT IN (${EXCLUDED_SQL})
       -- Seeded rows are the operator's auto-pick, not a member endorsement.
       -- A row "counts" only once a member has actually touched it
       -- (added themselves, or had a list manually loaded by the operator).
       AND COALESCE(s.added_by, '') != 'seed'
     GROUP BY LOWER(s.title)
     HAVING COUNT(DISTINCT s.member_slug) >= 2
     ORDER BY member_count DESC, CAST(s.rating AS REAL) DESC
     LIMIT 10`
  ).all();

  // Pull actors for each (one query per show; n=10 max)
  for (const show of results) {
    const { results: acts } = await env.DB.prepare(
      'SELECT name FROM actors WHERE show_id = ?'
    ).bind(show.id).all();
    show.actors = acts.map(a => a.name).join(', ') || null;
  }

  // Get member names to map slugs to first names
  const { results: members } = await env.DB.prepare(
    'SELECT slug, name FROM members'
  ).all();
  const nameMap = {};
  for (const h of members) {
    nameMap[h.slug] = h.name.split(' ')[0];
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

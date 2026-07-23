import { getSession } from '../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

const ELIGIBLE_WHERE = `s.member_slug = ? AND s.list != 'next' AND s.archived = 0 AND s.tmdb_id IS NOT NULL`;

// Backing data for the one-page "rate your backlog" flow
// (public/rate-backlog.html): only shows the member hasn't given an
// overall rating yet (season ratings don't count — this is overall-only
// by design, the page links each title through to its detail screen for
// season-level rating). Once everything's rated, the list is empty and
// the page says so — `has_any` tells it apart from never having had
// anything eligible to rate in the first place.
export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.poster_url, s.movie, s.list, s.seasons_released
     FROM shows s
     WHERE ${ELIGIBLE_WHERE}
       AND NOT EXISTS (
         SELECT 1 FROM show_ratings r
         WHERE r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
           AND r.season_number = 0 AND r.member_slug = s.member_slug
       )
     ORDER BY s.title ASC`
  ).bind(session.member_slug).all();

  const { cnt: eligibleTotal } = (await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM shows s WHERE ${ELIGIBLE_WHERE}`
  ).bind(session.member_slug).first()) || { cnt: 0 };

  return new Response(JSON.stringify({ shows: results, has_any: eligibleTotal > 0 }), { headers: corsHeaders() });
}

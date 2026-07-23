import { getSession } from '../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// Backing data for the one-page "rate your backlog" flow
// (public/rate-backlog.html): every show the member has except Next Up
// (archived included — same scope as the ratings feature generally),
// paired with their existing overall rating if they've already set one.
// Unrated shows sort first so the flow is naturally "knock out what's
// left"; already-rated ones stay reachable further down in case someone
// wants to revise one. Season ratings aren't listed here — this is
// overall-only by design; the page links each title through to its detail
// screen for season-level rating.
export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.poster_url, s.movie, s.list, s.archived, s.seasons_released,
            r.rating AS my_rating
     FROM shows s
     LEFT JOIN show_ratings r
       ON r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
       AND r.season_number = 0 AND r.member_slug = s.member_slug
     WHERE s.member_slug = ? AND s.list != 'next' AND s.tmdb_id IS NOT NULL
     ORDER BY (r.rating IS NULL) DESC, s.title ASC`
  ).bind(session.member_slug).all();

  return new Response(JSON.stringify({ shows: results }), { headers: corsHeaders() });
}

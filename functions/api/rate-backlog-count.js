import { getSession } from '../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// Just the number behind the "Rate my backlog" nav badge — the same set of
// rows /api/rate-backlog returns, counted in SQL instead of shipped. The main
// app derives the badge from the library it already has loaded; every other
// page gets the sidebar from shell.js with no library in hand, and pulling the
// full backlog (posters, titles, season counts) to render one integer is a lot
// of payload for a badge.
//
// Eligibility matches /api/rate-backlog exactly: an active, non-Next-Up show
// with a tmdb_id and no overall rating from this member (season ratings don't
// count). Keep the two in step — a badge that disagrees with the page it
// links to is worse than no badge.
const ELIGIBLE_WHERE = `s.member_slug = ? AND s.list != 'next' AND s.archived = 0 AND s.tmdb_id IS NOT NULL`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt
     FROM shows s
     WHERE ${ELIGIBLE_WHERE}
       AND NOT EXISTS (
         SELECT 1 FROM show_ratings r
         WHERE r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
           AND r.season_number = 0 AND r.member_slug = s.member_slug
       )`
  ).bind(session.member_slug).first();

  return new Response(JSON.stringify({ count: (row && row.cnt) || 0 }), { headers: corsHeaders() });
}

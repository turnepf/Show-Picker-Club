import { getSession } from '../_shared/auth.js';
import { BACKLOG_ELIGIBLE_WHERE, BACKLOG_UNRATED_WHERE } from '../_shared/rate-backlog.js';

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
// Eligibility is /api/rate-backlog's exactly — both read it from
// _shared/rate-backlog.js, so the badge can't disagree with the page it links
// to.

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt
     FROM shows_v s
     WHERE ${BACKLOG_ELIGIBLE_WHERE}
       AND ${BACKLOG_UNRATED_WHERE}`
  ).bind(session.member_slug).first();

  return new Response(JSON.stringify({ count: (row && row.cnt) || 0 }), { headers: corsHeaders() });
}

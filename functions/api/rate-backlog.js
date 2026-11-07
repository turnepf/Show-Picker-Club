import { getSession } from '../_shared/auth.js';
import { BACKLOG_ELIGIBLE_WHERE, BACKLOG_UNRATED_WHERE } from '../_shared/rate-backlog.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// Backing data for the one-page "rate your backlog" flow
// (public/rate-backlog.html and the iOS RateBacklogView): which rows are
// eligible, archived ones included, is _shared/rate-backlog.js. Only shows the member hasn't given an
// overall rating yet (season ratings don't count — this is overall-only
// by design, the page links each title through to its detail screen for
// season-level rating). Once everything's rated, the list is empty and
// the page says so — `has_any` tells it apart from never having had
// anything eligible to rate in the first place.
//
// `?include_rated=1` is the page's "Show rated shows" checkbox: every
// eligible row, rated or not, each carrying `my_rating` (the member's overall
// rating, null when unrated) so a rated row draws its score and can be
// re-rated in place. Additive — without it the response is the unrated-only
// list it always was, so builds that predate the checkbox are untouched.
// The nav badge (rate-backlog-count) still counts unrated only.
export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const includeRated = new URL(request.url).searchParams.get('include_rated') === '1';
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.poster_url, s.movie, s.list, s.seasons_released, s.archived,
            (SELECT r.rating FROM show_ratings r
              WHERE r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
                AND r.season_number = 0 AND r.member_slug = s.member_slug) AS my_rating
     FROM shows_v s
     WHERE ${BACKLOG_ELIGIBLE_WHERE}
       ${includeRated ? '' : `AND ${BACKLOG_UNRATED_WHERE}`}
     ORDER BY s.title ASC`
  ).bind(session.member_slug).all();

  const { cnt: eligibleTotal } = (await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM shows_v s WHERE ${BACKLOG_ELIGIBLE_WHERE}`
  ).bind(session.member_slug).first()) || { cnt: 0 };

  return new Response(JSON.stringify({ shows: results, has_any: eligibleTotal > 0 }), { headers: corsHeaders() });
}

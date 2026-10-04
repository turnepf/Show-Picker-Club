import { getSession } from '../../../_shared/auth.js';
import { isValidRating, upsertRating, getRatingsSummary, OVERALL_SEASON } from '../../../_shared/ratings.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// Rate your own copy of a show — overall (default) or a specific season.
// Instant-save from the client (no separate confirm step), so this both
// writes the rating and returns the freshly recomputed summary in one
// round trip.
export async function onRequestPut(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const show = await env.DB.prepare(
    'SELECT member_slug, list, tmdb_id, tmdb_type FROM shows_v WHERE id = ?'
  ).bind(params.id).first();
  if (!show) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }
  if (show.member_slug !== session.member_slug) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }
  // Next Up = not watched yet — only ever shows the club average, no entry.
  if (show.list === 'next') {
    return new Response(JSON.stringify({ error: 'not_watched' }), { status: 409, headers: corsHeaders() });
  }
  if (!show.tmdb_id || !show.tmdb_type) {
    return new Response(JSON.stringify({ error: 'not_enriched' }), { status: 409, headers: corsHeaders() });
  }

  const body = await request.json().catch(() => ({}));
  const rating = parseInt(body.rating, 10);
  if (!isValidRating(rating)) {
    return new Response(JSON.stringify({ error: 'rating must be an integer 1-10' }), { status: 400, headers: corsHeaders() });
  }
  const seasonNumber = (body.season === undefined || body.season === null)
    ? OVERALL_SEASON
    : parseInt(body.season, 10);
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
    return new Response(JSON.stringify({ error: 'invalid season' }), { status: 400, headers: corsHeaders() });
  }

  await upsertRating(env, {
    tmdbId: show.tmdb_id,
    tmdbType: show.tmdb_type,
    seasonNumber,
    memberSlug: session.member_slug,
    rating,
  });

  const ratings = await getRatingsSummary(env, {
    tmdbId: show.tmdb_id,
    tmdbType: show.tmdb_type,
    viewerSlug: session.member_slug,
    ownerSlug: show.member_slug,
  });

  return new Response(JSON.stringify({ ok: true, ratings }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

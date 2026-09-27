import { fetchEnrichment, fetchEnrichmentById } from '../../_shared/enrichment.js';
import { getSession } from '../../_shared/auth.js';
import { chargeSpend } from '../../_shared/spend-meter.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Session required (added 2026-08). This returns no member data, which is
  // why it went unguarded for so long — but it proxies TMDB and OMDB, so an
  // anonymous caller spends our upstream quota, unthrottled, for free. Every
  // caller that needs it is adding a show, which needs a session anyway. The
  // only client that ever called it without one was the web member app, and
  // that was archived in the 2026-08 teardown.
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  // A session is an identity, not a spend bound: signup is open, so one
  // account could otherwise drive this proxy forever. The web caller treats
  // any non-200 as "no suggestion" and the form still works.
  if (!(await chargeSpend(env, session.member_slug, 'lookups'))) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: corsHeaders() });
  }

  try {
    const body = await request.json();
    const { title, movie, tmdb_id, tmdb_type } = body;

    if (!title || !title.trim()) {
      return new Response(JSON.stringify({ error: 'Title is required' }), { status: 400, headers: corsHeaders() });
    }

    let enriched = null;

    // If client sent exact TMDB id, use that directly
    const tmdbId = parseInt(tmdb_id, 10);
    if (Number.isInteger(tmdbId) && (tmdb_type === 'movie' || tmdb_type === 'tv')) {
      const byId = await fetchEnrichmentById(tmdbId, tmdb_type, env);
      if (byId.canonicalTitle) enriched = byId;
    }

    // Fall back to title search
    if (!enriched) {
      enriched = await fetchEnrichment(title, env, !!movie);
    }

    return new Response(JSON.stringify({
      canonicalTitle: enriched.canonicalTitle,
      suggestedNetwork: enriched.providerNetwork,
      rating: enriched.rating,
      posterUrl: enriched.posterUrl,
      networkLogoUrl: enriched.networkLogoUrl,
      overview: enriched.overview,
      tmdbId: enriched.tmdbId,
      tmdbType: enriched.tmdbType,
      releaseYear: enriched.releaseYear,
    }), { headers: corsHeaders() });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to suggest network', details: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

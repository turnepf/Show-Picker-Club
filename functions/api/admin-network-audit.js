import { getSession } from '../_shared/auth.js';
import { isAdmin } from '../_shared/admin.js';
import { fetchEnrichment, searchTmdbId } from '../_shared/enrichment.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);

  if (!session || !await isAdmin(env, session.member_slug)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json().catch(() => ({}));
  const limit = Math.min(parseInt(body.limit ?? '100', 10), 500);

  try {
    // Get active shows that haven't been audited recently
    const { results: shows } = await env.DB.prepare(`
      SELECT DISTINCT
        LOWER(title) as title_lower,
        MAX(title) as title,
        MAX(movie) as movie,
        MAX(network) as stored_network,
        COUNT(*) as copies,
        MAX(COALESCE(enriched_at, created_at)) as last_checked
      FROM shows
      WHERE archived = 0
      GROUP BY LOWER(title)
      ORDER BY last_checked ASC
      LIMIT ?
    `).bind(limit).all();

    const mismatches = [];
    const matched = [];
    const notFound = [];

    for (const show of shows) {
      try {
        // Look up on TMDB
        const result = await searchTmdbId(show.title, env, !!show.movie);

        if (!result.tmdbId) {
          notFound.push({
            title: show.title,
            storedNetwork: show.stored_network,
            copies: show.copies,
            reason: result.reason || 'no_results',
          });
          continue;
        }

        // Get enrichment to see suggested network
        const enriched = await fetchEnrichment(show.title, env, !!show.movie);

        if (!enriched.canonicalTitle) {
          notFound.push({
            title: show.title,
            storedNetwork: show.stored_network,
            copies: show.copies,
            reason: 'enrichment_failed',
          });
          continue;
        }

        const suggestedNetwork = enriched.providerNetwork;

        // Compare
        const storedNorm = (show.stored_network || '').toLowerCase();
        const suggestedNorm = (suggestedNetwork || '').toLowerCase();

        if (storedNorm !== suggestedNorm) {
          mismatches.push({
            title: show.title,
            storedNetwork: show.stored_network,
            suggestedNetwork: suggestedNetwork,
            copies: show.copies,
            tmdbId: enriched.tmdbId,
            tmdbType: enriched.tmdbType,
          });
        } else {
          matched.push({
            title: show.title,
            network: show.stored_network,
            copies: show.copies,
          });
        }
      } catch (e) {
        notFound.push({
          title: show.title,
          storedNetwork: show.stored_network,
          copies: show.copies,
          reason: `error: ${e.message}`,
        });
      }
    }

    return new Response(JSON.stringify({
      audited: shows.length,
      matched: matched.length,
      mismatches: mismatches.length,
      notFound: notFound.length,
      results: {
        mismatches: mismatches.sort((a, b) => b.copies - a.copies),
        notFound: notFound.sort((a, b) => b.copies - a.copies).slice(0, 20),
      },
    }), { headers: corsHeaders() });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Audit failed', details: e.message }), { status: 500, headers: corsHeaders() });
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

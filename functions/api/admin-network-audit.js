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

  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit ?? '100', 10), 500);

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
    let processed = 0;
    let errors = 0;

    for (const show of shows) {
      try {
        processed++;

        // Look up on TMDB
        let result;
        try {
          result = await searchTmdbId(show.title, env, !!show.movie);
        } catch (e) {
          notFound.push({
            title: show.title,
            storedNetwork: show.stored_network,
            copies: show.copies,
            reason: `search_error: ${e.message}`,
          });
          continue;
        }

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
        let enriched;
        try {
          enriched = await fetchEnrichment(show.title, env, !!show.movie);
        } catch (e) {
          notFound.push({
            title: show.title,
            storedNetwork: show.stored_network,
            copies: show.copies,
            reason: `enrichment_error: ${e.message}`,
          });
          continue;
        }

        if (!enriched.canonicalTitle) {
          notFound.push({
            title: show.title,
            storedNetwork: show.stored_network,
            copies: show.copies,
            reason: 'enrichment_no_title',
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
        errors++;
        notFound.push({
          title: show.title,
          storedNetwork: show.stored_network,
          copies: show.copies,
          reason: `unexpected_error: ${e.message}`,
        });
      }
    }

    return new Response(JSON.stringify({
      audited: shows.length,
      processed,
      errors,
      matched: matched.length,
      mismatches: mismatches.length,
      notFound: notFound.length,
      results: {
        mismatches: mismatches.sort((a, b) => b.copies - a.copies),
        notFound: notFound.sort((a, b) => b.copies - a.copies).slice(0, 20),
      },
    }), { headers: corsHeaders() });
  } catch (e) {
    console.error('Audit error:', e.message, e.stack);
    return new Response(JSON.stringify({
      error: 'Audit failed',
      details: e.message,
      stack: e.stack
    }), { status: 500, headers: corsHeaders() });
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

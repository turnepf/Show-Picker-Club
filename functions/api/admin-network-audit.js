import { getSession } from '../_shared/auth.js';
import { isAdmin } from '../_shared/admin.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const isAdminUser = await isAdmin(request, env);
  if (!isAdminUser) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit ?? '100', 10), 500);

    // Get all active shows, grouped by title, with network info
    const { results: shows } = await env.DB.prepare(`
      SELECT DISTINCT
        LOWER(title) as title_lower,
        MAX(title) as title,
        MAX(movie) as movie,
        MAX(network) as stored_network,
        COUNT(*) as copies,
        COUNT(CASE WHEN network IS NOT NULL THEN 1 END) as network_count,
        MAX(COALESCE(enriched_at, created_at)) as last_checked
      FROM shows
      WHERE archived = 0
      GROUP BY LOWER(title)
      ORDER BY network_count ASC, last_checked ASC
      LIMIT ?
    `).bind(limit).all();

    const withoutNetwork = [];
    const withNetwork = [];

    for (const show of shows) {
      if (!show.stored_network) {
        withoutNetwork.push({
          title: show.title,
          movie: show.movie ? 'movie' : 'show',
          copies: show.copies,
          lastChecked: show.last_checked,
        });
      } else {
        withNetwork.push({
          title: show.title,
          network: show.stored_network,
          copies: show.copies,
          movie: show.movie ? 'movie' : 'show',
        });
      }
    }

    return new Response(JSON.stringify({
      total: shows.length,
      withNetwork: withNetwork.length,
      withoutNetwork: withoutNetwork.length,
      results: {
        missing: withoutNetwork.sort((a, b) => b.copies - a.copies),
        sample: withNetwork.sort((a, b) => b.copies - a.copies).slice(0, 20),
      },
    }), { headers: corsHeaders() });
  } catch (e) {
    console.error('Audit error:', e.message, e.stack);
    return new Response(JSON.stringify({
      error: 'Audit failed',
      details: e.message,
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

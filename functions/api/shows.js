import { fetchEnrichment } from '../_shared/enrichment.js';
import { getSession } from '../_shared/auth.js';

const NETWORK_SEARCH = {
  'Netflix': { base: 'https://www.netflix.com/search' },
  'HBO': { base: 'https://play.max.com/search', param: 'q' },
  'Apple TV': { base: 'https://tv.apple.com/search', param: 'term' },
  'Hulu': { base: 'https://www.hulu.com/search' },
  'Paramount': { base: 'https://www.paramountplus.com/search' },
  'Peacock': { base: 'https://www.peacocktv.com/watch/search' },
  'Amazon': { base: 'https://www.amazon.com/s', param: 'k', extra: 'i=instant-video' },
  'Bravo': { base: 'https://www.peacocktv.com/watch/search' },
  'Disney+': { base: 'https://www.disneyplus.com/browse/search' },
  'NBC': { base: 'https://www.nbc.com/search' },
  'Starz': { base: 'https://www.starz.com/search', param: 'q' },
  'Showtime': { base: 'https://www.sho.com/search', param: 'q' },
};

function generateNetworkUrl(network, title) {
  if (!network) return null;
  const cfg = NETWORK_SEARCH[network];
  if (!cfg) return null;
  if (!cfg.param) return cfg.base;
  const params = new URLSearchParams();
  if (cfg.extra) cfg.extra.split('&').forEach(p => { const [k,v] = p.split('='); params.set(k,v); });
  params.set(cfg.param, title);
  return cfg.base + '?' + params.toString();
}

function cleanUrl(url) {
  if (!url) return url;
  url = url.split('?')[0];
  if (url.includes('amazon.com/')) url = url.split('ref=')[0];
  return url.replace(/\/+$/, '/');
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const member = url.searchParams.get('member');
  if (!member) {
    return new Response(JSON.stringify({ error: 'member required' }), { status: 400, headers: corsHeaders() });
  }
  // ?include_archived=1 — search popup needs archived rows too. Default keeps the existing behaviour (active only).
  const includeArchived = url.searchParams.get('include_archived') === '1';
  const archivedFilter = includeArchived ? '' : 'AND s.archived = 0';
  const { results } = await env.DB.prepare(
    `SELECT s.*,
       (SELECT json_group_array(json_object('name', a.name, 'imdb_id', a.imdb_id)) FROM actors a WHERE a.show_id = s.id) as actors
     FROM shows s WHERE s.member_slug = ? ${archivedFilter} ORDER BY s.title COLLATE NOCASE`
  ).bind(member).all();
  return new Response(JSON.stringify({ shows: results }), { headers: corsHeaders() });
}

async function findGoodCopyAcrossMembers(env, title) {
  // Returns the first (any-member) active row for this title that has a real
  // network + deep-link URL (not a search-page placeholder). Used to inherit
  // network/URL on insert so new shows don't land in the URL-cleanup queue.
  return await env.DB.prepare(
    `SELECT network, network_url FROM shows
     WHERE LOWER(title) = LOWER(?) AND archived = 0
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
       AND network_url NOT LIKE '%?q=%'
       AND network_url NOT LIKE '%?query=%'
     LIMIT 1`
  ).bind(title).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { title, network, recommended_by, list, notes, network_url, movie, full_series, watching_with } = body;
  if (!title || !list) {
    return new Response(JSON.stringify({ error: 'Title and list are required' }), { status: 400, headers: corsHeaders() });
  }

  const omdb = await fetchEnrichment(title, env, !!movie);
  const finalTitle = omdb.canonicalTitle || title;

  const existing = await env.DB.prepare(
    'SELECT id, list, archived FROM shows WHERE LOWER(title) = LOWER(?) AND member_slug = ?'
  ).bind(finalTitle, session.member_slug).first();
  if (existing) {
    if (existing.archived) {
      return new Response(JSON.stringify({ error: 'exists_archived', id: existing.id, title: finalTitle }), { status: 409, headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ error: 'exists_active', list: existing.list, title: finalTitle }), { status: 409, headers: corsHeaders() });
  }

  // If another member already has a good (non-placeholder) URL for this title,
  // inherit it. Beats the search-page fallback and keeps the title out of the
  // URL-cleanup queue.
  const goodCopy = network_url && network ? null : await findGoodCopyAcrossMembers(env, finalTitle);
  const finalNetwork = network || (goodCopy && goodCopy.network) || null;
  const finalUrl =
    cleanUrl(network_url) ||
    (goodCopy && goodCopy.network_url) ||
    generateNetworkUrl(finalNetwork, finalTitle);

  const result = await env.DB.prepare(
    'INSERT INTO shows (title, network, network_url, recommended_by, rating, list, notes, movie, full_series, watching_with, member_slug, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(finalTitle, finalNetwork, finalUrl, recommended_by || null, omdb.rating, list, notes || null, movie || 0, full_series || 0, watching_with || null, session.member_slug, session.email).run();

  const showId = result.meta.last_row_id;
  if (omdb.actors.length > 0) {
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id) VALUES (?, ?, ?)');
    await env.DB.batch(omdb.actors.map(a => stmt.bind(showId, a.name, a.imdb_id || null)));
  }

  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(showId).first();
  return new Response(JSON.stringify({ show }), { status: 201, headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

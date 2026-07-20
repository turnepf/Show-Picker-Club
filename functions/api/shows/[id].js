import { fetchEnrichment, fetchEnrichmentById } from '../../_shared/enrichment.js';
import { getSession } from '../../_shared/auth.js';
import { canonicalNetwork, networkFromUrl } from '../../_shared/networks.js';
import { lookupWatchmodeUrl } from '../../_shared/watch-providers.js';
import { safeNetworkUrl } from '../../_shared/url-utils.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}



// Fields safe to show a logged-out visitor (the Trending detail screen):
// catalog facts about the show itself. Everything personal — notes,
// recommended_by, watching_with, whose list it's on — needs a session.
const PUBLIC_SHOW_FIELDS = [
  'id', 'title', 'network', 'network_url', 'rating', 'movie', 'full_series',
  'genres', 'poster_url', 'network_logo_url', 'seasons_released',
  'next_season_date', 'season_end_date',
  // Catalog-level detail fields — facts about the show itself, safe for the
  // logged-out Trending detail screen.
  'overview', 'backdrop_url', 'tmdb_rating', 'content_rating', 'trailer_key',
  'director', 'runtime', 'release_year', 'watch_link',
];

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  if (!show) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }
  const session = await getSession(request, env);
  // Full row (notes, watching_with, recommended_by, added_by) is for the
  // show's owner only. Other members get catalog fields plus enough context
  // to say "on Watching · <member>"; logged-out visitors get catalog only.
  if (session && session.member_slug === show.member_slug) {
    return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
  }
  const redacted = {};
  for (const k of PUBLIC_SHOW_FIELDS) if (k in show) redacted[k] = show[k];
  if (session) {
    redacted.list = show.list;
    redacted.member_slug = show.member_slug;
  }
  return new Response(JSON.stringify({ show: redacted }), { headers: corsHeaders() });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const existing = await env.DB.prepare('SELECT * FROM shows WHERE id = ? AND member_slug = ?').bind(params.id, session.member_slug).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }

  const body = await request.json();
  // network_url is rendered into an href on the public site — only http(s).
  if (body.network_url !== undefined && body.network_url && !safeNetworkUrl(body.network_url)) {
    return new Response(JSON.stringify({ error: 'invalid network_url' }), { status: 400, headers: corsHeaders() });
  }
  const val = (key) => body[key] !== undefined ? body[key] : existing[key];
  const title = val('title');
  const network_url = body.network_url !== undefined ? body.network_url : existing.network_url;
  // URL trumps the dropdown — if the pasted URL's domain says Netflix, the
  // stored network is Netflix regardless of what the dropdown said. Falls
  // through to alias-folding the dropdown pick when the URL doesn't tell
  // us anything.
  const network = networkFromUrl(network_url) || canonicalNetwork(val('network')) || null;
  const recommended_by = val('recommended_by');
  const list = val('list');
  const notes = val('notes');
  const movie = val('movie');
  const full_series = val('full_series');
  const watching_with = val('watching_with');
  const archived = val('archived');

  // Exact pick from type-ahead search (edit flow): enrich the chosen TMDB
  // entry directly; fall back to the title search when absent or failed.
  const tmdbId = parseInt(body.tmdb_id, 10);
  const tmdbType = body.tmdb_type === 'movie' || body.tmdb_type === 'tv' ? body.tmdb_type : null;
  let enriched = null;
  if (Number.isInteger(tmdbId) && tmdbType) {
    const byId = await fetchEnrichmentById(tmdbId, tmdbType, env);
    if (byId.canonicalTitle) enriched = byId;
  }
  if (!enriched) enriched = await fetchEnrichment(title, env, !!movie);
  const rating = enriched.rating || existing.rating;

  const finalNetwork = network || enriched.providerNetwork || null;
  await env.DB.prepare(
    `UPDATE shows SET title = ?, network = ?, network_url = ?, recommended_by = ?, list = ?, notes = ?, movie = ?, full_series = ?, watching_with = ?, rating = ?, archived = ?,
        poster_url = COALESCE(?, poster_url), network_logo_url = COALESCE(?, network_logo_url),
        overview = COALESCE(?, overview), backdrop_url = COALESCE(?, backdrop_url),
        tmdb_rating = COALESCE(?, tmdb_rating), content_rating = COALESCE(?, content_rating),
        trailer_key = COALESCE(?, trailer_key), director = COALESCE(?, director),
        runtime = COALESCE(?, runtime), release_year = COALESCE(?, release_year),
        watch_link = COALESCE(?, watch_link),
        updated_at = datetime('now') WHERE id = ?`
  ).bind(title, finalNetwork, network_url, recommended_by, list, notes, movie, full_series, watching_with, rating, archived,
    enriched.posterUrl || null, enriched.networkLogoUrl || null,
    enriched.overview || null, enriched.backdropUrl || null, enriched.tmdbRating || null, enriched.contentRating || null,
    enriched.trailerKey || null, enriched.director || null, enriched.runtime || null, enriched.releaseYear || null,
    enriched.watchLink || null, params.id).run();

  if (enriched.actors.length > 0) {
    await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(params.id).run();
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id) VALUES (?, ?, ?)');
    await env.DB.batch(enriched.actors.map(a => stmt.bind(params.id, a.name, a.imdb_id || null)));
  }

  // If the network changed (or we landed on a placeholder URL), kick off
  // a Watchmode lookup in the background to keep the row on a real
  // deep link. Propagates to all members' same-titled active rows.
  const networkChanged = (finalNetwork || null) !== (existing.network || null);
  const onPlaceholder = !network_url ||
    network_url.includes('/search') || network_url.includes('/s?') ||
    network_url.includes('?q=') || network_url.includes('?query=');
  if (finalNetwork && (networkChanged || onPlaceholder)) {
    context.waitUntil((async () => {
      const realUrl = await lookupWatchmodeUrl(env, title, finalNetwork, !!movie);
      if (realUrl) {
        await env.DB.prepare(
          "UPDATE shows SET network_url = ?, enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND archived = 0"
        ).bind(realUrl, title).run();
      }
    })());
  }

  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  await env.DB.prepare('DELETE FROM shows WHERE id = ? AND member_slug = ?').bind(params.id, session.member_slug).run();
  return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

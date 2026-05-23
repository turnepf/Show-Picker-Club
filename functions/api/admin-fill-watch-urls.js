import { canonicalNetwork } from '../_shared/networks.js';

// Backfills network_url for rows missing a real deep link, using TMDB's
// /watch/providers endpoint (powered by JustWatch). For each candidate row:
//   1. Search TMDB for the title (tv first, then movie if marked movie).
//   2. Hit /watch/providers for that TMDB id.
//   3. Pull the JustWatch `link` URL for the US region IF the row's network
//      appears in the flatrate list.
//
// The JustWatch URL is an aggregation page (not a direct play.hbomax.com
// deep link) but a single tap on the service logo there opens the right
// show in the streaming app. Two hops, but reliable.
//
// Admin-secret gated. Idempotent — skips rows that already have a non-
// placeholder URL. Safe to re-run.
//
// Example:
//   curl -X POST https://showpicker.club/api/admin-fill-watch-urls \
//     -H 'Content-Type: application/json' \
//     -d '{"secret":"...","network":"HBO Max","limit":10}'

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function looksLikePlaceholder(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return u.includes('/search') || u.includes('/s?') ||
         u.includes('?q=') || u.includes('?query=');
}

// Some streamers know themselves as different things on different services
// (HBO Max vs Max vs HBO). Our canonical fold handles that — match on the
// canonical, not the literal name.
function providerMatchesNetwork(providerName, targetNetwork) {
  if (!providerName || !targetNetwork) return false;
  return canonicalNetwork(providerName) === targetNetwork;
}

async function tmdbSearch(env, title, isMovie) {
  const key = env.TMDB_API_KEY;
  if (!key) return null;
  const endpoint = isMovie ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(title)}&api_key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function tmdbWatchProviders(env, tmdbId, isMovie) {
  const key = env.TMDB_API_KEY;
  if (!key) return null;
  const endpoint = isMovie ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/watch/providers?api_key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.US || null;
  } catch {
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ADMIN_SECRET) return json({ error: 'ADMIN_SECRET not configured' }, 500);
  if (!env.TMDB_API_KEY) return json({ error: 'TMDB_API_KEY not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (body.secret !== env.ADMIN_SECRET) return json({ error: 'Invalid secret' }, 401);

  const network = (body.network || '').trim() || null;
  const limit = Math.max(1, Math.min(100, parseInt(body.limit, 10) || 25));

  // Candidates: rows missing a usable URL. If `network` is provided, scope to it.
  const sql = `
    SELECT id, title, network, network_url, movie
    FROM shows
    WHERE archived = 0
      ${network ? 'AND network = ?' : ''}
      AND (network_url IS NULL
           OR network_url LIKE '%/search%'
           OR network_url LIKE '%/s?%'
           OR network_url LIKE '%?q=%'
           OR network_url LIKE '%?query=%'
           OR network_url LIKE 'https://www.max.com/%'
           OR network_url LIKE 'https://www.hbomax.com/%')
    -- Dedup by title so we only do one TMDB lookup per show, then push the
    -- result to every member's copy via the canonical UPDATE below.
    GROUP BY LOWER(title)
    LIMIT ${limit}
  `;
  const { results } = await (network
    ? env.DB.prepare(sql).bind(network).all()
    : env.DB.prepare(sql).all());

  const summary = { checked: results.length, filled: 0, no_tmdb_hit: [], no_provider_match: [], updated: [] };

  for (const row of results) {
    const isMovie = !!row.movie;
    const tmdbId = await tmdbSearch(env, row.title, isMovie);
    if (!tmdbId) { summary.no_tmdb_hit.push(row.title); continue; }

    const providers = await tmdbWatchProviders(env, tmdbId, isMovie);
    if (!providers || !providers.link) { summary.no_provider_match.push(row.title); continue; }

    const flatrate = providers.flatrate || [];
    const hasNetwork = flatrate.some(p => providerMatchesNetwork(p.provider_name, row.network));
    if (!hasNetwork) { summary.no_provider_match.push(row.title); continue; }

    // Apply to every active row sharing this title — keeps the club in sync.
    const upd = await env.DB.prepare(
      "UPDATE shows SET network_url = ?, enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND archived = 0"
    ).bind(providers.link, row.title).run();

    summary.filled += upd.meta.changes;
    summary.updated.push({ title: row.title, url: providers.link, rows_updated: upd.meta.changes });
  }

  return json(summary);
}

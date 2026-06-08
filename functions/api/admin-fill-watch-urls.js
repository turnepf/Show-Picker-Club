import { canonicalNetwork } from '../_shared/networks.js';
import { isAdmin } from '../_shared/admin.js';

// Backfills network_url for rows missing a real deep link, using Watchmode's
// /title/{id}/sources endpoint. For each candidate row:
//   1. Search Watchmode for the title (filtered by tv vs movie).
//   2. Fetch sources for the resulting title id.
//   3. Among US subscription/free sources, find one whose service name maps
//      to the row's stored network (via canonicalNetwork()).
//   4. Save that source's web_url — a real deep link straight to the show
//      on the streaming service.
//
// Admin-secret gated. Idempotent — skips rows that already have a non-
// placeholder URL. Each successful lookup updates every member's same-
// titled active row so the URL propagates immediately.
//
// Watchmode free tier: 1000 requests/month. Each candidate uses ~2 calls
// (search + sources). Use the `limit` body field to keep test runs small.
//
// Gated by the operator's session — pass the session cookie (grab it from
// the browser: DevTools > Application > Cookies > session).
// Example:
//   curl -X POST https://showpicker.club/api/admin-fill-watch-urls \
//     -H 'Content-Type: application/json' \
//     -H 'Cookie: session=YOUR_SESSION_ID' \
//     -d '{"network":"HBO Max","limit":5}'

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Authorise either an operator session OR a CRON_SECRET header — the scheduled
// GitHub Action (watch-urls-fill.yml) uses the latter so the deep-link backfill
// drains on its own without anyone logged in. Mirrors admin-vibe-fill.js.
async function authorized(request, env) {
  if (await isAdmin(request, env)) return true;
  const provided = request.headers.get('X-Cron-Secret');
  return !!env.CRON_SECRET && provided === env.CRON_SECRET;
}

// Auth uses the X-API-Key header (Watchmode's recommended scheme for new
// integrations) rather than an apiKey query param. Region defaults to US but
// is configurable via WATCHMODE_REGION — see watchmodeRegion() below.
function watchmodeHeaders(env) {
  return { 'X-API-Key': env.WATCHMODE_API_KEY };
}

function watchmodeRegion(env) {
  return env.WATCHMODE_REGION || 'US';
}

async function watchmodeSearch(env, title, isMovie) {
  if (!env.WATCHMODE_API_KEY) return null;
  const types = isMovie ? 'movie' : 'tv_series,tv_miniseries';
  const url = `https://api.watchmode.com/v1/search/?search_field=name&search_value=${encodeURIComponent(title)}&types=${types}`;
  try {
    const res = await fetch(url, { headers: watchmodeHeaders(env) });
    if (!res.ok) return { error: `search ${res.status}` };
    const data = await res.json();
    const hit = data.title_results?.[0];
    return hit?.id || null;
  } catch (e) {
    return { error: 'search fetch failed: ' + e.message };
  }
}

async function watchmodeSources(env, titleId) {
  if (!env.WATCHMODE_API_KEY) return null;
  const url = `https://api.watchmode.com/v1/title/${titleId}/sources/?regions=${encodeURIComponent(watchmodeRegion(env))}`;
  try {
    const res = await fetch(url, { headers: watchmodeHeaders(env) });
    if (!res.ok) return { error: `sources ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: 'sources fetch failed: ' + e.message };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await authorized(request, env))) return json({ error: 'Forbidden — log in as the operator' }, 403);
  if (!env.WATCHMODE_API_KEY) return json({ error: 'WATCHMODE_API_KEY not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const network = (body.network || '').trim() || null;
  // Per-run cap raised to 250 (was 100): Watchmode's faster List Titles /
  // sources endpoints + higher request-volume infra let a manual backlog
  // drain process more titles in one run without tripping the job timeout.
  // The monthly quota (~1000 free-tier calls, ~2 per title) is still the
  // real ceiling — keep ad-hoc runs in mind when draining.
  const limit = Math.max(1, Math.min(250, parseInt(body.limit, 10) || 25));
  const region = watchmodeRegion(env);

  // Candidates: rows without a true deep-link URL. Includes NULL, search
  // placeholders, www.max.com / www.hbomax.com info-page URLs that dump
  // users at the home screen, and themoviedb.org watch pages left over
  // from the earlier TMDB-based version of this endpoint.
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
           OR network_url LIKE 'https://www.hbomax.com/%'
           OR network_url LIKE 'https://play.hbomax.com/video/watch/%'
           OR network_url LIKE 'https://www.themoviedb.org/%'
           OR network_url = 'https://www.amazon.com/s'
           OR network_url = 'https://www.amazon.com/s/')
      -- Our intentional HBO Max search fallback — Watchmode only ever
      -- returns auto-play URLs for these, so the search page is the
      -- best we can do. Don't re-queue them every cleanup pass.
      -- Two shapes accepted: the auto-generated /search? URL and the
      -- operator-pasted /search/result? URL.
      AND network_url NOT LIKE 'https://play.hbomax.com/search?%'
      AND network_url NOT LIKE 'https://play.hbomax.com/search/result?%'
    -- Dedup by title — one lookup per show, push the result to every
    -- member's same-titled row via the UPDATE below.
    GROUP BY LOWER(title)
    LIMIT ${limit}
  `;
  const { results } = await (network
    ? env.DB.prepare(sql).bind(network).all()
    : env.DB.prepare(sql).all());

  const summary = {
    checked: results.length,
    filled: 0,
    no_match: [],          // Watchmode couldn't find the title at all
    no_provider_match: [], // Watchmode found it but row's network isn't a source for it
    updated: [],
    errors: [],
  };

  for (const row of results) {
    const isMovie = !!row.movie;

    const searchResult = await watchmodeSearch(env, row.title, isMovie);
    if (searchResult && typeof searchResult === 'object' && searchResult.error) {
      summary.errors.push({ title: row.title, error: searchResult.error });
      continue;
    }
    const titleId = searchResult;
    if (!titleId) { summary.no_match.push(row.title); continue; }

    const sourcesResult = await watchmodeSources(env, titleId);
    if (sourcesResult && typeof sourcesResult === 'object' && sourcesResult.error) {
      summary.errors.push({ title: row.title, error: sourcesResult.error });
      continue;
    }
    const sources = Array.isArray(sourcesResult) ? sourcesResult : [];

    // Subscription / free streams only — not rent or buy. Same region filter
    // as the API call (defense in depth).
    const subs = sources.filter(s =>
      s.region === region && (s.type === 'sub' || s.type === 'free')
    );

    const match = subs.find(s =>
      canonicalNetwork(s.name) === row.network && s.web_url
    );
    if (!match) { summary.no_provider_match.push(row.title); continue; }

    // HBO Max's Watchmode entries frequently come back as
    // play.hbomax.com/video/watch/<uuid>?utm_source=universal_search —
    // an episode-deep-link that *auto-plays*. We can't transform that
    // into the show-page UUID (different resource), so we degrade
    // gracefully to a title search on HBO Max instead. The user lands
    // on a search results page with their title pre-filled, one tap
    // from the right show, and crucially never starts playback.
    let url = match.web_url;
    if (/^https?:\/\/play\.hbomax\.com\/video\/watch\//i.test(url)) {
      url = `https://play.hbomax.com/search?q=${encodeURIComponent(row.title)}`;
    }

    // Only write to rows on the same service. The Watchmode match we
    // picked is scoped to row.network already (canonicalNetwork(s.name) ===
    // row.network), so blasting it across every same-titled row would
    // misroute members whose row carries a different network for the
    // same title (e.g. All Her Fault on Peacock vs Amazon).
    const upd = await env.DB.prepare(
      "UPDATE shows SET network_url = ?, enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND network = ? AND archived = 0"
    ).bind(url, row.title, row.network).run();

    summary.filled += upd.meta.changes;
    summary.updated.push({
      title: row.title,
      source: match.name,
      url,
      rows_updated: upd.meta.changes,
    });
  }

  return json(summary);
}

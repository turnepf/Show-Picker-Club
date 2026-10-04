import { fetchEnrichment, fetchEnrichmentById, fallbackNetwork } from '../_shared/enrichment.js';
import { syncTitle } from '../_shared/titles.js';
import { getSession } from '../_shared/auth.js';
import { canonicalNetwork, networkFromUrl, networkSearchUrl } from '../_shared/networks.js';
import { lookupWatchmodeUrl } from '../_shared/watch-providers.js';
import { safeNetworkUrl } from '../_shared/url-utils.js';
import { chargeSpend } from '../_shared/spend-meter.js';
import { syncWatchers, watchersForShows, attachAddedByMembers } from '../_shared/watchers.js';


function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  // Member lists (including per-show notes) are club-internal — any logged-in
  // member can read any list, but logged-out visitors only get the public
  // surface (/api/members, /api/popular).
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
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
       (SELECT json_group_array(json_object('name', a.name, 'imdb_id', a.imdb_id)) FROM actors a WHERE a.show_id = s.id) as actors,
       sr.rating as user_rating
     FROM shows s
     LEFT JOIN show_ratings sr ON s.tmdb_id = sr.tmdb_id AND s.member_slug = sr.member_slug AND sr.season_number = 0
     WHERE s.member_slug = ? ${archivedFilter} ORDER BY s.title COLLATE NOCASE`
  ).bind(member).all();
  // Personal fields are for the list's owner only. Notes, who's watching
  // with them, and who recommended a show were written as private memos —
  // with self-enrollment open, other members are not all friends.
  if (session.member_slug !== member) {
    for (const r of results) {
      delete r.notes;
      delete r.watching_with;
      delete r.recommended_by;
      delete r.added_by;
    }
  } else {
    // Named members ride along with the owner's own rows so the list can draw
    // them as people rather than re-parsing them out of the display string.
    // Owner-only for the same reason watching_with is: it says who someone is
    // spending their evenings with.
    const byShow = await watchersForShows(env, results.map((r) => r.id));
    for (const r of results) r.watchers = byShow.get(r.id) || [];
    // And who put each row here, when it wasn't them — the group-mate whose
    // Watching With tag created it. A mystery title on your own list should
    // explain itself.
    await attachAddedByMembers(env, results, member);
  }
  await borrowArtworkAcrossCopies(env, results);
  return new Response(JSON.stringify({ shows: results }), { headers: corsHeaders() });
}

// Posters and network logos live on each member's own row and backfill one
// row at a time, so a title can have artwork on one member's copy while
// another member's identical copy is still waiting its turn in the
// enrichment rotation. For display, borrow artwork from any active copy of
// the same title. (Enrichment also propagates on write now; this covers the
// backlog and anything the rotation hasn't reached.)
async function borrowArtworkAcrossCopies(env, rows) {
  if (!rows.some(r => !r.poster_url || !r.network_logo_url)) return;
  // Grouped by (title, tmdb_id) so a copy only borrows from siblings of the
  // same TMDB entry (or unpinned ones) — a same-titled remake and its
  // original must not lend each other artwork.
  const { results: art } = await env.DB.prepare(
    `SELECT LOWER(title) AS ltitle, tmdb_id, MAX(poster_url) AS poster_url,
            MAX(network_logo_url) AS network_logo_url
       FROM shows
      WHERE archived = 0 AND (poster_url IS NOT NULL OR network_logo_url IS NOT NULL)
      GROUP BY LOWER(title), tmdb_id`
  ).all();
  const byTitle = new Map();
  for (const a of art) {
    const list = byTitle.get(a.ltitle) || [];
    list.push(a);
    byTitle.set(a.ltitle, list);
  }
  for (const r of rows) {
    const candidates = byTitle.get((r.title || '').toLowerCase()) || [];
    const usable = candidates.filter(a =>
      a.tmdb_id == null || r.tmdb_id == null || a.tmdb_id === r.tmdb_id);
    // Prefer the donor that shares the row's exact pin over an unpinned one.
    usable.sort((a, b) => (a.tmdb_id === r.tmdb_id ? -1 : 0) - (b.tmdb_id === r.tmdb_id ? -1 : 0));
    for (const a of usable) {
      if (!r.poster_url) r.poster_url = a.poster_url;
      if (!r.network_logo_url) r.network_logo_url = a.network_logo_url;
    }
  }
}

async function findGoodCopyAcrossMembers(env, title, tmdbId = null) {
  // Returns the first (any-member) active row for this title that has a real
  // network + deep-link URL (not a search-page placeholder). Used to inherit
  // network/URL on insert so new shows don't land in the URL-cleanup queue.
  // A copy pinned to a different tmdb_id is a different show sharing the
  // title (a remake next to its original) — its URL streams the wrong show,
  // so it is never a donor.
  return await env.DB.prepare(
    `SELECT network, network_url FROM shows
     WHERE LOWER(title) = LOWER(?) AND archived = 0
       AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
       AND network_url NOT LIKE '%?q=%'
       AND network_url NOT LIKE '%?query=%'
     LIMIT 1`
  ).bind(title, tmdbId, tmdbId).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  // Per-member daily cap. Far above any human pace (the whole club adds a
  // few shows a day), but each add fans out to TMDB/Watchmode calls, so
  // a scripted session could otherwise spam rows and drain API quotas.
  const { cnt: addsToday } = (await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM shows WHERE member_slug = ? AND created_at > datetime('now', '-1 day')"
  ).bind(session.member_slug).first()) || { cnt: 0 };
  if (addsToday >= 50) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: corsHeaders() });
  }

  const body = await request.json();
  const { title, network, recommended_by, list, notes, network_url, movie, full_series, watching_with } = body;
  if (!title || !list) {
    return new Response(JSON.stringify({ error: 'Title and list are required' }), { status: 400, headers: corsHeaders() });
  }
  // network_url is rendered into an href on the public site — only http(s).
  if (network_url && !safeNetworkUrl(network_url)) {
    return new Response(JSON.stringify({ error: 'invalid network_url' }), { status: 400, headers: corsHeaders() });
  }
  // The network name is rendered as markup on the member page's service-count
  // footer and in the admin URL-cleanup console, and canonicalNetwork() echoes
  // a name it doesn't recognize, so an unrecognized value is stored verbatim.
  // Reject markup at the writer rather than trusting every present and future
  // read path to escape it. The edit handler carries the same check.
  if (network && /[<>"'&]/.test(String(network))) {
    return new Response(JSON.stringify({ error: 'invalid network' }), { status: 400, headers: corsHeaders() });
  }

  // A title the member already has is refused before anything is spent
  // upstream. The canonical title is only known after enrichment, so this
  // matches what the caller sent; the check after enrichment below stays the
  // authoritative one for a title TMDB spells differently.
  const preExisting = await env.DB.prepare(
    'SELECT id, list, archived FROM shows WHERE LOWER(title) = LOWER(?) AND member_slug = ?'
  ).bind(title, session.member_slug).first();
  if (preExisting) {
    if (preExisting.archived) {
      return new Response(JSON.stringify({ error: 'exists_archived', id: preExisting.id, title }), { status: 409, headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ error: 'exists_active', list: preExisting.list, title }), { status: 409, headers: corsHeaders() });
  }

  // The 50-a-day cap above counts rows; this counts the TMDB/Watchmode
  // fan-out itself, which the edit and suggest paths spend too.
  if (!(await chargeSpend(env, session.member_slug, 'lookups'))) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: corsHeaders() });
  }

  // When the member picked the show from type-ahead search, the client sends
  // the exact TMDB id — enrich that entry directly instead of re-guessing
  // from the title. Falls back to the title search if the lookup fails.
  const tmdbId = parseInt(body.tmdb_id, 10);
  const tmdbType = body.tmdb_type === 'movie' || body.tmdb_type === 'tv' ? body.tmdb_type : null;
  let enriched = null;
  if (Number.isInteger(tmdbId) && tmdbType) {
    const byId = await fetchEnrichmentById(tmdbId, tmdbType, env);
    if (byId.canonicalTitle) enriched = byId;
  }
  if (!enriched) enriched = await fetchEnrichment(title, env, !!movie);
  const finalTitle = enriched.canonicalTitle || title;

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
  const goodCopy = network_url && network ? null : await findGoodCopyAcrossMembers(env, finalTitle, enriched.tmdbId || null);
  const userUrl = network_url || null;
  const goodCopyUrl = goodCopy && goodCopy.network_url;
  // URL trumps the dropdown — if the user pasted a Netflix link but selected
  // Hulu, the URL's domain wins (and the inverse: if user picked a network
  // but didn't paste anything, the eventual search-URL fallback won't tell us
  // anything new). Fold aliases (HBO, NBC, FX, ...) for the dropdown path.
  const rawNetwork = network || (goodCopy && goodCopy.network) || null;
  const finalNetwork =
    networkFromUrl(userUrl) ||
    networkFromUrl(goodCopyUrl) ||
    (rawNetwork ? canonicalNetwork(rawNetwork) : null) ||
    fallbackNetwork(enriched);
  const finalUrl =
    userUrl ||
    goodCopyUrl ||
    networkSearchUrl(finalNetwork, finalTitle);

  const result = await env.DB.prepare(
    `INSERT INTO shows (title, network, network_url, recommended_by, rating, list, notes, movie, full_series, watching_with, poster_url, network_logo_url, member_slug, added_by,
       overview, backdrop_url, tmdb_rating, content_rating, trailer_key, director, director_imdb_id, runtime, release_year, watch_link, tmdb_id, tmdb_type,
       episodes_released, vote_count, tagline, original_language, studio, streaming_on,
       imdb_id, tmdb_status, free_on, genres, seasons_released)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(finalTitle, finalNetwork, finalUrl, recommended_by || null, enriched.rating, list, notes || null, movie || 0, full_series || 0, watching_with || null, enriched.posterUrl || null, enriched.networkLogoUrl || null, session.member_slug, session.email,
    enriched.overview || null, enriched.backdropUrl || null, enriched.tmdbRating || null, enriched.contentRating || null, enriched.trailerKey || null, enriched.director || null, enriched.directorImdbId || null, enriched.runtime || null, enriched.releaseYear || null, enriched.watchLink || null,
    enriched.tmdbId || null, enriched.tmdbType || null,
    enriched.episodesReleased ?? null, enriched.voteCount ?? null, enriched.tagline || null,
    enriched.originalLanguage || null, enriched.studio || null,
    // Stored from the very first fetch, so a title never spends its first days
    // looking as though TMDB was never asked where it streams.
    Array.isArray(enriched.flatrateNetworks) ? enriched.flatrateNetworks.join(', ') : '',
    // Migration 073. NULL when enrichment failed, so the rotation's hot tier
    // still picks the row up.
    enriched.imdbId || null, enriched.tmdbStatus ?? null,
    Array.isArray(enriched.freeNetworks) ? enriched.freeNetworks.join(', ') : null,
    enriched.genres || null, enriched.seasonsReleased ?? null).run();

  const showId = result.meta.last_row_id;
  if (enriched.actors.length > 0) {
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id, character_name) VALUES (?, ?, ?, ?, ?, ?)');
    await env.DB.batch(enriched.actors.map((a, i) => stmt.bind(showId, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null, a.character ?? null)));
  }
  // The show's shared row (step 1 of normalizing; nothing reads it yet).
  await syncTitle(env, enriched.tmdbType, enriched.tmdbId, enriched.canonicalTitle);

  // If we ended up on a search-URL placeholder (no user paste, no sibling
  // good URL), kick off a Watchmode lookup in the background. The response
  // returns immediately with the placeholder; once Watchmode resolves,
  // every member's same-titled active row picks up the real deep link.
  const onPlaceholder = !finalUrl ||
    finalUrl.includes('/search') || finalUrl.includes('/s?') ||
    finalUrl.includes('?q=') || finalUrl.includes('?query=');
  if (onPlaceholder && finalNetwork) {
    // Propagates only to copies of the same TMDB entry (or unpinned ones) —
    // a same-titled row pinned to a different entry streams a different show.
    const newRowTmdbId = enriched.tmdbId || null;
    context.waitUntil((async () => {
      const realUrl = await lookupWatchmodeUrl(env, finalTitle, finalNetwork, !!movie);
      if (realUrl) {
        await env.DB.prepare(
          `UPDATE shows SET network_url = ?, enriched_at = datetime('now')
            WHERE LOWER(title) = LOWER(?) AND archived = 0
              AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
        ).bind(realUrl, finalTitle, newRowTmdbId, newRowTmdbId).run();
      }
    })());
  }

  // Named group-mates, if any: links the two copies and puts the title on
  // their list too. The fan-out is bounded to members the caller shares a
  // group with — _shared/watchers.js drops anything else.
  let show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(showId).first();
  if (Array.isArray(body.watcher_slugs) && body.watcher_slugs.length) {
    const synced = await syncWatchers(env, {
      show, ownerSlug: session.member_slug, ownerEmail: session.email,
      slugs: body.watcher_slugs, rawWatchingWith: watching_with || null,
    });
    show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(showId).first();
    show.watchers = synced.watchers;
  } else {
    show.watchers = [];
  }
  return new Response(JSON.stringify({ show }), { status: 201, headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

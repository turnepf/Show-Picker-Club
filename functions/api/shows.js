import { fetchEnrichment, fetchEnrichmentById, fallbackNetwork } from '../_shared/enrichment.js';
import { writeTitle, titleFieldsFromEnrichment } from '../_shared/titles.js';
import { getSession } from '../_shared/auth.js';
import { canonicalNetwork, networkFromUrl, networkSearchUrl } from '../_shared/networks.js';
import { lookupWatchmodeUrl } from '../_shared/watch-providers.js';
import { safeNetworkUrl } from '../_shared/url-utils.js';
import { chargeSpend } from '../_shared/spend-meter.js';
import { syncWatchers, watchersForShows, attachAddedByMembers } from '../_shared/watchers.js';
import { sameShowWhere } from '../_shared/same-show.js';
import { insertCopy } from '../_shared/insert-copy.js';


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
       (SELECT json_group_array(json_object('name', a.name, 'imdb_id', a.imdb_id)) FROM actors_v a WHERE a.show_id = s.id) as actors,
       sr.rating as user_rating
     FROM shows_v s
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
  return new Response(JSON.stringify({ shows: results }), { headers: corsHeaders() });
}

async function findGoodCopyAcrossMembers(env, title, tmdbId = null, tmdbType = null) {
  // Returns the first (any-member) active copy of this show that has a real
  // network + deep-link URL (not a search-page placeholder). Used to inherit
  // network/URL on insert so new shows don't land in the URL-cleanup queue.
  // A copy pinned to a different TMDB entry is a different show sharing the
  // title (a remake next to its original) — its URL streams the wrong show,
  // so it is never a donor. Both columns are the copy's own, so this reads
  // `shows` directly, where the TMDB-id index applies.
  const same = sameShowWhere('s', { title, tmdb_id: tmdbId, tmdb_type: tmdbType }, { hasTitle: false });
  return await env.DB.prepare(
    `SELECT network, network_url FROM shows s
     WHERE ${same.sql} AND archived = 0
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
       AND network_url NOT LIKE '%?q=%'
       AND network_url NOT LIKE '%?query=%'
     ORDER BY (s.tmdb_id IS NULL)
     LIMIT 1`
  ).bind(...same.binds).first();
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
    "SELECT COUNT(*) AS cnt FROM shows_v WHERE member_slug = ? AND created_at > datetime('now', '-1 day')"
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
  // A pick names its TMDB entry, so another show that merely shares the
  // title (three 2026 films are called "The Odyssey") isn't a duplicate.
  const pre = sameShowWhere('s', { title, tmdb_id: body.tmdb_id, tmdb_type: body.tmdb_type, movie });
  const preExisting = await env.DB.prepare(
    `SELECT id, list, archived FROM shows_v s WHERE ${pre.sql} AND member_slug = ?`
  ).bind(...pre.binds, session.member_slug).first();
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

  // Every show is a TMDB entry: its name, artwork and details live once on
  // the shared row, and a copy carries no title of its own. So a show TMDB
  // can't identify isn't added. TMDB being unreachable is "try again later";
  // TMDB having nothing by that name is a refusal the member can act on.
  if (!enriched.tmdbId) {
    if (enriched.noMatch) {
      return new Response(JSON.stringify({
        error: 'no_match', title,
        message: `No show or movie called "${title}" was found. Check the spelling, or pick it from the search suggestions.`,
      }), { status: 422, headers: corsHeaders() });
    }
    return new Response(JSON.stringify({
      error: 'tmdb_unavailable', title,
      message: "We couldn't reach the show catalog just now. Please try again in a few minutes.",
    }), { status: 503, headers: corsHeaders() });
  }
  const finalTitle = enriched.canonicalTitle || title;

  const post = sameShowWhere('s', {
    // The pick still names the entry when TMDB couldn't be reached.
    title: finalTitle,
    tmdb_id: enriched.tmdbId || (Number.isInteger(tmdbId) ? tmdbId : null),
    tmdb_type: enriched.tmdbId ? enriched.tmdbType : tmdbType,
    movie,
  });
  const existing = await env.DB.prepare(
    `SELECT id, list, archived FROM shows_v s WHERE ${post.sql} AND member_slug = ?`
  ).bind(...post.binds, session.member_slug).first();
  if (existing) {
    if (existing.archived) {
      return new Response(JSON.stringify({ error: 'exists_archived', id: existing.id, title: finalTitle }), { status: 409, headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ error: 'exists_active', list: existing.list, title: finalTitle }), { status: 409, headers: corsHeaders() });
  }

  // If another member already has a good (non-placeholder) URL for this title,
  // inherit it. Beats the search-page fallback and keeps the title out of the
  // URL-cleanup queue.
  const goodCopy = network_url && network ? null : await findGoodCopyAcrossMembers(env, finalTitle,
    enriched.tmdbId || (Number.isInteger(tmdbId) ? tmdbId : null), enriched.tmdbId ? enriched.tmdbType : tmdbType);
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

  // The member's row holds what is theirs; the show's facts and cast go to its
  // shared row just below (docs/INVARIANTS.md §29). The badge stays per copy
  // because it follows the member's service.
  const result = await insertCopy(env, {
    network: finalNetwork, network_url: finalUrl, recommended_by: recommended_by || null, list,
    notes: notes || null, movie: movie || 0, full_series: full_series || 0, watching_with: watching_with || null,
    network_logo_url: enriched.networkLogoUrl || null, member_slug: session.member_slug, added_by: session.email,
    tmdb_id: enriched.tmdbId, tmdb_type: enriched.tmdbType,
  });

  const showId = result.meta.last_row_id;
  // The show's shared row, straight from the TMDB payload (docs/INVARIANTS.md §29).
  await writeTitle(env, enriched.tmdbType, enriched.tmdbId, {
    name: enriched.canonicalTitle, fields: titleFieldsFromEnrichment(enriched), cast: enriched.actors,
  });

  // If we ended up on a search-URL placeholder (no user paste, no sibling
  // good URL), kick off a Watchmode lookup in the background. The response
  // returns immediately with the placeholder; once Watchmode resolves,
  // every member's same-titled active row picks up the real deep link.
  const onPlaceholder = !finalUrl ||
    finalUrl.includes('/search') || finalUrl.includes('/s?') ||
    finalUrl.includes('?q=') || finalUrl.includes('?query=');
  if (onPlaceholder && finalNetwork) {
    // Propagates only to copies of the same TMDB entry: a same-titled row
    // pinned to a different entry streams a different show.
    const same = sameShowWhere('shows', { tmdb_id: enriched.tmdbId, tmdb_type: enriched.tmdbType }, { hasTitle: false });
    context.waitUntil((async () => {
      const realUrl = await lookupWatchmodeUrl(env, finalTitle, finalNetwork, !!movie);
      if (realUrl) {
        await env.DB.prepare(
          `UPDATE shows SET network_url = ?, enriched_at = datetime('now')
            WHERE ${same.sql} AND archived = 0`
        ).bind(realUrl, ...same.binds).run();
      }
    })());
  }

  // Named group-mates, if any: links the two copies and puts the title on
  // their list too. The fan-out is bounded to members the caller shares a
  // group with — _shared/watchers.js drops anything else.
  let show = await env.DB.prepare('SELECT * FROM shows_v WHERE id = ?').bind(showId).first();
  if (Array.isArray(body.watcher_slugs) && body.watcher_slugs.length) {
    const synced = await syncWatchers(env, {
      show, ownerSlug: session.member_slug, ownerEmail: session.email,
      slugs: body.watcher_slugs, rawWatchingWith: watching_with || null,
    });
    show = await env.DB.prepare('SELECT * FROM shows_v WHERE id = ?').bind(showId).first();
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

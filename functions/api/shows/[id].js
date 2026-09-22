import { fetchEnrichment, fetchEnrichmentById, fallbackNetwork } from '../../_shared/enrichment.js';
import { getSession } from '../../_shared/auth.js';
import { canonicalNetwork, networkFromUrl } from '../../_shared/networks.js';
import { lookupWatchmodeUrl } from '../../_shared/watch-providers.js';
import { safeNetworkUrl } from '../../_shared/url-utils.js';
import { getRatingsSummary } from '../../_shared/ratings.js';
import { creatorsForShow } from '../../_shared/people.js';
import { syncWatchers, watchersForShow, unlinkShow, attachAddedByMembers } from '../../_shared/watchers.js';

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
  'director', 'director_imdb_id', 'runtime', 'release_year', 'watch_link',
  // Where it streams today. A catalog fact like the rest — it says nothing
  // about whose list the title is on, only what TMDB reports about the title.
  'streaming_on',
];

// Other members of the viewer's groups who have this same title on their
// Watching list. Group-scoped by design: only people the viewer already
// shares a group with are named, and only ever their first name — nothing
// about a stranger's library leaks. The viewer and the row's owner are both
// left out (the viewer knows their own lists, and the owner's list is
// already on screen).
//
// Titles are matched the way the rest of the app matches copies across
// members: by tmdb_id when the row has one, else case-insensitively by
// title. Returns [] for a logged-out visitor or a member in no groups.
async function groupWatchers(env, show, viewerSlug) {
  if (!viewerSlug) return [];
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.slug, m.first_name, m.name
       FROM shows s
       INNER JOIN members m ON m.slug = s.member_slug
      WHERE s.archived = 0
        AND s.list = 'watching'
        AND s.member_slug != ?
        AND s.member_slug != ?
        AND s.member_slug IN (
          SELECT gm.member_slug FROM group_members gm
           WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?)
        )
        AND (LOWER(s.title) = LOWER(?) OR (? IS NOT NULL AND s.tmdb_id = ?))
      ORDER BY m.first_name, m.name`
  ).bind(
    viewerSlug,
    show.member_slug,
    viewerSlug,
    show.title,
    show.tmdb_id ?? null,
    show.tmdb_id ?? null
  ).all();
  return (results || []).map((m) => ({
    slug: m.slug,
    name: m.first_name || (m.name || '').split(' ')[0] || m.slug,
  }));
}

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  if (!show) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }
  const session = await getSession(request, env);
  // Average + count show on every card, logged in or not (a deliberate,
  // scoped exception to the tiny public surface — see docs/PRODUCT.md).
  // `mine` only populates for a logged-in viewer; `owner` only populates
  // when viewing a specific other member's copy (never your own — nothing
  // extra to say when owner === viewer).
  const ratings = await getRatingsSummary(env, {
    tmdbId: show.tmdb_id,
    tmdbType: show.tmdb_type,
    viewerSlug: session ? session.member_slug : null,
    ownerSlug: show.member_slug,
  });
  // Name for the "<member>'s rating" line — only needed when there's an
  // owner rating to label. Same fallback chain as the Search-all-libraries
  // member tag (index.html): first_name override, else first word of name.
  if (ratings && ratings.owner !== null) {
    const owner = await env.DB.prepare(
      'SELECT first_name, name FROM members WHERE slug = ?'
    ).bind(show.member_slug).first();
    ratings.ownerName = (owner && (owner.first_name || (owner.name || '').split(' ')[0])) || show.member_slug;
  }

  // Who else in the viewer's groups is watching this — session only.
  const group_watchers = await groupWatchers(env, show, session ? session.member_slug : null);

  // Full row (notes, watching_with, recommended_by, added_by) is for the
  // show's owner only. Other members get catalog fields plus enough context
  // to say "on Watching · <member>"; logged-out visitors get catalog only.
  // Creators as a linkable list: `director` is one comma-joined string with a
  // single id for the first credit, so a co-created show could never link
  // more than one name. The canonical people table resolves each name.
  const creators = await creatorsForShow(env, show);

  if (session && session.member_slug === show.member_slug) {
    // Whom this row names, as members. Owner-only, alongside the
    // watching_with text it was composed into — same rule as notes. And who
    // created the row when it wasn't the owner: the group-mate whose
    // Watching With tag put it here.
    show.watchers = await watchersForShow(env, show.id);
    await attachAddedByMembers(env, [show], session.member_slug);
    return new Response(JSON.stringify({ show, ratings, group_watchers, creators }), { headers: corsHeaders() });
  }
  const redacted = {};
  for (const k of PUBLIC_SHOW_FIELDS) if (k in show) redacted[k] = show[k];
  // `list` is whose-list-is-it information, so a logged-out visitor doesn't
  // get the real value — but the field has to be PRESENT. The Apple clients
  // decode a non-optional `list`, so omitting it failed the whole payload and
  // a logged-out show card rendered almost nothing: no poster, overview,
  // ratings, genres, runtime or year, all of which are public catalog facts
  // this endpoint had already put in the response.
  redacted.list = session ? show.list : '';
  if (session) {
    redacted.member_slug = show.member_slug;
  }
  return new Response(JSON.stringify({ show: redacted, ratings, group_watchers, creators }), { headers: corsHeaders() });
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
  // Same constraint as the add path — this is the second unguarded writer of
  // the network column, so validating only on insert leaves the field open.
  if (body.network !== undefined && body.network && /[<>"'&]/.test(String(body.network))) {
    return new Response(JSON.stringify({ error: 'invalid network' }), { status: 400, headers: corsHeaders() });
  }
  const val = (key) => body[key] !== undefined ? body[key] : existing[key];
  const title = val('title');
  const network_url = body.network_url !== undefined ? body.network_url : existing.network_url;
  // A URL the member is pasting in THIS edit still trumps the dropdown — if
  // they hand us a netflix.com link, they mean Netflix whatever the picker
  // said. That is the case the rule was written for.
  //
  // A URL already on the row is not evidence of anything the member chose.
  // Since Watchmode these arrive from a machine — nobody pastes them — and
  // letting one outvote the dropdown meant a member could not move a show
  // off the service a machine had picked for it: choosing Hulu on a row
  // holding a tv.apple.com deep link silently saved Apple TV+ again, with no
  // error to explain why the change didn't take. A machine never overwrites
  // a member's answer (docs/INVARIANTS.md §20), and a link it fetched is
  // still the machine talking.
  const pastedUrl = body.network_url !== undefined ? body.network_url : null;
  const network = (pastedUrl ? networkFromUrl(pastedUrl) : null)
    || canonicalNetwork(val('network'))
    // Nothing chosen at all (a partial update that names neither): the row's
    // own URL is better than dropping the network on the floor.
    || networkFromUrl(network_url)
    || null;
  const recommended_by = val('recommended_by');
  const list = val('list');
  // Same allowlist as move.js — the two write paths that set `list` have to
  // agree, or an edit can park a row on a list no screen renders.
  const validLists = ['watching', 'waiting', 'recommending', 'next'];
  if (!validLists.includes(list)) {
    return new Response(JSON.stringify({ error: 'Invalid list' }), { status: 400, headers: corsHeaders() });
  }
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

  const finalNetwork = network || fallbackNetwork(enriched);
  // The service badge was derived from the network this row USED to name, so a
  // member switching services must not keep the previous one's logo — that is
  // the mismatch #429 fixed, arriving through the edit path instead. Cleared
  // rather than recomputed: the right logo needs a TMDB round trip this
  // handler isn't making, and a blank badge is correct where a stale one is a
  // lie. `mode: 'logos'` selects on exactly this NULL, so a sweep refills it.
  const networkChanged = (finalNetwork || null) !== (existing.network || null);
  // The stored link belongs to the service this row used to name. Once the
  // member has moved it somewhere else, that link sends the Watch button to
  // the wrong app — so it goes, and the background lookup below fills in a
  // right one. Dropping to the service's search page in the meantime is the
  // honest state; pointing confidently at Apple TV+ for a show the member
  // just said is on Hulu is not. A URL pasted in this same edit is kept,
  // because that one is the member's answer rather than a stale machine's.
  const urlService = network_url ? networkFromUrl(network_url) : null;
  const urlNowWrong = networkChanged && !pastedUrl && urlService && urlService !== finalNetwork;
  const finalUrl = urlNowWrong ? null : network_url;
  await env.DB.prepare(
    `UPDATE shows SET title = ?, network = ?, network_url = ?, recommended_by = ?, list = ?, notes = ?, movie = ?, full_series = ?, watching_with = ?, rating = ?, archived = ?,
        poster_url = COALESCE(?, poster_url),
        network_logo_url = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, network_logo_url) END,
        overview = COALESCE(?, overview), backdrop_url = COALESCE(?, backdrop_url),
        tmdb_rating = COALESCE(?, tmdb_rating), content_rating = COALESCE(?, content_rating),
        trailer_key = COALESCE(?, trailer_key), director = COALESCE(?, director),
        director_imdb_id = COALESCE(?, director_imdb_id),
        runtime = COALESCE(?, runtime), release_year = COALESCE(?, release_year),
        watch_link = COALESCE(?, watch_link),
        tmdb_id = COALESCE(?, tmdb_id), tmdb_type = COALESCE(?, tmdb_type),
        updated_at = datetime('now') WHERE id = ?`
  ).bind(title, finalNetwork, finalUrl, recommended_by, list, notes, movie, full_series, watching_with, rating, archived,
    enriched.posterUrl || null, networkChanged ? 1 : 0, enriched.networkLogoUrl || null,
    enriched.overview || null, enriched.backdropUrl || null, enriched.tmdbRating || null, enriched.contentRating || null,
    enriched.trailerKey || null, enriched.director || null, enriched.directorImdbId || null, enriched.runtime || null, enriched.releaseYear || null,
    enriched.watchLink || null, enriched.tmdbId || null, enriched.tmdbType || null, params.id).run();

  if (enriched.actors.length > 0) {
    await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(params.id).run();
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
    await env.DB.batch(enriched.actors.map((a, i) => stmt.bind(params.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
  }

  // If the network changed (or we landed on a placeholder URL), kick off
  // a Watchmode lookup in the background to keep the row on a real
  // deep link. Propagates to all members' same-titled active rows.
  const onPlaceholder = !finalUrl ||
    finalUrl.includes('/search') || finalUrl.includes('/s?') ||
    finalUrl.includes('?q=') || finalUrl.includes('?query=');
  if (finalNetwork && (networkChanged || onPlaceholder)) {
    // Propagates only to copies of the same TMDB entry (or unpinned ones) —
    // a same-titled row pinned to a different entry streams a different show.
    const rowTmdbId = enriched.tmdbId || existing.tmdb_id || null;
    context.waitUntil((async () => {
      const realUrl = await lookupWatchmodeUrl(env, title, finalNetwork, !!movie);
      if (realUrl) {
        await env.DB.prepare(
          // Scoped to copies naming the SAME service, not merely the same
          // title. The URL was looked up for `finalNetwork`; a member whose
          // copy of this title says Apple TV+ must not have a Hulu link
          // pushed onto it because somebody else moved their own copy. Same
          // rule #482 put on sync-urls — a link is only evidence for a row
          // on the service it belongs to.
          `UPDATE shows SET network_url = ?, enriched_at = datetime('now')
            WHERE LOWER(title) = LOWER(?) AND archived = 0 AND network = ?
              AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
        ).bind(realUrl, title, finalNetwork, rowTmdbId, rowTmdbId).run();
      }
    })());
  }

  let show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  // `watcher_slugs` is the complete set of named group-mates, so an edit that
  // unticks someone unlinks them. Absent entirely (an older build, a partial
  // update) leaves the links as they are — see syncWatchers.
  const synced = await syncWatchers(env, {
    show, ownerSlug: session.member_slug, ownerEmail: session.email,
    slugs: body.watcher_slugs !== undefined ? body.watcher_slugs : null,
    rawWatchingWith: watching_with,
  });
  show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  show.watchers = synced.watchers;
  return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  // Take this row's name off everyone it named before it goes. The foreign
  // key cascade only reaches the links hanging off this show; the mirrors
  // live on other members' rows and would otherwise keep naming a member
  // whose copy no longer exists.
  const existing = await env.DB.prepare('SELECT * FROM shows WHERE id = ? AND member_slug = ?')
    .bind(params.id, session.member_slug).first();
  if (existing) await unlinkShow(env, existing);
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

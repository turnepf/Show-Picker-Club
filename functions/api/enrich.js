import { getSession } from '../_shared/auth.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { fetchEnrichment, fetchEnrichmentById, extractTmdbDetailFields, fallbackNetwork, dedupeCast, castCharacter, CAST_DEPTH, pickBestMatch, titleSearchTerms } from '../_shared/enrichment.js';
import { fillActorIdsFromKnownPeople, knownByPersonIds, rememberPeople } from '../_shared/people.js';
import { canonicalNetwork } from '../_shared/networks.js';
import { writeTitle, titleFieldsFromEnrichment, rebuildTitles } from '../_shared/titles.js';

// TMDB GET that works with either credential the worker has configured:
// the v4 Bearer token (TMDB_TOKEN, what the shared enrichment path uses) is
// preferred, falling back to a v3 api_key query param (TMDB_API_KEY). The
// poster passes below originally required TMDB_API_KEY only — if a deployment
// sets just TMDB_TOKEN, those passes silently no-op'd (tmdbUpdated stayed 0).
// Cloudflare caps subrequests per Worker invocation, and this endpoint is the
// heaviest thing we run: search + detail per title, plus a person lookup for
// anyone we haven't resolved before. Spend it deliberately — when the budget
// is gone the batch stops early and the queue rotation picks up where it left
// off next round, which is strictly better than a title dying mid-write.
const SUBREQUEST_BUDGET = 45;
let spent = 0;
function budgetLeft() { return SUBREQUEST_BUDGET - spent; }

// Retries on 429 and throws on any other failure, mirroring
// _shared/enrichment.js#tmdbFetch. Both halves matter here.
//
// This used to `return res.json()` whatever the status. A rate-limited search
// therefore came back as TMDB's error body, which has no `.results`, so
// tmdbSearchFirst read it as "TMDB has no such title" — and the caller did the
// right thing for a hopeless title: stamped enriched_at on every copy and moved
// on. During a long backfill that quietly burned real titles (Breaking Bad,
// Deadwood) into the already-tried pile with no data, and because the stamp is
// fresh, the oldest-first queue then sent them to the *back*, so a re-run
// retried everything else first. Throwing instead lands the failure in the
// per-show catch, which counts it and leaves enriched_at alone — so the row
// stays near the front and gets a real retry.
//
// Each attempt is a genuine subrequest, so each one counts against the budget.
async function tmdbGet(path, env, attempt = 0) {
  spent++;
  const token = env.TMDB_TOKEN;
  const sep = path.includes('?') ? '&' : '?';
  const res = token
    ? await fetch(`https://api.themoviedb.org/3${path}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
    : await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${env.TMDB_API_KEY}`);
  if (res.status === 429 && attempt < 3) {
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return tmdbGet(path, env, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  return res.json();
}

// Best TMDB result for the title (or null). type is 'tv' | 'movie'.
//
// The pick itself is the shared pickBestMatch (enrichment.js): exact title
// match beats popularity, a "(YYYY)" suffix in the stored title pins the
// year, and among several same-named entries the newest wins — the club
// wants the current version of a remade show, not the original TMDB's
// popularity ranking favors. The search query goes out with the year suffix
// stripped, since TMDB often returns nothing for the suffixed form.
//
// null means one thing only: TMDB answered, and has no such title. Errors are
// deliberately NOT caught here — the callers treat null as "hopeless, stamp it
// and move on", so swallowing a transient failure into null is what silently
// retired real titles. Let it throw; the per-show catch counts it as an error
// and leaves enriched_at untouched for a genuine retry.
async function tmdbSearchFirst(title, type, env) {
  const { query } = titleSearchTerms(title);
  const data = await tmdbGet(`/search/${type}?query=${encodeURIComponent(query)}`, env);
  const results = (data && data.results) || [];
  if (!results.length) return null;
  return pickBestMatch(results, type, title);
}

// Store the cast TMDB just handed us, CAST_DEPTH deep and in billing order,
// across every copy of the title. IMDB ids come from the canonical people
// table when we've seen the person before (no request), and are looked up
// only while the subrequest budget allows — anyone left unresolved is picked
// up by a later round or by the free cache pass, so a tight budget costs
// links, never the cast itself. Copies pinned to a DIFFERENT tmdb_id are a
// different show that happens to share the title (a remake next to the
// original) — their cast is not this cast, so they keep their own rows.
async function refreshCastFromDetail(env, show, detail, tmdbId) {
  const cast = dedupeCast(detail.credits?.cast).slice(0, CAST_DEPTH);
  if (!cast.length) return [];
  const known = await knownByPersonIds(env, cast.map(p => p.id));
  const people = [];
  const rows = [];
  for (let i = 0; i < cast.length; i++) {
    const person = cast[i];
    let imdbId = known.get(person.id) || null;
    if (!imdbId && budgetLeft() > 6) {
      imdbId = await personImdbId(person.id, env);
      if (imdbId) people.push({ tmdbPersonId: person.id, name: person.name, imdbId });
    }
    rows.push({ name: person.name, imdb_id: imdbId, ord: i, tmdb_person_id: person.id, character: castCharacter(person) });
  }
  await rememberPeople(env, people).catch(() => {});

  const { results: copies } = await env.DB.prepare(
    `SELECT id FROM shows
      WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)
        AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
  ).bind(show.id, tmdbId ?? null, tmdbId ?? null).all();
  const insert = env.DB.prepare(
    'INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id, character_name) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const copy of copies || []) {
    // Replace rather than merge: the incoming list is authoritative and
    // ordered, and a partial overlay would leave the old shallow tail behind.
    await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
    await env.DB.batch(rows.map(r => insert.bind(copy.id, r.name, r.imdb_id, r.ord, r.tmdb_person_id, r.character)));
  }
  // The caller writes the same list to the shared cast (writeTitle).
  return rows;
}

// Fill missing artwork from sibling copies of the same title — a poster
// fetched for one member's copy covers everyone's, so no TMDB budget should
// ever be spent on a title that already has artwork somewhere. Pure DB work,
// zero subrequests. (New fetches also propagate at write time; this sweep
// catches the backlog from before that existed.) A sibling pinned to a
// different tmdb_id is a different show sharing the title — never a donor.
async function syncArtworkAcrossCopies(env) {
  await env.DB.prepare(
    `UPDATE shows SET poster_url = (
        SELECT s2.poster_url FROM shows s2
         WHERE LOWER(s2.title) = LOWER(shows.title)
           AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
           AND s2.poster_url IS NOT NULL LIMIT 1)
      WHERE poster_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
                       AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
                       AND s2.poster_url IS NOT NULL)`
  ).run();
  await env.DB.prepare(
    `UPDATE shows SET network_logo_url = (
        SELECT s2.network_logo_url FROM shows s2
         WHERE LOWER(s2.title) = LOWER(shows.title)
           AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
           AND s2.network_logo_url IS NOT NULL LIMIT 1)
      WHERE network_logo_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
                       AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
                       AND s2.network_logo_url IS NOT NULL)`
  ).run();
}

// Resolve a TMDB person id to their IMDB id (nm…), for the creator/director
// person link on the detail screen. Best-effort: null on any miss/error.
async function personImdbId(personId, env) {
  if (!personId) return null;
  try {
    const ext = await tmdbGet(`/person/${personId}/external_ids`, env);
    return ext.imdb_id || null;
  } catch (e) {
    return null;
  }
}

// The stored form of TMDB's flatrate list: canonical names, comma-separated,
// matching `network`'s vocabulary. Empty string rather than NULL when TMDB
// answered and named nothing — "asked, streams nowhere on a plan" is a
// different fact from "never asked", and the UI needs to tell them apart.
// Empty data before stale data. The rotations below order by oldest
// enriched_at, which is the right order for refreshing but the wrong one for
// filling: a show added yesterday with no poster or cast carries the newest
// stamp in the library, so it waited behind the whole library's refresh. A
// row with a gap now goes first — but only if no pass has tried it in the
// last 20 hours. Without that window a title TMDB has nothing for (a
// placeholder entry with no cast yet) would keep a front slot through every
// round of every run; with it, a hopeless row is retried once a night and
// otherwise rotates by age like everything else. 20 rather than 24 so a
// nightly run always re-qualifies yesterday's attempt.
const NOT_TRIED_RECENTLY =
  `julianday(COALESCE(enriched_at, '1970-01-01')) < julianday('now', '-20 hours')`;

function streamingOn(df) {
  return Array.isArray(df.flatrateNetworks) ? df.flatrateNetworks.join(', ') : '';
}

// free_on's stored form: same encoding as streaming_on, except that a payload
// with no provider block at all yields NULL, so the COALESCE in the writes
// below keeps the last answer rather than claiming TMDB named nothing.
function freeOn(df) {
  return Array.isArray(df.freeNetworks) ? df.freeNetworks.join(', ') : null;
}

// Watching and Next Up are the lists members actually open, so within the
// gap tiers below they go first. Only within those tiers: putting them ahead
// of the age rotation itself would let a long Watching list take every slot
// in every round and starve the rest of the library of refreshes.
const HOT_LIST = `(archived = 0 AND list IN ('watching', 'next'))`;

// Migration 073's fields (imdb_id, tmdb_status, free_on, cast characters)
// arrive with any full pass, so the ordinary rotation fills them without a
// backfill. This only brings that forward for the hot lists: a Watching or
// Next Up row no pass has written them for yet goes ahead of the age
// rotation, behind real gaps. tmdb_status is the marker because every pass
// writes it non-NULL ('' when TMDB sends no status), so a row leaves this
// tier on its first pass and can't churn; NOT_TRIED_RECENTLY covers a title
// TMDB can't match, which is stamped and skipped like any other.
const HOT_UNFILLED = `(${HOT_LIST} AND tmdb_status IS NULL AND ${NOT_TRIED_RECENTLY})`;

export async function onRequestPost(context) {
  const { env, request } = context;
  // Normally driven by a logged-in member loading their page. Also allow a
  // matching X-Cron-Secret so a scheduled/one-off job can backfill the whole
  // library (e.g. after adding poster/logo enrichment).
  const session = await getSession(request, env);
  const cronOk = await cronAuthorized(request, env);
  if (!session && !cronOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}

  // `mode: 'titles'` rebuilds the shared one-row-per-show table from every
  // copy (functions/_shared/titles.js). The nightly job runs it once, after
  // the passes, to catch the rarer writers that don't sync as they go
  // (URL cleanup, imports, group recommendations, Watching With copies) and
  // to drop entries nothing points at any more. Whole-library work, so it's
  // the scheduled job's alone rather than every member page load's.
  if (body.mode === 'titles') {
    if (!cronOk) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const counts = await rebuildTitles(env);
    return new Response(JSON.stringify({ rebuilt: true, ...counts }), { headers: { 'Content-Type': 'application/json' } });
  }
  const member = body.member || null;
  // Cloudflare's subrequest ceiling still bounds a single invocation, so the
  // heavy TMDB detail passes and the cheap poster catch-up stay separable.
  // `mode: 'posters'` (or skip_omdb/skip_actors) runs only the small poster
  // batch so an artwork backfill fits comfortably within budget. (`skip_omdb`
  // is kept as an alias now that OMDB is gone — it still selects posters-only.)
  const skipOmdb = body.skip_omdb === true || body.mode === 'posters';
  const skipActors = body.skip_actors === true || body.mode === 'posters' || body.mode === 'logos'
    || body.mode === 'movies' || (Number.isInteger(body.show_id) && body.show_id > 0);
  // `mode: 'gaps'` targets rows that are marked enriched but hold no data —
  // the wreckage of the rate-limit bug this file's tmdbGet comment describes.
  // Those rows carry a FRESH enriched_at (the no-match path stamped them), so
  // the ordinary oldest-first rotation sends them to the back and a plain
  // re-run retries the whole library before reaching them. Selecting on the
  // absence of data instead of on age is the only thing that finds them.
  //
  // It also reports `remaining`, so a caller can drive it to zero rather than
  // guessing when the library is whole.
  const gapsOnly = body.mode === 'gaps';
  // `mode: 'logos'` is a one-time sweep for movie service badges, and is
  // deliberately NOT folded into MOVIE_GAP below. A rent/buy-only film has no
  // flatrate provider and therefore no logo to fetch, so a standing
  // `network_logo_url IS NULL` gate would re-select those rows on every member
  // page load forever — spending the whole budget on rows nothing can fill,
  // which is the churn a data-absence gate invites when the data is sometimes
  // legitimately absent. New films need no sweep: they insert without genres,
  // so MOVIE_GAP already selects them and the pass writes the logo on the way
  // past. This mode exists only to drain the films that predate the fix.
  const logosOnly = body.mode === 'logos';
  // `mode: 'movies'` is the movie half of the standing rotation, and runs
  // nightly from enrich-backfill.yml. MOVIE_GAP selects a film only while it
  // is missing something, so a complete film was never fetched again: where
  // it streams (streaming_on), its rating and vote count froze at whatever
  // TMDB said the day it was first filled. The default mode can't fix that by
  // widening its gate — the TV pass runs first and nearly always spends the
  // subrequest budget, so the movie pass only ever gets the leftovers. This
  // mode skips the TV pass and the actor backfill so the whole budget goes
  // to films, oldest-enriched first, the same rotation the TV pass uses.
  const moviesOnly = body.mode === 'movies';
  // `show_id`: refresh exactly one row now, whatever its list, archive state
  // or gaps — the admin_refresh_show tool's "fill this in without waiting for
  // tonight". It skips every gate and rotation below, and the library-wide
  // actor backfill, so the whole call is spent on the one title.
  const showId = Number.isInteger(body.show_id) && body.show_id > 0 ? body.show_id : null;
  // Optional: restrict the TMDB passes to a specific set of titles (e.g. the
  // Trending shelf), so we can prioritise the most-visible shows first.
  const titles = Array.isArray(body.titles) && body.titles.length
    ? body.titles.map(t => String(t).toLowerCase()) : null;
  // Soft cap on the TMDB batch, kept well clear of the per-invocation
  // subrequest ceiling. Smaller in posters-only mode since that's just a
  // top-up sweep.
  const maxTmdb = parseInt(body.max_tmdb ?? (skipOmdb ? '6' : '50'), 10);

  // `enriched` is retained in the response shape for callers/UI that read it;
  // the OMDB ratings/actors pass it once counted is gone (TMDB now supplies
  // ratings, cast, and creator links directly in the passes below).
  let enriched = 0;

  // TMDB: check next season dates for Watching and Waiting shows.
  // Cap the same way; oldest/least-recently-enriched first so the budget rotates evenly.
  const hasTmdb = !!(env.TMDB_TOKEN || env.TMDB_API_KEY);
  spent = 0;
  let tmdbUpdated = 0;
  // A bare `catch (e) {}` around each title meant a pass that failed on every
  // single show reported exactly the same thing as a pass with nothing to do:
  // zero. Count the failures and keep the first message so a backfill run can
  // say which it was.
  let budgetExhausted = false;
  let tvCandidates = 0;
  let movieCandidates = 0;
  let tvErrors = 0;
  let movieErrors = 0;
  let lastError = null;
  if (hasTmdb && !logosOnly && !moviesOnly) {
    // Cover everything a sibling copy already covers before spending budget.
    await syncArtworkAcrossCopies(env);

    // Archived rows are in scope: Favorite Actors counts an archived title
    // rated 8+, so its cast has to be there to count. Posters and gaps modes
    // select on missing data, so an archived row joins them only until it is
    // filled; the normal rotation below takes an archived row only while it
    // has a gap, so the shelf of finished shows can't stretch the cycle that
    // keeps next-season dates on live lists current.
    let tvWhere = `movie = 0`;
    const tvBinds = [];
    if (member) { tvWhere += ` AND member_slug = ?`; tvBinds.push(member); }
    if (titles) { tvWhere += ` AND LOWER(title) IN (${titles.map(() => '?').join(',')})`; tvBinds.push(...titles); }
    // Posters mode exists to catch artwork up, so don't spend its small batch
    // on shows that already have a poster (the sync above just filled every
    // row a sibling could cover — poster_url NULL now means no copy has one),
    // and take one row per title since the fetch propagates to all copies.
    // A series with no cast row, or with no episode count, is a series the
    // no-match path burned — both come from the same detail fetch, so one
    // predicate catches both halves of the damage. One row per title, since
    // the fetch propagates to every copy.
    const TV_GAP = `(NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id)
                     OR episodes_released IS NULL)`;
    // Grouped by (title, tmdb_id), not title alone: two members can hold two
    // different TMDB entries under one title (a remake next to its original),
    // and each pin deserves its own fetch — one row per title would let
    // whichever copy the GROUP BY happened to keep answer for both.
    const tvSelect = skipOmdb
      ? `SELECT id, title, movie, list, archived, network_url, tmdb_id, tmdb_type FROM shows
          WHERE ${tvWhere} AND poster_url IS NULL
          GROUP BY LOWER(title), tmdb_id
          ORDER BY MIN(CASE WHEN ${HOT_LIST} THEN 0 ELSE 1 END),
                   MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
      : gapsOnly
      ? `SELECT id, title, movie, list, archived, network_url, tmdb_id, tmdb_type FROM shows
          WHERE ${tvWhere} AND ${TV_GAP}
          GROUP BY LOWER(title), tmdb_id
          ORDER BY MIN(CASE WHEN ${HOT_LIST} THEN 0 ELSE 1 END),
                   MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
      // Tiers: 0 a real gap, 1 a hot-list row missing migration 073's fields,
      // 2 the age rotation. Hot lists lead within tiers 0 and 1 only.
      : `SELECT id, title, movie, list, archived, network_url, tmdb_id, tmdb_type,
                CASE WHEN (${TV_GAP} OR poster_url IS NULL) AND ${NOT_TRIED_RECENTLY} THEN 0
                     WHEN ${HOT_UNFILLED} THEN 1
                     ELSE 2 END AS tier
          FROM shows
          WHERE ${tvWhere} AND (archived = 0 OR ${TV_GAP})
          ORDER BY tier,
                   CASE WHEN tier < 2 AND ${HOT_LIST} THEN 0 ELSE 1 END,
                   COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`;
    const tmdbStmt = showId
      ? env.DB.prepare(`SELECT id, title, movie, list, archived, network_url, tmdb_id, tmdb_type FROM shows
          WHERE movie = 0 AND id = ?`).bind(showId)
      : env.DB.prepare(tvSelect).bind(...tvBinds, maxTmdb);
    const { results: tmdbShows } = await tmdbStmt.all();
    tvCandidates = (tmdbShows || []).length;

    for (const show of tmdbShows) {
      // Two calls minimum per title (search + detail); don't start one we
      // can't finish.
      if (budgetLeft() < 3) { budgetExhausted = true; break; }
      try {
        // A stored tmdb_id is the row's identity — the member's exact
        // type-ahead pick, or a previously resolved lookup — so fetch that
        // entry directly. Re-guessing from the title is what used to swap a
        // picked remake for the more-popular original sharing the exact same
        // name (Little House on the Prairie, 2026-08): TMDB sorts by
        // popularity, both entries exact-match, and the next rotation
        // overwrote the pick. The title search remains only for rows with no
        // id yet, and for an id TMDB no longer serves.
        let tmdbId = (show.tmdb_id && show.tmdb_type !== 'movie') ? show.tmdb_id : null;
        let detail = null;
        if (tmdbId) {
          try {
            // append_to_response folds videos/providers/content-ratings (and
            // external_ids, for the title's IMDb id) into the one detail call
            // we already make — no extra subrequest budget.
            detail = await tmdbGet(
              `/tv/${tmdbId}?append_to_response=videos,watch/providers,content_ratings,credits,external_ids`, env);
          } catch (e) {
            // Only a dead id (the entry was removed) falls back to the title
            // search; rate limits and outages stay real errors for the outer
            // catch, so the row keeps its place in the queue and retries.
            if (!String(e && e.message).includes('TMDB 404')) throw e;
            tmdbId = null;
          }
        }
        if (!detail) {
          const first = await tmdbSearchFirst(show.title, 'tv', env);
          if (!first) {
            // Stamp enriched_at so a title TMDB can't match rotates to the back
            // of the oldest-first queue instead of blocking it every round. (A DB
            // write, not a fetch — it doesn't count against the subrequest cap.)
            // Every copy of the title, not just this row: the posters-mode batch
            // groups by title and sorts by the group's oldest stamp, so one
            // unstamped sibling would pin a hopeless title to the front forever.
            await env.DB.prepare(
              `UPDATE shows SET enriched_at = datetime('now')
                WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
            ).bind(show.id).run();
            continue;
          }
          tmdbId = first.id;
          detail = await tmdbGet(
            `/tv/${tmdbId}?append_to_response=videos,watch/providers,content_ratings,credits,external_ids`, env);
        }
        const df = extractTmdbDetailFields(detail, 'tv');
        const directorImdbId = await personImdbId(df.directorPersonId, env);

        // Check if series is complete
        const status = detail.status;
        const isComplete = (status === 'Ended' || status === 'Canceled') ? 1 : 0;

        // Extract genres
        const genres = (detail.genres || []).map(g => g.name).join(', ') || null;

        // Total seasons released so far (TMDB counts regular seasons, not
        // specials). Set for every TV show, regardless of list.
        const seasonsReleased = typeof detail.number_of_seasons === 'number'
          ? detail.number_of_seasons : null;

        // Poster (backfills existing TV shows as this pass rotates through them).
        const posterUrl = detail.poster_path
          ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : null;

        // Network logo (TMDB's primary network for the show).
        const netLogoPath = detail.networks && detail.networks[0] && detail.networks[0].logo_path;
        const networkLogoUrl = netLogoPath
          ? `https://image.tmdb.org/t/p/w154${netLogoPath}` : null;

        // Only get dates for watching/waiting lists — and not for an archived
        // row still carrying its old list, which would spend a season fetch on
        // a show the member has put away.
        let newDate = null;
        let endDate = null;
        if (!show.archived && (show.list === 'watching' || show.list === 'waiting')) {
          const nextEp = detail.next_episode_to_air;
          newDate = nextEp ? nextEp.air_date : null;

          if (nextEp) {
            try {
              const seasonData = await tmdbGet(`/tv/${tmdbId}/season/${nextEp.season_number}`, env);
              const eps = seasonData.episodes || [];
              if (eps.length > 0) {
                const lastEp = eps[eps.length - 1];
                if (lastEp.air_date) endDate = lastEp.air_date;
              }
            } catch (e) {}
          }
        }

        await env.DB.prepare(
          `UPDATE shows SET next_season_date = ?, season_end_date = ?, full_series = ?,
              genres = COALESCE(?, genres), seasons_released = COALESCE(?, seasons_released),
              poster_url = COALESCE(?, poster_url), network_logo_url = COALESCE(?, network_logo_url),
              overview = COALESCE(?, overview), backdrop_url = COALESCE(?, backdrop_url),
              tmdb_rating = COALESCE(?, tmdb_rating), rating = COALESCE(?, rating), content_rating = COALESCE(?, content_rating),
              trailer_key = COALESCE(?, trailer_key), director = COALESCE(?, director), director_imdb_id = COALESCE(?, director_imdb_id),
              runtime = COALESCE(?, runtime), release_year = COALESCE(?, release_year),
              network = COALESCE(network, ?), watch_link = COALESCE(?, watch_link),
              -- TMDB's current answer, refreshed authoritatively rather than
              -- filled once: unlike the network column beside it, this holds no
              -- member intent to protect, and its whole job is to be current.
              -- network stays fill-only, so the UI can show where a title
              -- streams now without discarding where the member says they
              -- watch it.
              streaming_on = ?,
              -- New-value-wins, same shape as seasons_released: a running
              -- series gains episodes and collects votes, so these have to
              -- converge rather than freeze at whatever the first pass saw.
              episodes_released = COALESCE(?, episodes_released),
              vote_count = COALESCE(?, vote_count),
              tagline = COALESCE(?, tagline),
              original_language = COALESCE(?, original_language),
              studio = COALESCE(?, studio),
              -- Migration 073. The IMDb id belongs to the entry just fetched,
              -- so the fresh one wins; status and free services are today's
              -- answer, refreshed every pass. All three keep the stored value
              -- when this payload had nothing.
              imdb_id = COALESCE(?, imdb_id), tmdb_status = COALESCE(?, tmdb_status),
              free_on = COALESCE(?, free_on),
              -- We just resolved this id to fetch the detail above, so persist
              -- it. Only shows.js (on insert) and the separate
              -- /api/admin-tmdb-backfill pass used to write tmdb_id, which left
              -- seeded rows NULL until someone remembered to run that endpoint;
              -- this pass had the answer in hand every time and dropped it.
              -- Fill-only: an id already stored (possibly a hand-corrected one)
              -- outranks whatever a title search turns up today.
              tmdb_id = COALESCE(tmdb_id, ?), tmdb_type = COALESCE(tmdb_type, 'tv'),
              enriched_at = datetime('now') WHERE id = ?`
        ).bind(newDate, endDate, isComplete, genres, seasonsReleased, posterUrl, networkLogoUrl,
          df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating, df.trailerKey, df.director, directorImdbId,
          df.runtime, df.releaseYear, fallbackNetwork(df), df.watchLink, streamingOn(df),
          df.episodesReleased, df.voteCount, df.tagline, df.originalLanguage, df.studio,
          df.imdbId, df.tmdbStatus, freeOn(df),
          tmdbId, show.id).run();
        // Catalog fields (artwork + the new detail fields) are the same for
        // every member's copy of a title, so push them to all copies in one
        // go rather than making each copy wait its own turn in the rotation.
        // Fill-only (COALESCE keeps anything already set). A DB write, not a
        // fetch, so it doesn't count against the subrequest budget.
        await env.DB.prepare(
          `UPDATE shows SET poster_url = COALESCE(poster_url, ?), network_logo_url = COALESCE(network_logo_url, ?),
              overview = COALESCE(overview, ?), backdrop_url = COALESCE(backdrop_url, ?),
              tmdb_rating = COALESCE(tmdb_rating, ?), rating = COALESCE(?, rating), content_rating = COALESCE(content_rating, ?),
              trailer_key = COALESCE(trailer_key, ?), director = COALESCE(director, ?), director_imdb_id = COALESCE(director_imdb_id, ?),
              runtime = COALESCE(runtime, ?), release_year = COALESCE(release_year, ?),
              genres = COALESCE(genres, ?), watch_link = COALESCE(watch_link, ?),
              -- Migration 063's fields are catalog-level like everything else
              -- here, so they propagate too. Without this a sibling copy would
              -- sit NULL until its own turn in the rotation came up, which for
              -- a title only one member is actively watching may be never.
              episodes_released = COALESCE(episodes_released, ?),
              vote_count = COALESCE(vote_count, ?),
              tagline = COALESCE(tagline, ?),
              original_language = COALESCE(original_language, ?),
              studio = COALESCE(studio, ?),
              -- Not fill-only, unlike everything above it: where a title
              -- streams is a fact about today, and a sibling copy holding last
              -- season's answer is exactly the staleness this column exists to
              -- fix. Same value for every copy, so it propagates like the rest.
              streaming_on = ?,
              -- Migration 073: catalog facts like the rest. Status and free
              -- services refresh like streaming_on; the IMDb id fills.
              imdb_id = COALESCE(imdb_id, ?), tmdb_status = COALESCE(?, tmdb_status),
              free_on = COALESCE(?, free_on),
              -- The id is the most catalog-level thing here: every member's
              -- copy of a title is the same TMDB entry. This is the half that
              -- reaches seeded rows — they're rarely the copy the rotation
              -- picks, so without it a seeded row keeps waiting for its own
              -- turn. (tmdb_id, tmdb_type) is the join key the cross-member
              -- rating pool uses, so a NULL here costs a member their share of
              -- the club's ratings on that title.
              tmdb_id = COALESCE(tmdb_id, ?), tmdb_type = COALESCE(tmdb_type, 'tv')
            WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)
              -- Same title, different pinned id = a different show (remake
              -- vs original) — its copies keep their own catalog data.
              AND (tmdb_id IS NULL OR tmdb_id = ?)`
        ).bind(posterUrl, networkLogoUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating,
          df.trailerKey, df.director, directorImdbId, df.runtime, df.releaseYear, genres, df.watchLink,
          df.episodesReleased, df.voteCount, df.tagline, df.originalLanguage, df.studio, streamingOn(df),
          df.imdbId, df.tmdbStatus, freeOn(df),
          tmdbId, show.id, tmdbId).run();

        // Cast comes free with the detail call we just made — this pass used
        // to ignore it entirely, which is why a title enriched here kept
        // whatever shallow cast it was first given. Only people we've never
        // resolved cost a request, and only while the budget holds.
        const castRows = await refreshCastFromDetail(env, show, detail, tmdbId);
        // The shared row, straight from this payload (docs/INVARIANTS.md §29).
        await writeTitle(env, 'tv', tmdbId, {
          name: detail.name,
          fields: titleFieldsFromEnrichment({ ...df, genres, seasonsReleased, posterUrl, directorImdbId, rating: df.tmdbRating }),
          cast: castRows,
        });
        tmdbUpdated++;
      } catch (e) {
        tvErrors++;
        if (!lastError) lastError = `tv:${show.title}: ${e && e.message ? e.message : String(e)}`;
      }
    }
  }

  // A logo sweep skips the TV pass above, but not the copy-to-copy artwork
  // sync it opens with: that propagates network_logo_url between copies of one
  // title with no requests at all, which is work no sweep should pay TMDB for.
  if (hasTmdb && logosOnly) await syncArtworkAcrossCopies(env);

  // Movie detail — the pass above is TV-only (movie = 0), so movies need their
  // own fetch (no seasons/dates/network logo apply to movies). Stamps
  // enriched_at either way so titles TMDB can't find rotate to the back
  // instead of blocking the queue.
  if (hasTmdb) {
    // This pass writes the whole detail block, so it has to select on the whole
    // of it. Gating it on `poster_url IS NULL OR network IS NULL` alone is what
    // left 91% of the movie library with no genres, overview or runtime up to
    // 1.4: a film inserts WITH a poster and a network (synchronous insert
    // enrichment sets both and neither path writes genres), so it never
    // qualified again — and unlike the TV pass, which cycles its whole library
    // by oldest enriched_at, no second path could reach it. `network` still
    // qualifies a row on its own because a rent/buy-only film inserts with
    // none and this is the only background path that can name the storefront.
    // Genres stand in for the rest of the detail block: overview, runtime,
    // tagline and studio all ride in the same response, so a row missing one
    // is missing all of them.
    const MOVIE_GAP = `(poster_url IS NULL OR network IS NULL
                        OR genres IS NULL OR genres = ''
                        -- NULL only until the first pass touches the row: this
                        -- statement always writes a value, empty string
                        -- included, so a film can never re-qualify on it. That
                        -- is what makes it safe here where the badge is not —
                        -- the badge can be permanently unobtainable, this
                        -- cannot. Without it films would never receive
                        -- streaming_on at all: the TV pass runs first and
                        -- spends the subrequest budget, so movies only ever
                        -- enter through this gate, and every other clause in
                        -- it is already satisfied across the library.
                        OR streaming_on IS NULL
                        OR NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id))`;
    // Posters mode keeps the narrow artwork gate — it exists to catch artwork
    // up in a small batch (max_tmdb 6), not to fill detail.
    // Movies mode rotates through every film, not just the incomplete ones —
    // mirroring the TV rotation, an archived film joins only while it has a
    // gap, since nobody is checking where a put-away film streams now.
    const mvGate = skipOmdb ? "(poster_url IS NULL OR network IS NULL)"
      : logosOnly ? "(network_logo_url IS NULL OR network_logo_url = '')"
      : moviesOnly ? `(archived = 0 OR ${MOVIE_GAP})`
      : MOVIE_GAP;
    let mvWhere = `movie = 1 AND ${mvGate}`;
    const mvBinds = [];
    if (member) { mvWhere += ` AND member_slug = ?`; mvBinds.push(member); }
    if (titles) { mvWhere += ` AND LOWER(title) IN (${titles.map(() => '?').join(',')})`; mvBinds.push(...titles); }
    // One row per (title, tmdb_id) — the fetch propagates to the copies that
    // share the identity, and the artwork sync above already filled anything
    // a sibling could cover. Grouping by id too keeps a remake pinned next to
    // its same-titled original from being answered by the wrong entry.
    const movieStmt = showId
      ? env.DB.prepare(`SELECT id, title, network, network_url, tmdb_id, tmdb_type FROM shows
          WHERE movie = 1 AND id = ?`).bind(showId)
      : env.DB.prepare(
      `SELECT id, title, network, network_url, tmdb_id, tmdb_type FROM shows WHERE ${mvWhere}
        GROUP BY LOWER(title), tmdb_id
        -- Gap-first, the same rule as the TV rotation (see NOT_TRIED_RECENTLY).
        -- Movies mode is the one that mixes complete and incomplete films;
        -- the gap modes select only incomplete ones, so there it changes
        -- nothing.
        --
        -- Then, as in the TV pass, a Watching or Next Up film still missing
        -- migration 073's fields, and hot lists first within those two tiers.
        ORDER BY MIN(CASE WHEN ${MOVIE_GAP} AND ${NOT_TRIED_RECENTLY} THEN 0
                          WHEN ${HOT_UNFILLED} THEN 1 ELSE 2 END),
                 MIN(CASE WHEN ${HOT_LIST} AND ((${MOVIE_GAP} AND ${NOT_TRIED_RECENTLY}) OR ${HOT_UNFILLED})
                          THEN 0 ELSE 1 END),
                 MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
    ).bind(...mvBinds, maxTmdb);
    const { results: movieShows } = await movieStmt.all();
    movieCandidates = (movieShows || []).length;

    for (const show of movieShows) {
      // Two calls minimum per title (search + detail); don't start one we
      // can't finish. The loop ran with no check at all while its selection
      // was nearly always empty — now that it has real work to do, an
      // unbounded run would spend straight past SUBREQUEST_BUDGET into
      // Cloudflare's own per-request ceiling and fail the whole endpoint.
      if (budgetLeft() < 3) { budgetExhausted = true; break; }
      try {
        // Same identity rule as the TV pass: a stored tmdb_id is fetched
        // directly, and the title search only serves rows with no id (or a
        // dead one) — so a picked rerelease can't be re-resolved to the
        // more-popular original film of the same name.
        let tmdbId = (show.tmdb_id && show.tmdb_type !== 'tv') ? show.tmdb_id : null;
        let detail = null;
        let searchPoster = null;
        if (tmdbId) {
          try {
            detail = await tmdbGet(
              `/movie/${tmdbId}?append_to_response=videos,watch/providers,release_dates,credits`, env);
          } catch (e) {
            if (!String(e && e.message).includes('TMDB 404')) throw e;
            tmdbId = null;
          }
        }
        if (!detail) {
          const first = await tmdbSearchFirst(show.title, 'movie', env);
          if (!first) {
            // No match — stamp so the title rotates to the back instead of
            // pinning the front of the grouped-by-title queue.
            await env.DB.prepare(
              `UPDATE shows SET enriched_at = datetime('now')
                WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
            ).bind(show.id).run();
            continue;
          }
          tmdbId = first.id;
          searchPoster = first.poster_path;
          // One detail call (append folds in videos/providers/release_dates/credits)
          // gets the poster AND the rich fields — same subrequest budget as before
          // plus this single GET per matched movie.
          detail = await tmdbGet(
            `/movie/${tmdbId}?append_to_response=videos,watch/providers,release_dates,credits`, env);
        }
        const df = extractTmdbDetailFields(detail, 'movie');
        // The badge must be the logo of the network this row actually shows.
        // A film's stored network is often the member's own answer, or an
        // older one, and need not be TMDB's highest-priority provider — so
        // pick the provider matching it, and fall back to the primary only
        // for a row with no network yet (which this same statement is about
        // to set to that provider, so the two agree by construction). No
        // match means no badge: a logo that contradicts the label is worse
        // than a blank.
        // Look the badge up under the CANONICAL name (providerLogos is keyed
        // that way) but match rows on the string they actually store: a
        // legacy row can hold "Max" where the table says "HBO Max", and the
        // UPDATE below compares the column, not its canonical form.
        const canonNet = show.network ? canonicalNetwork(show.network) : null;
        const badgeNetwork = show.network || df.providerNetwork || null;
        const badgeLogoUrl = show.network
          ? (canonNet ? df.providerLogos[canonNet] || null : null)
          : (df.providerLogoUrl || null);
        const directorImdbId = await personImdbId(df.directorPersonId, env);
        const posterPath = detail.poster_path || searchPoster;
        const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
        const genres = (detail.genres || []).map(g => g.name).join(', ') || null;
        // Title-scoped: fills every member's copy in one go (fill-only COALESCE,
        // except rating which converges to the fresh TMDB score), and stamps
        // enriched_at on all of them so the title rotates evenly.
        await env.DB.prepare(
          `UPDATE shows SET poster_url = COALESCE(?, poster_url),
              -- The service badge. TV takes it from detail.networks[0]; a movie
              -- has no networks[], so it comes off the flatrate provider that
              -- matches this row's network. Scoped to copies that actually
              -- show that network: this statement spans every copy of the
              -- title, and two members can hold one film under two different
              -- services. Fill-only, like the rest.
              network_logo_url = CASE
                WHEN network IS NULL OR network = ? THEN COALESCE(network_logo_url, ?)
                ELSE network_logo_url END,
              overview = COALESCE(overview, ?), backdrop_url = COALESCE(backdrop_url, ?),
              tmdb_rating = COALESCE(tmdb_rating, ?), rating = COALESCE(?, rating), content_rating = COALESCE(content_rating, ?),
              trailer_key = COALESCE(trailer_key, ?), director = COALESCE(director, ?), director_imdb_id = COALESCE(director_imdb_id, ?),
              runtime = COALESCE(runtime, ?), release_year = COALESCE(release_year, ?),
              genres = COALESCE(genres, ?), network = COALESCE(network, ?),
              watch_link = COALESCE(watch_link, ?),
              -- TMDB's current answer, refreshed authoritatively rather than
              -- filled once: unlike the network column beside it, this holds no
              -- member intent to protect, and its whole job is to be current.
              -- network stays fill-only, so the UI can show where a title
              -- streams now without discarding where the member says they
              -- watch it.
              streaming_on = ?,
              -- vote_count converges like rating does (a film keeps collecting
              -- votes); the rest are fill-only, matching this statement's
              -- prevailing shape. A movie has no episode count.
              vote_count = COALESCE(?, vote_count),
              tagline = COALESCE(tagline, ?),
              original_language = COALESCE(original_language, ?),
              studio = COALESCE(studio, ?),
              -- Migration 073, same rules as the TV pass.
              imdb_id = COALESCE(imdb_id, ?), tmdb_status = COALESCE(?, tmdb_status),
              free_on = COALESCE(?, free_on),
              -- Same as the TV pass: the id we just searched for is worth
              -- keeping, and this statement is already title-scoped so every
              -- copy gets it. Fill-only, so a corrected id is never clobbered.
              tmdb_id = COALESCE(tmdb_id, ?), tmdb_type = COALESCE(tmdb_type, 'movie'),
              enriched_at = datetime('now')
            WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)
              -- Copies pinned to a different id are a different film that
              -- shares the title — they get their own turn, not this data.
              AND (tmdb_id IS NULL OR tmdb_id = ?)`
        ).bind(posterUrl, badgeNetwork, badgeLogoUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating, df.trailerKey,
          df.director, directorImdbId, df.runtime, df.releaseYear, genres, fallbackNetwork(df), df.watchLink, streamingOn(df),
          df.voteCount, df.tagline, df.originalLanguage, df.studio,
          df.imdbId, df.tmdbStatus, freeOn(df),
          tmdbId, show.id, tmdbId).run();
        // The detail call already carried credits, and MOVIE_GAP selects a film
        // for missing cast — but this pass never wrote any, so a castless film
        // (an archived one imported bare, say) re-qualified every round and
        // stayed out of Favorite Actors for good. Same helper as the TV pass.
        const castRows = await refreshCastFromDetail(env, show, detail, tmdbId);
        await writeTitle(env, 'movie', tmdbId, {
          name: detail.title,
          fields: titleFieldsFromEnrichment({ ...df, genres, posterUrl, directorImdbId, rating: df.tmdbRating }),
          cast: castRows,
        });
        if (posterUrl) tmdbUpdated++;
      } catch (e) {
        movieErrors++;
        if (!lastError) lastError = `movie:${show.title}: ${e && e.message ? e.message : String(e)}`;
      }
    }
  }

  // Free pass first: link actor rows to people we already resolved on some
  // other show. Pure SQL, no TMDB requests, so it runs every call and takes
  // the easy half of the backlog before the metered pass below spends any
  // budget on it.
  const actorIdsFromCache = await fillActorIdsFromKnownPeople(env);

  // Actor IMDB-id backfill — self-healing, no admin action required.
  // imdb_id is only ever written by the TMDB enrichment path (at add/edit time).
  // Shows added before that path existed, or via a legacy path that omitted it
  // (share, suggestions), keep actor rows with imdb_id = NULL, so their names
  // render as plain non-clickable tags. Re-run the TMDB enrichment for any show
  // that still has null-id actors and refresh its cast. We propagate by title
  // so a single lookup fixes every member's copy at once — including the oldest
  // copy the home page surfaces via /api/popular's MIN(id). Gated on TMDB_TOKEN.
  //
  // Every title here is a full fetchEnrichment — a fresh search + detail plus
  // a person lookup for each cast member we haven't resolved before, so up to
  // CAST_DEPTH + 2 subrequests each. That is as heavy as the TV pass above,
  // and it used to run its fixed 8 titles on top of whatever that pass had
  // already spent, charged to nothing: a round told to stay small (max_tmdb:6,
  // which is what the slow backfill workflow sends) was never actually small,
  // and a default round blew straight through SUBREQUEST_BUDGET into the real
  // Cloudflare ceiling — where the fetches throw, the empty catch below hides
  // it, and a long run of such rounds is what eventually comes back as a 503
  // (`error code: 1102`, the worker hitting its resource limit). So charge it
  // to the same budget and let it take only the titles that fit. The pass is
  // self-healing and rotates most-recently-touched first, so a round it sits
  // out costs nothing but a later turn — and the free cache pass above, which
  // takes the easy half of the same backlog, still runs on every call.
  const ACTOR_TITLE_COST = CAST_DEPTH + 2;
  let actorImdbFilled = 0;
  if (env.TMDB_TOKEN && !skipActors) {
    // Scale with the batch size the caller asked for, so shrinking a round
    // shrinks all of it rather than just its first half.
    const actorDefault = Number.isFinite(maxTmdb) ? Math.min(8, Math.max(1, maxTmdb)) : 8;
    const maxActorImdb = parseInt(body.max_actor_imdb ?? String(actorDefault), 10);
    // Grouped by (title, tmdb_id) like the passes above, so a pinned remake
    // and its same-titled original each refresh from their own entry.
    const backfillBase = `SELECT s.title, MAX(s.movie) AS movie, s.tmdb_id, MAX(s.tmdb_type) AS tmdb_type
       FROM shows s
       WHERE EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id AND a.imdb_id IS NULL)`;
    const backfillStmt = member
      ? env.DB.prepare(`${backfillBase} AND s.member_slug = ? GROUP BY LOWER(s.title), s.tmdb_id ORDER BY MAX(COALESCE(s.updated_at, s.created_at)) DESC LIMIT ?`).bind(member, maxActorImdb)
      : env.DB.prepare(`${backfillBase} GROUP BY LOWER(s.title), s.tmdb_id ORDER BY MAX(COALESCE(s.updated_at, s.created_at)) DESC LIMIT ?`).bind(maxActorImdb);
    const { results: backfillShows } = await backfillStmt.all();

    // fetchEnrichment does its own fetching and doesn't touch `spent`, so
    // charge it here as an upper bound rather than mutating the true
    // subrequest count the response reports.
    let actorSpend = 0;
    for (const show of backfillShows) {
      if (budgetLeft() - actorSpend < ACTOR_TITLE_COST) { budgetExhausted = true; break; }
      actorSpend += ACTOR_TITLE_COST;
      try {
        // A stored tmdb_id is enriched directly (the pick is the identity);
        // the title search only covers rows nothing ever pinned.
        const result = show.tmdb_id
          ? await fetchEnrichmentById(show.tmdb_id, show.tmdb_type || (show.movie ? 'movie' : 'tv'), env)
          : await fetchEnrichment(show.title, env, !!show.movie);
        const actors = result.actors || [];
        // Only act when TMDB actually returned IMDB ids. If it found nothing
        // (all ids null), leave the existing cast untouched.
        if (!actors.some(a => a.imdb_id)) continue;

        // Guard on the entry this cast actually came from — for a NULL-id
        // group that's whatever the title search resolved to, and a sibling
        // pinned to a different entry keeps its own cast either way.
        const castFromId = result.tmdbId ?? show.tmdb_id ?? null;
        const { results: copies } = await env.DB.prepare(
          `SELECT id FROM shows WHERE LOWER(title) = LOWER(?)
             AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
        ).bind(show.title, castFromId, castFromId).all();
        const insert = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id, character_name) VALUES (?, ?, ?, ?, ?, ?)');
        for (const copy of copies) {
          await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
          await env.DB.batch(actors.map((a, i) => insert.bind(copy.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null, a.character ?? null)));
          actorImdbFilled++;
        }
        // The shared cast members read (actors_v) gets the newly linked names.
        if (castFromId) {
          await writeTitle(env, result.tmdbType || show.tmdb_type || (show.movie ? 'movie' : 'tv'), castFromId, {
            name: result.canonicalTitle, fields: titleFieldsFromEnrichment(result), cast: actors,
          });
        }
      } catch (e) {}
    }
  }

  // How many titles still hold no data. Counted DISTINCT by title to match
  // what the passes above consume (one fetch per title, propagated to copies),
  // so a caller looping until this hits zero is counting the same units it is
  // working through. Only computed in gaps mode — it's two extra scans.
  let remaining = null;
  if (gapsOnly) {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT LOWER(title)) FROM shows
           WHERE movie = 0
             AND (NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id)
                  OR episodes_released IS NULL)) AS tv,
         (SELECT COUNT(DISTINCT LOWER(title)) FROM shows
           WHERE movie = 1
             AND (poster_url IS NULL OR network IS NULL
                  OR genres IS NULL OR genres = ''
                  OR NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id))) AS movies`
    ).first().catch(() => null);
    remaining = row ? { tv: row.tv, movies: row.movies, total: row.tv + row.movies } : null;
  } else if (logosOnly) {
    // Same contract as gaps mode, so the same driver script can run this to
    // ground: how many titles the sweep still considers outstanding. Note this
    // counts films a sweep may never be able to fill (a rent/buy-only film has
    // no provider logo), so a caller must stop on a count that stops falling
    // rather than on one that reaches zero.
    const row = await env.DB.prepare(
      `SELECT COUNT(DISTINCT LOWER(title)) AS movies FROM shows
        WHERE movie = 1
          AND (network_logo_url IS NULL OR network_logo_url = '')`
    ).first().catch(() => null);
    remaining = row ? { tv: 0, movies: row.movies, total: row.movies } : null;
  }

  // tvCandidates/movieCandidates say whether a zero means "nothing to do" or
  // "nothing worked" — the two used to be indistinguishable from outside.
  return new Response(JSON.stringify({
    enriched, tmdbUpdated, actorImdbFilled, actorIdsFromCache,
    tvCandidates, movieCandidates, tvErrors, movieErrors, lastError,
    budgetExhausted, subrequests: spent, remaining,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

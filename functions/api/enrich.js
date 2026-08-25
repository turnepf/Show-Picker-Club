import { getSession } from '../_shared/auth.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { fetchEnrichment, fetchEnrichmentById, extractTmdbDetailFields, fallbackNetwork, dedupeCast, CAST_DEPTH, pickBestMatch, titleSearchTerms } from '../_shared/enrichment.js';
import { fillActorIdsFromKnownPeople, knownByPersonIds, rememberPeople } from '../_shared/people.js';

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
  if (!cast.length) return;
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
    rows.push({ name: person.name, imdb_id: imdbId, ord: i, tmdb_person_id: person.id });
  }
  await rememberPeople(env, people).catch(() => {});

  const { results: copies } = await env.DB.prepare(
    `SELECT id FROM shows
      WHERE LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?) AND archived = 0
        AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
  ).bind(show.id, tmdbId ?? null, tmdbId ?? null).all();
  const insert = env.DB.prepare(
    'INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)'
  );
  for (const copy of copies || []) {
    // Replace rather than merge: the incoming list is authoritative and
    // ordered, and a partial overlay would leave the old shallow tail behind.
    await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
    await env.DB.batch(rows.map(r => insert.bind(copy.id, r.name, r.imdb_id, r.ord, r.tmdb_person_id)));
  }
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
           AND s2.archived = 0 AND s2.poster_url IS NOT NULL LIMIT 1)
      WHERE archived = 0 AND poster_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
                       AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
                       AND s2.archived = 0 AND s2.poster_url IS NOT NULL)`
  ).run();
  await env.DB.prepare(
    `UPDATE shows SET network_logo_url = (
        SELECT s2.network_logo_url FROM shows s2
         WHERE LOWER(s2.title) = LOWER(shows.title)
           AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
           AND s2.archived = 0 AND s2.network_logo_url IS NOT NULL LIMIT 1)
      WHERE archived = 0 AND network_logo_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
                       AND (s2.tmdb_id IS NULL OR shows.tmdb_id IS NULL OR s2.tmdb_id = shows.tmdb_id)
                       AND s2.archived = 0 AND s2.network_logo_url IS NOT NULL)`
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
  const member = body.member || null;
  // Cloudflare's subrequest ceiling still bounds a single invocation, so the
  // heavy TMDB detail passes and the cheap poster catch-up stay separable.
  // `mode: 'posters'` (or skip_omdb/skip_actors) runs only the small poster
  // batch so an artwork backfill fits comfortably within budget. (`skip_omdb`
  // is kept as an alias now that OMDB is gone — it still selects posters-only.)
  const skipOmdb = body.skip_omdb === true || body.mode === 'posters';
  const skipActors = body.skip_actors === true || body.mode === 'posters';
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
  if (hasTmdb) {
    // Cover everything a sibling copy already covers before spending budget.
    await syncArtworkAcrossCopies(env);

    let tvWhere = `archived = 0 AND movie = 0`;
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
      ? `SELECT id, title, movie, list, network_url, tmdb_id, tmdb_type FROM shows
          WHERE ${tvWhere} AND poster_url IS NULL
          GROUP BY LOWER(title), tmdb_id
          ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
      : gapsOnly
      ? `SELECT id, title, movie, list, network_url, tmdb_id, tmdb_type FROM shows
          WHERE ${tvWhere} AND ${TV_GAP}
          GROUP BY LOWER(title), tmdb_id
          ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
      : `SELECT id, title, movie, list, network_url, tmdb_id, tmdb_type FROM shows
          WHERE ${tvWhere}
          ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`;
    const tmdbStmt = env.DB.prepare(tvSelect).bind(...tvBinds, maxTmdb);
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
            // append_to_response folds videos/providers/content-ratings into
            // the one detail call we already make — no extra subrequest budget.
            detail = await tmdbGet(
              `/tv/${tmdbId}?append_to_response=videos,watch/providers,content_ratings,credits`, env);
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
                WHERE archived = 0
                  AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
            ).bind(show.id).run();
            continue;
          }
          tmdbId = first.id;
          detail = await tmdbGet(
            `/tv/${tmdbId}?append_to_response=videos,watch/providers,content_ratings,credits`, env);
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

        // Only get dates for watching/waiting lists
        let newDate = null;
        let endDate = null;
        if (show.list === 'watching' || show.list === 'waiting') {
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
              -- New-value-wins, same shape as seasons_released: a running
              -- series gains episodes and collects votes, so these have to
              -- converge rather than freeze at whatever the first pass saw.
              episodes_released = COALESCE(?, episodes_released),
              vote_count = COALESCE(?, vote_count),
              tagline = COALESCE(?, tagline),
              original_language = COALESCE(?, original_language),
              studio = COALESCE(?, studio),
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
          df.runtime, df.releaseYear, fallbackNetwork(df), df.watchLink,
          df.episodesReleased, df.voteCount, df.tagline, df.originalLanguage, df.studio,
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
              -- The id is the most catalog-level thing here: every member's
              -- copy of a title is the same TMDB entry. This is the half that
              -- reaches seeded rows — they're rarely the copy the rotation
              -- picks, so without it a seeded row keeps waiting for its own
              -- turn. (tmdb_id, tmdb_type) is the join key the cross-member
              -- rating pool uses, so a NULL here costs a member their share of
              -- the club's ratings on that title.
              tmdb_id = COALESCE(tmdb_id, ?), tmdb_type = COALESCE(tmdb_type, 'tv')
            WHERE archived = 0
              AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)
              -- Same title, different pinned id = a different show (remake
              -- vs original) — its copies keep their own catalog data.
              AND (tmdb_id IS NULL OR tmdb_id = ?)`
        ).bind(posterUrl, networkLogoUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating,
          df.trailerKey, df.director, directorImdbId, df.runtime, df.releaseYear, genres, df.watchLink,
          df.episodesReleased, df.voteCount, df.tagline, df.originalLanguage, df.studio,
          tmdbId, show.id, tmdbId).run();

        // Cast comes free with the detail call we just made — this pass used
        // to ignore it entirely, which is why a title enriched here kept
        // whatever shallow cast it was first given. Only people we've never
        // resolved cost a request, and only while the budget holds.
        await refreshCastFromDetail(env, show, detail, tmdbId);
        tmdbUpdated++;
      } catch (e) {
        tvErrors++;
        if (!lastError) lastError = `tv:${show.title}: ${e && e.message ? e.message : String(e)}`;
      }
    }
  }

  // Movie posters — the pass above is TV-only (movie = 0), so movies need their
  // own poster fetch (no seasons/dates/network logo apply to movies). Only
  // touches movies still missing a poster or a network; stamps enriched_at
  // either way so titles TMDB can't find rotate to the back instead of
  // blocking the queue.
  if (hasTmdb) {
    // Normally this pass is a poster/platform top-up — network qualifies a row
    // because a rent/buy-only movie inserts with none, and this pass is the
    // only background path that can fill it (fallbackNetwork names the
    // storefront). In gaps mode it's the cast that matters, so a film with
    // artwork but no cast still qualifies.
    let mvWhere = gapsOnly
      ? `archived = 0 AND movie = 1
         AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id)`
      : `archived = 0 AND movie = 1 AND (poster_url IS NULL OR network IS NULL)`;
    const mvBinds = [];
    if (member) { mvWhere += ` AND member_slug = ?`; mvBinds.push(member); }
    if (titles) { mvWhere += ` AND LOWER(title) IN (${titles.map(() => '?').join(',')})`; mvBinds.push(...titles); }
    // One row per (title, tmdb_id) — the fetch propagates to the copies that
    // share the identity, and the artwork sync above already filled anything
    // a sibling could cover. Grouping by id too keeps a remake pinned next to
    // its same-titled original from being answered by the wrong entry.
    const movieStmt = env.DB.prepare(
      `SELECT id, title, network_url, tmdb_id, tmdb_type FROM shows WHERE ${mvWhere}
        GROUP BY LOWER(title), tmdb_id
        ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
    ).bind(...mvBinds, maxTmdb);
    const { results: movieShows } = await movieStmt.all();
    movieCandidates = (movieShows || []).length;

    for (const show of movieShows) {
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
                WHERE archived = 0 AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
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
        const directorImdbId = await personImdbId(df.directorPersonId, env);
        const posterPath = detail.poster_path || searchPoster;
        const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
        const genres = (detail.genres || []).map(g => g.name).join(', ') || null;
        // Title-scoped: fills every member's copy in one go (fill-only COALESCE,
        // except rating which converges to the fresh TMDB score), and stamps
        // enriched_at on all of them so the title rotates evenly.
        await env.DB.prepare(
          `UPDATE shows SET poster_url = COALESCE(?, poster_url),
              overview = COALESCE(overview, ?), backdrop_url = COALESCE(backdrop_url, ?),
              tmdb_rating = COALESCE(tmdb_rating, ?), rating = COALESCE(?, rating), content_rating = COALESCE(content_rating, ?),
              trailer_key = COALESCE(trailer_key, ?), director = COALESCE(director, ?), director_imdb_id = COALESCE(director_imdb_id, ?),
              runtime = COALESCE(runtime, ?), release_year = COALESCE(release_year, ?),
              genres = COALESCE(genres, ?), network = COALESCE(network, ?),
              watch_link = COALESCE(watch_link, ?),
              -- vote_count converges like rating does (a film keeps collecting
              -- votes); the rest are fill-only, matching this statement's
              -- prevailing shape. A movie has no episode count.
              vote_count = COALESCE(?, vote_count),
              tagline = COALESCE(tagline, ?),
              original_language = COALESCE(original_language, ?),
              studio = COALESCE(studio, ?),
              -- Same as the TV pass: the id we just searched for is worth
              -- keeping, and this statement is already title-scoped so every
              -- copy gets it. Fill-only, so a corrected id is never clobbered.
              tmdb_id = COALESCE(tmdb_id, ?), tmdb_type = COALESCE(tmdb_type, 'movie'),
              enriched_at = datetime('now')
            WHERE archived = 0
              AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)
              -- Copies pinned to a different id are a different film that
              -- shares the title — they get their own turn, not this data.
              AND (tmdb_id IS NULL OR tmdb_id = ?)`
        ).bind(posterUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating, df.trailerKey,
          df.director, directorImdbId, df.runtime, df.releaseYear, genres, fallbackNetwork(df), df.watchLink,
          df.voteCount, df.tagline, df.originalLanguage, df.studio,
          tmdbId, show.id, tmdbId).run();
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
       WHERE s.archived = 0
         AND EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id AND a.imdb_id IS NULL)`;
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
          `SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND archived = 0
             AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)`
        ).bind(show.title, castFromId, castFromId).all();
        const insert = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
        for (const copy of copies) {
          await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
          await env.DB.batch(actors.map((a, i) => insert.bind(copy.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
          actorImdbFilled++;
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
           WHERE archived = 0 AND movie = 0
             AND (NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id)
                  OR episodes_released IS NULL)) AS tv,
         (SELECT COUNT(DISTINCT LOWER(title)) FROM shows
           WHERE archived = 0 AND movie = 1
             AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = shows.id)) AS movies`
    ).first().catch(() => null);
    remaining = row ? { tv: row.tv, movies: row.movies, total: row.tv + row.movies } : null;
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

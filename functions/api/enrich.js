import { getSession } from '../_shared/auth.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { fetchEnrichment, extractTmdbDetailFields } from '../_shared/enrichment.js';
import { fillActorIdsFromKnownPeople } from '../_shared/people.js';

// TMDB GET that works with either credential the worker has configured:
// the v4 Bearer token (TMDB_TOKEN, what the shared enrichment path uses) is
// preferred, falling back to a v3 api_key query param (TMDB_API_KEY). The
// poster passes below originally required TMDB_API_KEY only — if a deployment
// sets just TMDB_TOKEN, those passes silently no-op'd (tmdbUpdated stayed 0).
async function tmdbGet(path, env) {
  const token = env.TMDB_TOKEN;
  const sep = path.includes('?') ? '&' : '?';
  if (token) {
    const res = await fetch(`https://api.themoviedb.org/3${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return res.json();
  }
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${env.TMDB_API_KEY}`);
  return res.json();
}

// Best TMDB result for the title (or null). type is 'tv' | 'movie'.
//
// TMDB sorts search results by popularity, not title match, so a popular
// spin-off outranks the exact-title original it was named after — a search for
// "Below Deck" returns the more-popular "Below Deck Mediterranean" first, and
// blindly taking results[0] pins the wrong poster on the original. So prefer a
// result whose title matches the query exactly (case-insensitive); only fall
// back to the first (most-popular) result when nothing matches exactly.
function tmdbResultTitle(r, type) {
  return ((type === 'movie' ? r.title : r.name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
async function tmdbSearchFirst(title, type, env) {
  try {
    const data = await tmdbGet(`/search/${type}?query=${encodeURIComponent(title)}`, env);
    const results = (data && data.results) || [];
    if (!results.length) return null;
    const want = title.replace(/\s+/g, ' ').trim().toLowerCase();
    return results.find((r) => tmdbResultTitle(r, type) === want) || results[0];
  } catch (e) {
    return null;
  }
}

// Fill missing artwork from sibling copies of the same title — a poster
// fetched for one member's copy covers everyone's, so no TMDB budget should
// ever be spent on a title that already has artwork somewhere. Pure DB work,
// zero subrequests. (New fetches also propagate at write time; this sweep
// catches the backlog from before that existed.)
async function syncArtworkAcrossCopies(env) {
  await env.DB.prepare(
    `UPDATE shows SET poster_url = (
        SELECT s2.poster_url FROM shows s2
         WHERE LOWER(s2.title) = LOWER(shows.title)
           AND s2.archived = 0 AND s2.poster_url IS NOT NULL LIMIT 1)
      WHERE archived = 0 AND poster_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
                       AND s2.archived = 0 AND s2.poster_url IS NOT NULL)`
  ).run();
  await env.DB.prepare(
    `UPDATE shows SET network_logo_url = (
        SELECT s2.network_logo_url FROM shows s2
         WHERE LOWER(s2.title) = LOWER(shows.title)
           AND s2.archived = 0 AND s2.network_logo_url IS NOT NULL LIMIT 1)
      WHERE archived = 0 AND network_logo_url IS NULL
        AND EXISTS (SELECT 1 FROM shows s2
                     WHERE LOWER(s2.title) = LOWER(shows.title)
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
  let tmdbUpdated = 0;
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
    const tvSelect = skipOmdb
      ? `SELECT id, title, movie, list, network_url FROM shows
          WHERE ${tvWhere} AND poster_url IS NULL
          GROUP BY LOWER(title)
          ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
      : `SELECT id, title, movie, list, network_url FROM shows
          WHERE ${tvWhere}
          ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`;
    const tmdbStmt = env.DB.prepare(tvSelect).bind(...tvBinds, maxTmdb);
    const { results: tmdbShows } = await tmdbStmt.all();

    for (const show of tmdbShows) {
      try {
        // Search TMDB for the show by its stored title.
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

        const tmdbId = first.id;
        // append_to_response folds videos/providers/content-ratings into the
        // one detail call we already make — no extra subrequest budget.
        const detail = await tmdbGet(
          `/tv/${tmdbId}?append_to_response=videos,watch/providers,content_ratings,credits`, env);
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
              enriched_at = datetime('now') WHERE id = ?`
        ).bind(newDate, endDate, isComplete, genres, seasonsReleased, posterUrl, networkLogoUrl,
          df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating, df.trailerKey, df.director, directorImdbId,
          df.runtime, df.releaseYear, df.providerNetwork, df.watchLink, show.id).run();
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
              genres = COALESCE(genres, ?), watch_link = COALESCE(watch_link, ?)
            WHERE archived = 0
              AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
        ).bind(posterUrl, networkLogoUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating,
          df.trailerKey, df.director, directorImdbId, df.runtime, df.releaseYear, genres, df.watchLink, show.id).run();
        tmdbUpdated++;
      } catch (e) {}
    }
  }

  // Movie posters — the pass above is TV-only (movie = 0), so movies need their
  // own poster fetch (no seasons/dates/network logo apply to movies). Only
  // touches movies that still lack a poster; stamps enriched_at either way so
  // titles TMDB can't find rotate to the back instead of blocking the queue.
  if (hasTmdb) {
    let mvWhere = `archived = 0 AND movie = 1 AND poster_url IS NULL`;
    const mvBinds = [];
    if (member) { mvWhere += ` AND member_slug = ?`; mvBinds.push(member); }
    if (titles) { mvWhere += ` AND LOWER(title) IN (${titles.map(() => '?').join(',')})`; mvBinds.push(...titles); }
    // One row per title — the fetch propagates to every copy, and the artwork
    // sync above already filled anything a sibling could cover.
    const movieStmt = env.DB.prepare(
      `SELECT id, title, network_url FROM shows WHERE ${mvWhere}
        GROUP BY LOWER(title)
        ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC LIMIT ?`
    ).bind(...mvBinds, maxTmdb);
    const { results: movieShows } = await movieStmt.all();

    for (const show of movieShows) {
      try {
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
        // One detail call (append folds in videos/providers/release_dates/credits)
        // gets the poster AND the rich fields — same subrequest budget as before
        // plus this single GET per matched movie.
        const detail = await tmdbGet(
          `/movie/${first.id}?append_to_response=videos,watch/providers,release_dates,credits`, env);
        const df = extractTmdbDetailFields(detail, 'movie');
        const directorImdbId = await personImdbId(df.directorPersonId, env);
        const posterPath = detail.poster_path || first.poster_path;
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
              watch_link = COALESCE(watch_link, ?), enriched_at = datetime('now')
            WHERE archived = 0
              AND LOWER(title) = (SELECT LOWER(title) FROM shows WHERE id = ?)`
        ).bind(posterUrl, df.overview, df.backdropUrl, df.tmdbRating, df.tmdbRating, df.contentRating, df.trailerKey,
          df.director, directorImdbId, df.runtime, df.releaseYear, genres, df.providerNetwork, df.watchLink, show.id).run();
        if (posterUrl) tmdbUpdated++;
      } catch (e) {}
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
  let actorImdbFilled = 0;
  if (env.TMDB_TOKEN && !skipActors) {
    const maxActorImdb = parseInt(body.max_actor_imdb ?? '8', 10);
    const backfillBase = `SELECT s.title, MAX(s.movie) AS movie
       FROM shows s
       WHERE s.archived = 0
         AND EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id AND a.imdb_id IS NULL)`;
    const backfillStmt = member
      ? env.DB.prepare(`${backfillBase} AND s.member_slug = ? GROUP BY LOWER(s.title) ORDER BY MAX(COALESCE(s.updated_at, s.created_at)) DESC LIMIT ?`).bind(member, maxActorImdb)
      : env.DB.prepare(`${backfillBase} GROUP BY LOWER(s.title) ORDER BY MAX(COALESCE(s.updated_at, s.created_at)) DESC LIMIT ?`).bind(maxActorImdb);
    const { results: backfillShows } = await backfillStmt.all();

    for (const show of backfillShows) {
      try {
        const result = await fetchEnrichment(show.title, env, !!show.movie);
        const actors = result.actors || [];
        // Only act when TMDB actually returned IMDB ids. If it found nothing
        // (all ids null), leave the existing cast untouched.
        if (!actors.some(a => a.imdb_id)) continue;

        const { results: copies } = await env.DB.prepare(
          'SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND archived = 0'
        ).bind(show.title).all();
        const insert = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
        for (const copy of copies) {
          await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
          await env.DB.batch(actors.map((a, i) => insert.bind(copy.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
          actorImdbFilled++;
        }
      } catch (e) {}
    }
  }

  return new Response(JSON.stringify({ enriched, tmdbUpdated, actorImdbFilled, actorIdsFromCache }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

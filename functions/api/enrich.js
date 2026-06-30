import { getSession } from '../_shared/auth.js';
import { fetchEnrichment } from '../_shared/enrichment.js';

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

// Networks with `param` pass the show name in the search URL query string.
// Networks without `param` just link to the search page (no show name).
const NETWORK_SEARCH = {
  // These pass the show name in the search query:
  'HBO': { base: 'https://play.max.com/search', param: 'q' },
  'Apple TV': { base: 'https://tv.apple.com/search', param: 'term' },
  'Amazon': { base: 'https://www.amazon.com/s', param: 'k', extra: 'i=instant-video' },
  'Starz': { base: 'https://www.starz.com/search', param: 'q' },
  'Showtime': { base: 'https://www.sho.com/search', param: 'q' },
  // These just link to the search page (no query param support):
  'Netflix': { base: 'https://www.netflix.com/search' },
  'Hulu': { base: 'https://www.hulu.com/search' },
  'Paramount': { base: 'https://www.paramountplus.com/search' },
  'Peacock': { base: 'https://www.peacocktv.com/watch/search' },
  'Bravo': { base: 'https://www.peacocktv.com/watch/search' },
  'Disney+': { base: 'https://www.disneyplus.com/browse/search' },
  'NBC': { base: 'https://www.nbc.com/search' },
  'CBS': { base: 'https://www.cbs.com/shows/' },
  'USA': { base: 'https://www.peacocktv.com/watch/search' },
  'National Geographic': { base: 'https://www.nationalgeographic.com/tv/shows' },
  'Food Network': { base: 'https://www.foodnetwork.com/search', param: 'q' },
  'Fox': { base: 'https://www.fox.com/search' },
  'BritBox': { base: 'https://www.britbox.com/us/search' },
};

function generateSearchUrl(network, title) {
  if (!network) return null;
  const cfg = NETWORK_SEARCH[network];
  if (!cfg) return null;
  if (!cfg.param) return cfg.base;
  const params = new URLSearchParams();
  if (cfg.extra) cfg.extra.split('&').forEach(p => { const [k,v] = p.split('='); params.set(k,v); });
  params.set(cfg.param, title);
  return cfg.base + '?' + params.toString();
}

async function tryOMDB(title, apiKey, type) {
  try {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`;
    if (type) url += `&type=${type}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.Response === 'True') {
      return {
        canonicalTitle: data.Title,
        rating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
        actors: data.Actors && data.Actors !== 'N/A' ? data.Actors.split(', ') : [],
      };
    }
  } catch (e) {}
  return null;
}

async function searchOMDB(title, apiKey, type) {
  try {
    let url = `https://www.omdbapi.com/?s=${encodeURIComponent(title)}&apikey=${apiKey}`;
    if (type) url += `&type=${type}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.Response === 'True' && data.Search && data.Search.length > 0) {
      // Fetch full details for the first result
      const id = data.Search[0].imdbID;
      const detailRes = await fetch(`https://www.omdbapi.com/?i=${id}&apikey=${apiKey}`);
      const detail = await detailRes.json();
      if (detail.Response === 'True') {
        return {
          canonicalTitle: detail.Title,
          rating: detail.imdbRating !== 'N/A' ? detail.imdbRating : null,
          actors: detail.Actors && detail.Actors !== 'N/A' ? detail.Actors.split(', ') : [],
        };
      }
    }
  } catch (e) {}
  return null;
}

async function fetchOMDB(title, apiKey, type) {
  // Try exact title
  let result = await tryOMDB(title, apiKey, type);
  if (result) return result;

  // Try with "The " prepended
  result = await tryOMDB('The ' + title, apiKey, type);
  if (result) return result;

  // Try without "The " prefix
  if (title.toLowerCase().startsWith('the ')) {
    result = await tryOMDB(title.slice(4), apiKey, type);
    if (result) return result;
  }

  // Try collapsing spaces (e.g. "Land Man" -> "Landman")
  const collapsed = title.replace(/\s+/g, '');
  if (collapsed !== title) {
    result = await tryOMDB(collapsed, apiKey, type);
    if (result) return result;
  }

  // Fall back to search endpoint
  result = await searchOMDB(title, apiKey, type);
  if (result) return result;

  return { canonicalTitle: null, rating: null, actors: [] };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  // Normally driven by a logged-in member loading their page. Also allow a
  // matching X-Cron-Secret so a scheduled/one-off job can backfill the whole
  // library (e.g. after adding poster/logo enrichment).
  const session = await getSession(request, env);
  const cronOk = !!env.CRON_SECRET && request.headers.get('X-Cron-Secret') === env.CRON_SECRET;
  if (!session && !cronOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = env.OMDB_API_KEY;

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const member = body.member || null;
  // Soft caps to keep us well clear of OMDB's free-tier 1k/day and TMDB's per-key budget.
  const maxOmdb = parseInt(body.max_omdb ?? '50', 10);
  const maxTmdb = parseInt(body.max_tmdb ?? '50', 10);

  // OMDB pass (ratings, actors, search URLs). Gated on an OMDB key being
  // configured: a missing key skips this pass but must NOT short-circuit the
  // TMDB poster/season passes that follow (that early return was why the
  // backfill reported tmdbUpdated: 0 even with TMDB credentials present).
  let enriched = 0;
  if (apiKey) {
  // Order by most-recent change first so newly-added/edited shows enrich before older backlog.
  const baseSelect = `SELECT s.id, s.title, s.network, s.network_url, s.movie
     FROM shows s
     WHERE s.archived = 0
       AND (s.rating IS NULL
         OR s.network_url IS NULL
         OR NOT EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id))`;
  const stmt = member
    ? env.DB.prepare(`${baseSelect} AND s.member_slug = ? ORDER BY COALESCE(s.updated_at, s.created_at) DESC LIMIT ?`).bind(member, maxOmdb)
    : env.DB.prepare(`${baseSelect} ORDER BY COALESCE(s.updated_at, s.created_at) DESC LIMIT ?`).bind(maxOmdb);
  const { results: needsRating } = await stmt.all();

  for (const show of needsRating) {
    const omdb = await fetchOMDB(show.title, apiKey, show.movie ? 'movie' : 'series');

    // Update canonical title if OMDB returned a different one
    if (omdb.canonicalTitle && omdb.canonicalTitle !== show.title) {
      // Check if canonical title already exists in DB
      const dupe = await env.DB.prepare(
        'SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND id != ?'
      ).bind(omdb.canonicalTitle, show.id).first();
      if (dupe) {
        // Duplicate — archive this one instead of renaming
        await env.DB.prepare(
          "UPDATE shows SET archived = 1, enriched_at = datetime('now') WHERE id = ?"
        ).bind(show.id).run();
        enriched++;
        continue;
      }
      await env.DB.prepare(
        "UPDATE shows SET title = ?, enriched_at = datetime('now') WHERE id = ?"
      ).bind(omdb.canonicalTitle, show.id).run();
    }

    // Update rating if missing
    if (omdb.rating) {
      await env.DB.prepare(
        "UPDATE shows SET rating = ?, enriched_at = datetime('now') WHERE id = ? AND rating IS NULL"
      ).bind(omdb.rating, show.id).run();
    }

    // Update actors if missing
    if (omdb.actors.length > 0) {
      const { results: existing } = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM actors WHERE show_id = ?'
      ).bind(show.id).all();
      if (existing[0].c === 0) {
        const stmt = env.DB.prepare('INSERT INTO actors (show_id, name) VALUES (?, ?)');
        await env.DB.batch(omdb.actors.map(actor => stmt.bind(show.id, actor)));
      }
    }

    // Generate search URL if no URL at all
    if (!show.network_url && show.network) {
      const searchUrl = generateSearchUrl(show.network, show.title);
      if (searchUrl) {
        await env.DB.prepare(
          "UPDATE shows SET network_url = ?, enriched_at = datetime('now') WHERE id = ?"
        ).bind(searchUrl, show.id).run();
      }
    }

    enriched++;
  }
  }

  // TMDB: check next season dates for Watching and Waiting shows.
  // Cap the same way; oldest/least-recently-enriched first so the budget rotates evenly.
  const hasTmdb = !!(env.TMDB_TOKEN || env.TMDB_API_KEY);
  const debug = {
    hasToken: !!env.TMDB_TOKEN,
    hasApiKey: !!env.TMDB_API_KEY,
    hasOmdb: !!apiKey,
    tvCandidates: null,
    movieCandidates: null,
    tvSample: null,
    tvError: null,
  };
  let tmdbUpdated = 0;
  if (hasTmdb) {
    const tmdbBase = `SELECT id, title, movie, list FROM shows
       WHERE archived = 0 AND movie = 0`;
    const tmdbStmt = member
      ? env.DB.prepare(`${tmdbBase} AND member_slug = ? ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(member, maxTmdb)
      : env.DB.prepare(`${tmdbBase} ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(maxTmdb);
    const { results: tmdbShows } = await tmdbStmt.all();
    debug.tvCandidates = tmdbShows.length;

    for (const show of tmdbShows) {
      try {
        // Search TMDB for the show
        const searchData = await tmdbGet(`/search/tv?query=${encodeURIComponent(show.title)}`, env);
        if (debug.tvSample === null) {
          debug.tvSample = JSON.stringify(searchData).slice(0, 300);
        }
        if (!searchData.results || searchData.results.length === 0) continue;

        const tmdbId = searchData.results[0].id;
        const detail = await tmdbGet(`/tv/${tmdbId}`, env);

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
          "UPDATE shows SET next_season_date = ?, season_end_date = ?, full_series = ?, genres = COALESCE(?, genres), seasons_released = COALESCE(?, seasons_released), poster_url = COALESCE(?, poster_url), network_logo_url = COALESCE(?, network_logo_url), enriched_at = datetime('now') WHERE id = ?"
        ).bind(newDate, endDate, isComplete, genres, seasonsReleased, posterUrl, networkLogoUrl, show.id).run();
        tmdbUpdated++;
      } catch (e) {
        if (!debug.tvError) debug.tvError = String((e && e.stack) || e).slice(0, 300);
      }
    }
  }

  // Movie posters — the pass above is TV-only (movie = 0), so movies need their
  // own poster fetch (no seasons/dates/network logo apply to movies). Only
  // touches movies that still lack a poster; stamps enriched_at either way so
  // titles TMDB can't find rotate to the back instead of blocking the queue.
  if (hasTmdb) {
    const movieBase = `SELECT id, title FROM shows
       WHERE archived = 0 AND movie = 1 AND poster_url IS NULL`;
    const movieStmt = member
      ? env.DB.prepare(`${movieBase} AND member_slug = ? ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(member, maxTmdb)
      : env.DB.prepare(`${movieBase} ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(maxTmdb);
    const { results: movieShows } = await movieStmt.all();
    debug.movieCandidates = movieShows.length;

    for (const show of movieShows) {
      try {
        const searchData = await tmdbGet(`/search/movie?query=${encodeURIComponent(show.title)}`, env);
        const posterPath = searchData.results && searchData.results[0] && searchData.results[0].poster_path;
        const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
        await env.DB.prepare(
          "UPDATE shows SET poster_url = COALESCE(?, poster_url), enriched_at = datetime('now') WHERE id = ?"
        ).bind(posterUrl, show.id).run();
        if (posterUrl) tmdbUpdated++;
      } catch (e) {}
    }
  }

  // Actor IMDB-id backfill — self-healing, no admin action required.
  // imdb_id is only ever written by the TMDB enrichment path (at add/edit time).
  // Shows added before that path existed, or via one that omits it (OMDB
  // fallback, the OMDB pass above, share, suggestions), keep actor rows with
  // imdb_id = NULL, so their names render as plain non-clickable tags. Re-run
  // the same TMDB enrichment for any show that still has null-id actors and
  // refresh its cast. We propagate by title so a single lookup fixes every
  // member's copy at once — including the oldest copy the home page surfaces
  // via /api/popular's MIN(id). Gated on TMDB_TOKEN: the OMDB fallback can't
  // supply actor ids, so there's nothing to gain (and nothing to wipe) without it.
  let actorImdbFilled = 0;
  if (env.TMDB_TOKEN) {
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
        // Only act when TMDB actually returned IMDB ids. If it fell back to OMDB
        // (all ids null) or found nothing, leave the existing cast untouched.
        if (!actors.some(a => a.imdb_id)) continue;

        const { results: copies } = await env.DB.prepare(
          'SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND archived = 0'
        ).bind(show.title).all();
        const insert = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id) VALUES (?, ?, ?)');
        for (const copy of copies) {
          await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(copy.id).run();
          await env.DB.batch(actors.map(a => insert.bind(copy.id, a.name, a.imdb_id || null)));
          actorImdbFilled++;
        }
      } catch (e) {}
    }
  }

  return new Response(JSON.stringify({ enriched, tmdbUpdated, actorImdbFilled, debug }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

import { getSession } from '../_shared/auth.js';
import { fetchEnrichment } from '../_shared/enrichment.js';

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
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = env.OMDB_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ enriched: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const member = body.member || null;
  // Soft caps to keep us well clear of OMDB's free-tier 1k/day and TMDB's per-key budget.
  const maxOmdb = parseInt(body.max_omdb ?? '50', 10);
  const maxTmdb = parseInt(body.max_tmdb ?? '50', 10);

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

  let enriched = 0;

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

  // TMDB: check next season dates for Watching and Waiting shows.
  // Cap the same way; oldest/least-recently-enriched first so the budget rotates evenly.
  const tmdbKey = env.TMDB_API_KEY;
  let tmdbUpdated = 0;
  if (tmdbKey) {
    const tmdbBase = `SELECT id, title, movie, list FROM shows
       WHERE archived = 0 AND movie = 0`;
    const tmdbStmt = member
      ? env.DB.prepare(`${tmdbBase} AND member_slug = ? ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(member, maxTmdb)
      : env.DB.prepare(`${tmdbBase} ORDER BY COALESCE(enriched_at, '1970-01-01') ASC LIMIT ?`).bind(maxTmdb);
    const { results: tmdbShows } = await tmdbStmt.all();

    for (const show of tmdbShows) {
      try {
        // Search TMDB for the show
        const searchRes = await fetch(`https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(show.title)}&api_key=${tmdbKey}`);
        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) continue;

        const tmdbId = searchData.results[0].id;
        const detailRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`);
        const detail = await detailRes.json();

        // Check if series is complete
        const status = detail.status;
        const isComplete = (status === 'Ended' || status === 'Canceled') ? 1 : 0;

        // Extract genres
        const genres = (detail.genres || []).map(g => g.name).join(', ') || null;

        // Only get dates for watching/waiting lists
        let newDate = null;
        let endDate = null;
        if (show.list === 'watching' || show.list === 'waiting') {
          const nextEp = detail.next_episode_to_air;
          newDate = nextEp ? nextEp.air_date : null;

          if (nextEp) {
            try {
              const seasonRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${nextEp.season_number}?api_key=${tmdbKey}`);
              const seasonData = await seasonRes.json();
              const eps = seasonData.episodes || [];
              if (eps.length > 0) {
                const lastEp = eps[eps.length - 1];
                if (lastEp.air_date) endDate = lastEp.air_date;
              }
            } catch (e) {}
          }
        }

        await env.DB.prepare(
          "UPDATE shows SET next_season_date = ?, season_end_date = ?, full_series = ?, genres = COALESCE(?, genres), enriched_at = datetime('now') WHERE id = ?"
        ).bind(newDate, endDate, isComplete, genres, show.id).run();
        tmdbUpdated++;
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

  return new Response(JSON.stringify({ enriched, tmdbUpdated, actorImdbFilled }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

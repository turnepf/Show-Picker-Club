// Shared enrichment: TMDB (search + cast + actor IMDB IDs) + OMDB (IMDB rating
// by exact IMDB id). TMDB is the sole title-lookup path; OMDB is used only to
// attach an IMDB rating once TMDB has resolved the show's IMDB id. (The OMDB
// title-guessing fallback was retired once TMDB type-ahead pinning made new
// rows arrive canonical — see docs/PRODUCT.md.)

async function tmdbFetch(path, token) {
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

async function omdbById(imdbId, apiKey) {
  try {
    const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`);
    const d = await res.json();
    if (d.Response === 'True') {
      return {
        rating: d.imdbRating !== 'N/A' ? d.imdbRating : null,
        canonicalTitle: d.Title || null,
      };
    }
  } catch (_) {}
  return { rating: null, canonicalTitle: null };
}

// TMDB poster paths are relative; w500 is a good size for tvOS cards.
function tmdbPosterUrl(posterPath) {
  return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
}

// Full enrichment payload for a known TMDB id: details + credits +
// external_ids in one call, IMDB rating via OMDB (by exact IMDB id), and
// actor IMDB ids. Shared by the title-search path below and the exact-pick
// path (fetchEnrichmentById) used when a member selected the show themselves.
async function enrichFromTmdbId(tmdbId, mediaType, env, fallbackPoster = null) {
  const token = env.TMDB_TOKEN;
  const omdbKey = env.OMDB_API_KEY;

  const detail = await tmdbFetch(
    `/${mediaType}/${tmdbId}?append_to_response=credits,external_ids&language=en-US`,
    token
  );

  const imdbShowId = detail.external_ids?.imdb_id || null;
  let canonicalTitle = (mediaType === 'movie' ? detail.title : detail.name) || null;
  let rating = null;
  if (imdbShowId && omdbKey) {
    const omdb = await omdbById(imdbShowId, omdbKey);
    rating = omdb.rating;
    if (omdb.canonicalTitle) canonicalTitle = omdb.canonicalTitle;
  }

  // Actor IMDB IDs in parallel
  const cast = (detail.credits?.cast || []).slice(0, 4);
  const actors = await Promise.all(
    cast.map(async (person) => {
      try {
        const ext = await tmdbFetch(`/person/${person.id}/external_ids`, token);
        return { name: person.name, imdb_id: ext.imdb_id || null };
      } catch (_) {
        return { name: person.name, imdb_id: null };
      }
    })
  );

  const posterUrl = tmdbPosterUrl(detail.poster_path) || fallbackPoster;
  const netLogoPath = detail.networks && detail.networks[0] && detail.networks[0].logo_path;
  const networkLogoUrl = netLogoPath ? `https://image.tmdb.org/t/p/w154${netLogoPath}` : null;

  return { canonicalTitle, rating, actors, posterUrl, networkLogoUrl };
}

// Exact-pick enrichment: the member chose this TMDB entry from type-ahead
// search, so skip title-guessing entirely. Returns the empty shape when the
// lookup fails (caller falls back to fetchEnrichment's title search).
export async function fetchEnrichmentById(tmdbId, mediaType, env) {
  const empty = { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null };
  if (!env.TMDB_TOKEN || !tmdbId) return empty;
  try {
    return await enrichFromTmdbId(tmdbId, mediaType === 'movie' ? 'movie' : 'tv', env);
  } catch (_) {
    return empty;
  }
}

export async function fetchEnrichment(title, env, isMovie) {
  const token = env.TMDB_TOKEN;
  // Try the stored media type first, then the other one. Documentaries and
  // stand-up specials often live under TMDB's *movie* index even when a
  // member added them as a show (and vice versa) — without the flip, a
  // correctly-spelled title can never match, so it never gets a poster.
  const mediaTypes = isMovie ? ['movie', 'tv'] : ['tv', 'movie'];

  // ── TMDB path ──────────────────────────────────────────────────────────────
  if (token) {
    try {
      let search = null;
      let mediaType = mediaTypes[0];
      for (const t of mediaTypes) {
        const s = await tmdbFetch(
          `/search/${t}?query=${encodeURIComponent(title)}&language=en-US&page=1`,
          token
        );
        if (s.results?.length) { search = s; mediaType = t; break; }
      }

      if (search) {
        // TMDB sorts by popularity, so a popular spin-off ("Below Deck
        // Mediterranean") can outrank the exact-title original ("Below Deck")
        // and hand it the wrong poster. Prefer a result whose title matches
        // exactly (case-insensitive); fall back to the most-popular result.
        const want = title.replace(/\s+/g, ' ').trim().toLowerCase();
        const pick = search.results.find(
          (r) => ((mediaType === 'movie' ? r.title : r.name) || '')
            .replace(/\s+/g, ' ').trim().toLowerCase() === want
        ) || search.results[0];
        const result = await enrichFromTmdbId(
          pick.id, mediaType, env,
          tmdbPosterUrl(pick.poster_path)
        );
        return { ...result, canonicalTitle: result.canonicalTitle || title };
      }
    } catch (_) {
      // TMDB errored — nothing to fall back to; return the empty shape.
    }
  }

  return { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null };
}

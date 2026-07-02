// Shared enrichment: TMDB (search + cast + actor IMDB IDs) + OMDB (IMDB rating by ID).
// TMDB is primary. OMDB is fallback for both lookup and rating.

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

async function omdbByTitle(title, apiKey, type) {
  async function tryTitle(t) {
    try {
      let url = `https://www.omdbapi.com/?t=${encodeURIComponent(t)}&apikey=${apiKey}`;
      if (type) url += `&type=${type}`;
      const res = await fetch(url);
      const d = await res.json();
      if (d.Response === 'True') return d;
    } catch (_) {}
    return null;
  }

  let d = await tryTitle(title);
  if (!d) d = await tryTitle('The ' + title);
  if (!d && title.toLowerCase().startsWith('the ')) d = await tryTitle(title.slice(4));

  if (!d) {
    try {
      let url = `https://www.omdbapi.com/?s=${encodeURIComponent(title)}&apikey=${apiKey}`;
      if (type) url += `&type=${type}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.Response === 'True' && data.Search?.length) {
        const dr = await fetch(`https://www.omdbapi.com/?i=${data.Search[0].imdbID}&apikey=${apiKey}`);
        const dd = await dr.json();
        if (dd.Response === 'True') d = dd;
      }
    } catch (_) {}
  }

  if (!d) return null;
  return {
    imdbId: d.imdbID || null,
    rating: d.imdbRating !== 'N/A' ? d.imdbRating : null,
    canonicalTitle: d.Title || null,
    actors: d.Actors && d.Actors !== 'N/A' ? d.Actors.split(', ') : [],
    posterUrl: d.Poster && d.Poster !== 'N/A' ? d.Poster : null,
  };
}

// TMDB poster paths are relative; w500 is a good size for tvOS cards.
function tmdbPosterUrl(posterPath) {
  return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
}

export async function fetchEnrichment(title, env, isMovie) {
  const token = env.TMDB_TOKEN;
  const omdbKey = env.OMDB_API_KEY;
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
        const tmdbId = search.results[0].id;

        // One call: details + credits + external_ids
        const detail = await tmdbFetch(
          `/${mediaType}/${tmdbId}?append_to_response=credits,external_ids&language=en-US`,
          token
        );

        const imdbShowId = detail.external_ids?.imdb_id || null;
        const canonicalTmdb = (mediaType === 'movie' ? detail.title : detail.name) || title;
        const cast = (detail.credits?.cast || []).slice(0, 4);

        // IMDB rating via OMDB using exact show IMDB ID (no title-guessing)
        let rating = null;
        let canonicalTitle = canonicalTmdb;
        if (imdbShowId && omdbKey) {
          const omdb = await omdbById(imdbShowId, omdbKey);
          rating = omdb.rating;
          if (omdb.canonicalTitle) canonicalTitle = omdb.canonicalTitle;
        }

        // Actor IMDB IDs in parallel
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

        const posterUrl = tmdbPosterUrl(detail.poster_path || search.results[0].poster_path);
        const netLogoPath = detail.networks && detail.networks[0] && detail.networks[0].logo_path;
        const networkLogoUrl = netLogoPath ? `https://image.tmdb.org/t/p/w154${netLogoPath}` : null;

        return { canonicalTitle, rating, actors, posterUrl, networkLogoUrl };
      }
    } catch (_) {
      // fall through to OMDB
    }
  }

  // ── OMDB fallback ──────────────────────────────────────────────────────────
  if (omdbKey) {
    // Same cross-type retry as TMDB: OMDB files docs/specials under the
    // other type too, so a typed miss gets one untyped-flip attempt.
    const result = await omdbByTitle(title, omdbKey, isMovie ? 'movie' : 'series')
      || await omdbByTitle(title, omdbKey, isMovie ? 'series' : 'movie');
    if (result) {
      return {
        canonicalTitle: result.canonicalTitle,
        rating: result.rating,
        actors: result.actors.map(name => ({ name, imdb_id: null })),
        posterUrl: result.posterUrl || null,
        networkLogoUrl: null,
      };
    }
  }

  return { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null };
}

// Shared enrichment: TMDB (search + cast + actor IMDB IDs) + OMDB (IMDB rating
// by exact IMDB id). TMDB is the sole title-lookup path; OMDB is used only to
// attach an IMDB rating once TMDB has resolved the show's IMDB id. (The OMDB
// title-guessing fallback was retired once TMDB type-ahead pinning made new
// rows arrive canonical — see docs/PRODUCT.md.)

import { knownNetwork } from './networks.js';

// The extra sub-requests we fold into the TMDB detail call via
// append_to_response — one HTTP request, no extra Cloudflare subrequest budget.
// content_ratings is TV-only; release_dates is its movie equivalent (for the
// maturity certification).
function detailAppend(mediaType) {
  const base = 'credits,external_ids,videos,watch/providers';
  return mediaType === 'movie' ? `${base},release_dates` : `${base},content_ratings`;
}

// Pull the richer detail fields out of a TMDB details payload (fetched with
// detailAppend()). Shared by the add-time enricher (enrichFromTmdbId) and the
// background backfill passes (api/enrich.js) so both store the same shape.
export function extractTmdbDetailFields(detail, mediaType) {
  const overview = detail.overview || null;
  const backdropUrl = detail.backdrop_path
    ? `https://image.tmdb.org/t/p/w780${detail.backdrop_path}` : null;
  const tmdbRating = (typeof detail.vote_average === 'number' && detail.vote_average > 0)
    ? detail.vote_average.toFixed(1) : null;
  const runtime = mediaType === 'movie'
    ? (detail.runtime || null)
    : ((Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) || null);
  const releaseDate = mediaType === 'movie' ? detail.release_date : detail.first_air_date;
  const releaseYear = releaseDate ? (parseInt(String(releaseDate).slice(0, 4), 10) || null) : null;

  // Director (movie) or creator(s) (TV).
  let director = null;
  if (mediaType === 'movie') {
    const d = (detail.credits?.crew || []).find((c) => c.job === 'Director');
    director = d ? d.name : null;
  } else {
    const creators = (detail.created_by || []).map((c) => c.name).filter(Boolean);
    director = creators.length ? creators.join(', ') : null;
  }

  // US maturity certification.
  let contentRating = null;
  if (mediaType === 'movie') {
    const us = (detail.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US');
    const cert = us && (us.release_dates || []).map((x) => x.certification).find((c) => c);
    contentRating = cert || null;
  } else {
    const us = (detail.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'US');
    contentRating = us && us.rating ? us.rating : null;
  }

  // Trailer (prefer an official Trailer, fall back to a Teaser); YouTube only.
  const yt = (detail.videos?.results || []).filter((v) => v.site === 'YouTube');
  const trailer = yt.find((v) => v.type === 'Trailer') || yt.find((v) => v.type === 'Teaser') || null;
  const trailerKey = trailer ? trailer.key : null;

  // US flatrate (subscription) provider → canonical network, plus a
  // where-to-watch link. The provider name feeds `network` ONLY when it maps
  // to a service we know (knownNetwork); the link is a fallback aggregator
  // page (never a deep link), stored separately in `watch_link`.
  let providerNetwork = null;
  let watchLink = null;
  const wp = detail['watch/providers']?.results?.US || null;
  if (wp) {
    watchLink = wp.link || null;
    const flatrate = [...(wp.flatrate || [])].sort(
      (a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99)
    );
    for (const p of flatrate) {
      const n = knownNetwork(p.provider_name);
      if (n) { providerNetwork = n; break; }
    }
  }

  return {
    overview, backdropUrl, tmdbRating, contentRating, trailerKey,
    director, runtime, releaseYear, providerNetwork, watchLink,
  };
}

// The null-valued shape of the detail fields, for the empty/failed returns.
const EMPTY_DETAIL = {
  overview: null, backdropUrl: null, tmdbRating: null, contentRating: null,
  trailerKey: null, director: null, runtime: null, releaseYear: null,
  providerNetwork: null, watchLink: null,
};

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
    `/${mediaType}/${tmdbId}?append_to_response=${detailAppend(mediaType)}&language=en-US`,
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

  return {
    canonicalTitle, rating, actors, posterUrl, networkLogoUrl,
    ...extractTmdbDetailFields(detail, mediaType),
  };
}

// Exact-pick enrichment: the member chose this TMDB entry from type-ahead
// search, so skip title-guessing entirely. Returns the empty shape when the
// lookup fails (caller falls back to fetchEnrichment's title search).
export async function fetchEnrichmentById(tmdbId, mediaType, env) {
  const empty = { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null, ...EMPTY_DETAIL };
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

  return { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null, ...EMPTY_DETAIL };
}

// Shared enrichment: TMDB only (search + detail + cast + actor IMDB IDs +
// creator/director IMDB ID). TMDB is the sole title-lookup path and the sole
// rating source — `rating` now carries TMDB's audience score. (OMDB was
// retired once we consolidated on a single TMDB rating; the OMDB title-guessing
// fallback had already been dropped when TMDB type-ahead pinning made new rows
// arrive canonical — see docs/PRODUCT.md.)

import { knownNetwork } from './networks.js';
import { knownByPersonIds, rememberPeople } from './people.js';

// How many cast members we store per title. Clients show the top few;
// storing more means a search by actor can find the character actor nobody
// bills, and re-enriching to go deeper later costs a full TMDB round trip.
export const CAST_DEPTH = 12;

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
  // Episode length for a series. TMDB's episode_run_time is empty for a large
  // share of modern shows, which left "Runtime" blank on every client for most
  // TV — so fall back to an actual episode's runtime (the latest that aired,
  // else the next scheduled one). Both ride along in the same detail payload.
  const runtime = mediaType === 'movie'
    ? (detail.runtime || null)
    : ((Array.isArray(detail.episode_run_time) && detail.episode_run_time.find((n) => n > 0))
       || detail.last_episode_to_air?.runtime
       || detail.next_episode_to_air?.runtime
       || null);
  const releaseDate = mediaType === 'movie' ? detail.release_date : detail.first_air_date;
  const releaseYear = releaseDate ? (parseInt(String(releaseDate).slice(0, 4), 10) || null) : null;

  // Director (movie) or creator(s) (TV). directorPersonId is the TMDB person id
  // of the *first* credited person — the one whose external_ids we resolve to
  // an IMDB id for the detail-screen person link. (The link is only rendered
  // client-side when the display name is a single person, so a multi-creator
  // show's joined names never link to just the first creator.)
  let director = null;
  let directorPersonId = null;
  if (mediaType === 'movie') {
    const d = (detail.credits?.crew || []).find((c) => c.job === 'Director');
    director = d ? d.name : null;
    directorPersonId = d ? d.id : null;
  } else {
    const creators = (detail.created_by || []).filter((c) => c && c.name);
    director = creators.length ? creators.map((c) => c.name).join(', ') : null;
    directorPersonId = creators.length ? creators[0].id : null;
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
    director, directorPersonId, runtime, releaseYear, providerNetwork, watchLink,
  };
}

// The null-valued shape of the detail fields, for the empty/failed returns.
const EMPTY_DETAIL = {
  overview: null, backdropUrl: null, tmdbRating: null, contentRating: null,
  trailerKey: null, director: null, directorPersonId: null, runtime: null,
  releaseYear: null, providerNetwork: null, watchLink: null,
};

// Retries on 429 (rate limit) with backoff — otherwise a burst of many
// sequential calls in one invocation (a backfill batch, a detail fetch's
// parallel cast/person lookups) starts getting rate-limited partway through,
// and every caller here just reads that as "no results" and gives up on
// titles that would have matched fine with a moment's wait.
async function tmdbFetch(path, token, attempt = 0) {
  const res = await fetch(`https://api.themoviedb.org/3${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return tmdbFetch(path, token, attempt + 1);
  }
  return res.json();
}

// Resolve a TMDB person id to their IMDB id (nm…), for the creator/director
// person link on the detail screen. Best-effort: null on any miss/error.
async function personImdbId(personId, token) {
  if (!personId) return null;
  try {
    const ext = await tmdbFetch(`/person/${personId}/external_ids`, token);
    return ext.imdb_id || null;
  } catch (_) {
    return null;
  }
}

// TMDB poster paths are relative; w500 is a good size for tvOS cards.
function tmdbPosterUrl(posterPath) {
  return posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
}

// Full enrichment payload for a known TMDB id: details + credits +
// external_ids in one call, TMDB rating, actor IMDB ids, and the
// creator/director's IMDB id. Shared by the title-search path below and the
// exact-pick path (fetchEnrichmentById) used when a member picked the show.
async function enrichFromTmdbId(tmdbId, mediaType, env, fallbackPoster = null) {
  const token = env.TMDB_TOKEN;

  const detail = await tmdbFetch(
    `/${mediaType}/${tmdbId}?append_to_response=${detailAppend(mediaType)}&language=en-US`,
    token
  );

  const canonicalTitle = (mediaType === 'movie' ? detail.title : detail.name) || null;
  const detailFields = extractTmdbDetailFields(detail, mediaType);
  // Single rating, straight from TMDB (OMDB retired).
  const rating = detailFields.tmdbRating;

  // Cast, in TMDB's billing order — `cast` comes back sorted by `order`, so
  // the first entries ARE the principals. The old cap of 4 routinely cut a
  // major character; 12 covers a main ensemble without turning the card into
  // a phone book, and clients decide how many of those to draw.
  const cast = (detail.credits?.cast || []).slice(0, CAST_DEPTH);
  // Anyone we've already resolved on another show costs no request at all —
  // which is what makes a deeper cast affordable inside the subrequest
  // budget, since a club's shows share actors constantly.
  const knownIds = env ? await knownByPersonIds(env, cast.map(p => p.id)) : new Map();
  const [actors, directorImdbId] = await Promise.all([
    Promise.all(
      cast.map(async (person, i) => {
        const cached = knownIds.get(person.id);
        if (cached) {
          return { name: person.name, imdb_id: cached, tmdb_person_id: person.id, ord: i };
        }
        try {
          const ext = await tmdbFetch(`/person/${person.id}/external_ids`, token);
          return { name: person.name, imdb_id: ext.imdb_id || null, tmdb_person_id: person.id, ord: i };
        } catch (_) {
          return { name: person.name, imdb_id: null, tmdb_person_id: person.id, ord: i };
        }
      })
    ),
    personImdbId(detailFields.directorPersonId, token),
  ]);

  // Bank everyone we resolved, including the creator, so the next show they
  // turn up on is free — and so a name-only credit elsewhere can be linked.
  if (env) {
    const learned = actors
      .filter(a => a.imdb_id)
      .map(a => ({ tmdbPersonId: a.tmdb_person_id, name: a.name, imdbId: a.imdb_id }));
    if (directorImdbId && detailFields.director && !detailFields.director.includes(',')) {
      learned.push({
        tmdbPersonId: detailFields.directorPersonId,
        name: detailFields.director,
        imdbId: directorImdbId,
      });
    }
    await rememberPeople(env, learned).catch(() => {});
  }

  const posterUrl = tmdbPosterUrl(detail.poster_path) || fallbackPoster;
  const netLogoPath = detail.networks && detail.networks[0] && detail.networks[0].logo_path;
  const networkLogoUrl = netLogoPath ? `https://image.tmdb.org/t/p/w154${netLogoPath}` : null;

  return {
    canonicalTitle, rating, actors, posterUrl, networkLogoUrl, directorImdbId,
    tmdbId, tmdbType: mediaType,
    ...detailFields,
  };
}

// Exact-pick enrichment: the member chose this TMDB entry from type-ahead
// search, so skip title-guessing entirely. Returns the empty shape when the
// lookup fails (caller falls back to fetchEnrichment's title search).
export async function fetchEnrichmentById(tmdbId, mediaType, env) {
  const empty = { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null, directorImdbId: null, tmdbId: null, tmdbType: null, ...EMPTY_DETAIL };
  if (!env.TMDB_TOKEN || !tmdbId) return empty;
  try {
    return await enrichFromTmdbId(tmdbId, mediaType === 'movie' ? 'movie' : 'tv', env);
  } catch (_) {
    return empty;
  }
}

// Pick the best TMDB search hit for a title: prefer an exact (case/space-
// insensitive) title match — TMDB sorts by popularity, so a popular spin-off
// ("Below Deck Mediterranean") can outrank the exact original ("Below
// Deck") — and fall back to the most-popular result otherwise.
function pickBestMatch(results, mediaType, title) {
  const want = title.replace(/\s+/g, ' ').trim().toLowerCase();
  return results.find(
    (r) => ((mediaType === 'movie' ? r.title : r.name) || '')
      .replace(/\s+/g, ' ').trim().toLowerCase() === want
  ) || results[0];
}

// Lightweight TMDB search: resolves just the canonical id + media type for a
// title, without the detail/credits/person calls fetchEnrichment does for a
// full add or edit. One subrequest per title (two if the stored media type
// doesn't match and the flip is needed) instead of up to ~7 — for a backfill
// pass working through many titles in one invocation, that's the difference
// between finishing the batch and silently running out of budget partway
// through it.
export async function searchTmdbId(title, env, isMovie) {
  const token = env.TMDB_TOKEN;
  if (!token) return { tmdbId: null, tmdbType: null, reason: 'no_tmdb_token' };
  const mediaTypes = isMovie ? ['movie', 'tv'] : ['tv', 'movie'];
  let reason = 'no_results';
  try {
    for (const t of mediaTypes) {
      const s = await tmdbFetch(
        `/search/${t}?query=${encodeURIComponent(title)}&language=en-US&page=1`,
        token
      );
      if (s.results?.length) {
        const pick = pickBestMatch(s.results, t, title);
        return { tmdbId: pick.id, tmdbType: t };
      }
      if (s.success === false) reason = s.status_message || 'tmdb_error';
    }
  } catch (e) {
    reason = `exception: ${e.message}`;
  }
  return { tmdbId: null, tmdbType: null, reason };
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
        const pick = pickBestMatch(search.results, mediaType, title);
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

  return { canonicalTitle: null, rating: null, actors: [], posterUrl: null, networkLogoUrl: null, directorImdbId: null, tmdbId: null, tmdbType: null, ...EMPTY_DETAIL };
}

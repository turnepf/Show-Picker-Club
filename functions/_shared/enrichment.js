// Shared enrichment: TMDB only (search + detail + cast + actor IMDB IDs +
// creator/director IMDB ID). TMDB is the sole title-lookup path and the sole
// rating source — `rating` now carries TMDB's audience score. (OMDB was
// retired once we consolidated on a single TMDB rating; the OMDB title-guessing
// fallback had already been dropped when TMDB type-ahead pinning made new rows
// arrive canonical — see docs/PRODUCT.md.)

import { knownNetwork, storefrontFromProvider } from './networks.js';
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
  // The service's badge, taken off the same provider object that names the
  // network. TV reads its logo from `detail.networks[0].logo_path`, a field
  // movies simply don't have — the watch-provider block is the only place a
  // film's logo can come from, and it rides in a response we already fetch.
  let providerLogoUrl = null;
  let watchLink = null;
  // Storefronts that sell the title outright, and the availability verdict:
  // 'subscription' when some service streams it on a plan, 'rent_buy' when the
  // only way to watch is to pay per view, null when TMDB knows of neither.
  //
  // The rent/buy arrays used to be read and dropped on the floor, which is why
  // nothing could tell an Apple TV+ original from an Apple rental — both
  // arrived on the same payload, only one was looked at.
  let storefronts = [];
  let availability = null;
  const wp = detail['watch/providers']?.results?.US || null;
  if (wp) {
    watchLink = wp.link || null;
    const flatrate = [...(wp.flatrate || [])].sort(
      (a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99)
    );
    for (const p of flatrate) {
      const n = knownNetwork(p.provider_name);
      if (n) {
        providerNetwork = n;
        providerLogoUrl = p.logo_path ? `https://image.tmdb.org/t/p/w154${p.logo_path}` : null;
        break;
      }
    }
    const rentBuy = [...(wp.rent || []), ...(wp.buy || [])];
    storefronts = [...new Set(
      rentBuy.map((p) => storefrontFromProvider(p.provider_name)).filter(Boolean)
    )];
    if ((wp.flatrate || []).length) availability = 'subscription';
    else if (rentBuy.length) availability = 'rent_buy';
  }

  // Episode count across aired seasons. The companion to seasons_released,
  // which on its own says nothing about size: four seasons of Severance is 19
  // episodes, four of Grey's Anatomy is 90. Movies have neither.
  const episodesReleased = mediaType === 'movie'
    ? null
    : (typeof detail.number_of_episodes === 'number' ? detail.number_of_episodes : null);

  // Sample size behind tmdbRating, so a 9.1 from eleven people can later be
  // told apart from an 8.9 from forty thousand.
  const voteCount = typeof detail.vote_count === 'number' ? detail.vote_count : null;

  const tagline = (detail.tagline || '').trim() || null;
  const originalLanguage = (detail.original_language || '').trim().toLowerCase() || null;

  // Originating studio (movie) or broadcaster (series). TMDB orders
  // production_companies by its own internal id rather than prominence, so the
  // first entry is as often a financing shell as it is A24 — which is why this
  // is stored but not displayed yet. The TV side is cleaner: `networks` is
  // short and accurate. Named `studio`, never anything network-shaped, because
  // shows.network already means the streaming service.
  const studio = mediaType === 'movie'
    ? ((detail.production_companies || [])[0]?.name || null)
    : ((detail.networks || [])[0]?.name || null);

  return {
    overview, backdropUrl, tmdbRating, contentRating, trailerKey,
    director, directorPersonId, runtime, releaseYear, providerNetwork, providerLogoUrl, watchLink,
    storefronts, availability,
    episodesReleased, voteCount, tagline, originalLanguage, studio,
  };
}

// TMDB credits can list the same person twice — one entry per role (a dual
// part, an archive-footage credit next to the main billing). Stored as-is
// that became two identical cast rows on every copy of a title (Brittany
// Snow twice on The Hunting Wives, 2026-08), and because the cast refresh
// replaces rows wholesale, deleting the extras by hand just re-created them
// on the next pass. Keep the first (best-billed) entry per person, keyed on
// TMDB's person id when there is one and the name otherwise, BEFORE the
// depth cap — so the echo doesn't spend one of the CAST_DEPTH slots either.
export function dedupeCast(cast) {
  const seen = new Set();
  return (cast || []).filter((p) => {
    const key = p.id ?? `name:${(p.name || '').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The network to store when the member picked none: the subscription service
// that streams the title, else — when the only way to watch is paying per
// view — the storefront that sells it ("Apple TV Store", "Fandango at Home").
// The storefront half is what names a platform on rent/buy-only movies (new
// releases between theatres and streaming), which otherwise land with no
// network anywhere a card could show one. Reaching for the storefront ONLY on
// a rent_buy verdict keeps this from re-introducing the Apple TV+ rental
// mislabel that reclassify-storefronts exists to drain.
export function fallbackNetwork(enriched) {
  if (!enriched) return null;
  if (enriched.providerNetwork) return enriched.providerNetwork;
  if (enriched.availability === 'rent_buy') return (enriched.storefronts || [])[0] || null;
  return null;
}

// The null-valued shape of the detail fields, for the empty/failed returns.
const EMPTY_DETAIL = {
  overview: null, backdropUrl: null, tmdbRating: null, contentRating: null,
  trailerKey: null, director: null, directorPersonId: null, runtime: null,
  releaseYear: null, providerNetwork: null, providerLogoUrl: null, watchLink: null,
  storefronts: [], availability: null,
  episodesReleased: null, voteCount: null, tagline: null,
  originalLanguage: null, studio: null,
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
  const cast = dedupeCast(detail.credits?.cast).slice(0, CAST_DEPTH);
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

// Just the US availability picture for a known TMDB id: which subscription
// service streams it (if any), which storefronts sell it, and the verdict of
// the two. One subrequest — the details call with only watch/providers
// appended, no credits or videos — so an operator pass can walk many titles
// inside the subrequest budget. Never throws; returns the empty shape on any
// failure so callers can treat "unknown" and "not carried" distinctly.
export async function fetchAvailability(tmdbId, mediaType, env) {
  const empty = { providerNetwork: null, storefronts: [], availability: null };
  if (!env.TMDB_TOKEN || !tmdbId) return empty;
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  try {
    const detail = await tmdbFetch(
      `/${type}/${tmdbId}?append_to_response=watch/providers&language=en-US`,
      env.TMDB_TOKEN
    );
    const { providerNetwork, storefronts, availability } = extractTmdbDetailFields(detail, type);
    return { providerNetwork, storefronts, availability };
  } catch (_) {
    return empty;
  }
}

// Strip a trailing "(YYYY)" disambiguator from a stored title: members,
// clients and TMDB itself write "Little House on the Prairie (2026)" to tell
// a remake from the original it remade. TMDB's search matches better without
// the suffix, and the year is exactly the hint that picks the right entry
// out of the results.
export function titleSearchTerms(title) {
  const m = /^(.*\S)\s*\(((?:19|20)\d{2})\)\s*$/.exec(title || '');
  return m ? { query: m[1], year: parseInt(m[2], 10) } : { query: title, year: null };
}

const normTitle = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const resultDate = (r, mediaType) => (mediaType === 'movie' ? r.release_date : r.first_air_date) || '';

// Pick the best TMDB search hit for a title. Exact (case/space-insensitive)
// title matches beat popularity — TMDB sorts by popularity, so a popular
// spin-off ("Below Deck Mediterranean") can outrank the exact original
// ("Below Deck"). Among several exact matches — a remake next to the original
// it remade, sharing one exact name — a "(YYYY)" year in the stored title
// picks its own entry, and otherwise the NEWEST dated entry wins: when a
// show has a current version, that's the one a member reaching for the bare
// title means; nobody adds the 1974 series by accident the year the remake
// lands. Dateless entries only win when nothing dated matches — an entry
// with no date at all is more often catalog junk than an upcoming remake.
// Exported for enrich.js's lighter search, so every title-resolution path
// picks by the same rule.
export function pickBestMatch(results, mediaType, title) {
  const { query, year } = titleSearchTerms(title);
  const want = normTitle(query);
  const exact = results.filter(
    (r) => normTitle(mediaType === 'movie' ? r.title : r.name) === want
  );
  if (!exact.length) return results[0];
  if (year) {
    const hinted = exact.find((r) => resultDate(r, mediaType).slice(0, 4) === String(year));
    if (hinted) return hinted;
  }
  const dated = exact.filter((r) => resultDate(r, mediaType));
  if (dated.length) {
    return dated.reduce((best, r) =>
      (resultDate(r, mediaType) > resultDate(best, mediaType) ? r : best));
  }
  return exact[0];
}

// Lightweight TMDB search: resolves just the canonical id + media type for a
// title, without the detail/credits/person calls fetchEnrichment does for a
// full add or edit. One subrequest per title (two if the stored media type
// doesn't match and the flip is needed) instead of up to ~7 — for a backfill
// pass working through many titles in one invocation, that's the difference
// between finishing the batch and silently running out of budget partway
// through it.
export async function searchTmdbId(title, env, isMovie) {
  const { tmdbId, tmdbType, reason } = await searchTmdbTitle(title, env, isMovie);
  return { tmdbId, tmdbType, reason };
}

// Same one-subrequest search as searchTmdbId, but keeps the fields the search
// hit already carried: the canonical title, the poster, and the year. The list
// importer needs those to draw a review row per title without spending a
// detail call on rows the member may well drop — searchTmdbId throws them away.
export async function searchTmdbTitle(title, env, isMovie) {
  const empty = {
    tmdbId: null, tmdbType: null, canonicalTitle: null,
    posterUrl: null, releaseYear: null,
  };
  const token = env.TMDB_TOKEN;
  if (!token) return { ...empty, reason: 'no_tmdb_token' };
  const mediaTypes = isMovie ? ['movie', 'tv'] : ['tv', 'movie'];
  // Search without a trailing "(YYYY)" — TMDB's index often returns nothing
  // for the suffixed form; pickBestMatch still sees the full title, so the
  // year keeps doing its disambiguation work on the results.
  const { query } = titleSearchTerms(title);
  let reason = 'no_results';
  try {
    for (const t of mediaTypes) {
      const s = await tmdbFetch(
        `/search/${t}?query=${encodeURIComponent(query)}&language=en-US&page=1`,
        token
      );
      if (s.results?.length) {
        const pick = pickBestMatch(s.results, t, title);
        const date = (t === 'movie' ? pick.release_date : pick.first_air_date) || '';
        const year = parseInt(date.slice(0, 4), 10);
        return {
          tmdbId: pick.id,
          tmdbType: t,
          canonicalTitle: (t === 'movie' ? pick.title : pick.name) || null,
          posterUrl: tmdbPosterUrl(pick.poster_path),
          releaseYear: Number.isInteger(year) ? year : null,
        };
      }
      if (s.success === false) reason = s.status_message || 'tmdb_error';
    }
  } catch (e) {
    reason = `exception: ${e.message}`;
  }
  return { ...empty, reason };
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
    // Same stripped-query rule as searchTmdbTitle: the "(YYYY)" suffix hurts
    // the search and helps the pick.
    const { query } = titleSearchTerms(title);
    try {
      let search = null;
      let mediaType = mediaTypes[0];
      for (const t of mediaTypes) {
        const s = await tmdbFetch(
          `/search/${t}?query=${encodeURIComponent(query)}&language=en-US&page=1`,
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

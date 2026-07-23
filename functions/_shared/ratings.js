// Shared ratings validation + aggregation. Ratings key off (tmdb_id,
// tmdb_type, season_number) rather than any one member's `shows` row, so
// every member's independent copy of the same title shares one rating pool
// (see migration 053). season_number 0 = the overall rating; 1+ = that
// season, matching `seasons_released`'s numbering.

export const OVERALL_SEASON = 0;

export function isValidRating(n) {
  return Number.isInteger(n) && n >= 1 && n <= 10;
}

export async function upsertRating(env, { tmdbId, tmdbType, seasonNumber, memberSlug, rating }) {
  await env.DB.prepare(
    `INSERT INTO show_ratings (tmdb_id, tmdb_type, season_number, member_slug, rating, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (tmdb_id, tmdb_type, season_number, member_slug)
     DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`
  ).bind(tmdbId, tmdbType, seasonNumber, memberSlug, rating).run();
}

function round1(n) {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : null;
}

// Club average + count (overall and per season), plus the viewing member's
// own ratings and — when viewing a specific other member's copy of the
// show — that member's ratings too. `viewerSlug`/`ownerSlug` are both
// optional: a logged-out visitor gets averages only (no `mine`/`owner`),
// and viewing your own copy never populates `owner` (same person as
// `mine`, so there's nothing extra to say).
export async function getRatingsSummary(env, { tmdbId, tmdbType, viewerSlug, ownerSlug }) {
  if (!tmdbId || !tmdbType) return null;

  const { results: agg } = await env.DB.prepare(
    `SELECT season_number, AVG(rating) AS avg, COUNT(*) AS cnt
     FROM show_ratings WHERE tmdb_id = ? AND tmdb_type = ?
     GROUP BY season_number`
  ).bind(tmdbId, tmdbType).all();

  const overallAgg = agg.find((r) => r.season_number === OVERALL_SEASON);
  const seasons = {};
  for (const r of agg) {
    if (r.season_number !== OVERALL_SEASON) {
      seasons[r.season_number] = { average: round1(r.avg), count: r.cnt };
    }
  }

  const summary = {
    average: overallAgg ? round1(overallAgg.avg) : null,
    count: overallAgg ? overallAgg.cnt : 0,
    seasons,
    mine: null,
    mineSeasons: {},
    owner: null,
    ownerSeasons: {},
  };

  const slugs = [...new Set([viewerSlug, ownerSlug].filter(Boolean))];
  if (slugs.length) {
    const placeholders = slugs.map(() => '?').join(',');
    const { results: mine } = await env.DB.prepare(
      `SELECT member_slug, season_number, rating FROM show_ratings
       WHERE tmdb_id = ? AND tmdb_type = ? AND member_slug IN (${placeholders})`
    ).bind(tmdbId, tmdbType, ...slugs).all();
    for (const r of mine) {
      if (viewerSlug && r.member_slug === viewerSlug) {
        if (r.season_number === OVERALL_SEASON) summary.mine = r.rating;
        else summary.mineSeasons[r.season_number] = r.rating;
      }
      if (ownerSlug && ownerSlug !== viewerSlug && r.member_slug === ownerSlug) {
        if (r.season_number === OVERALL_SEASON) summary.owner = r.rating;
        else summary.ownerSeasons[r.season_number] = r.rating;
      }
    }
  }
  return summary;
}

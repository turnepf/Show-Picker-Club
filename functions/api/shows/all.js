// Returns all active shows across every member, for the landing-page
// cross-library search. Includes member info so results can show
// "on Watching · William".
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.network, s.network_url, s.rating, s.movie,
            s.full_series, s.list, s.member_slug, s.genres,
            -- Artwork is per-row and backfills row-by-row; borrow from any
            -- active copy of the same title so no member's result lacks a
            -- poster another member's copy already has.
            COALESCE(s.poster_url, (SELECT x.poster_url FROM shows x
              WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
                AND x.poster_url IS NOT NULL LIMIT 1)) AS poster_url,
            COALESCE(s.network_logo_url, (SELECT x.network_logo_url FROM shows x
              WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
                AND x.network_logo_url IS NOT NULL LIMIT 1)) AS network_logo_url,
            s.seasons_released, s.next_season_date, s.season_end_date,
            m.name AS member_name, m.first_name AS member_first_name,
            (SELECT json_group_array(json_object('name', a.name, 'imdb_id', a.imdb_id))
             FROM actors a WHERE a.show_id = s.id) AS actors
     FROM shows s
     JOIN members m ON m.slug = s.member_slug
     WHERE s.archived = 0
     ORDER BY s.title COLLATE NOCASE`
  ).all();
  return new Response(JSON.stringify({ shows: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

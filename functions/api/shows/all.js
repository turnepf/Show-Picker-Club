// Returns all active shows across every member, for the landing-page
// cross-library search. Includes member info so results can show
// "on Watching · William".
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.network, s.network_url, s.rating, s.movie,
            s.full_series, s.list, s.member_slug, s.genres,
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

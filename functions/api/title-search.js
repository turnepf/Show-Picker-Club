import { getSession } from '../_shared/auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Type-ahead title search for the add/suggest flows. Proxies TMDB so the
// token stays server-side; members pick the exact show while adding it
// instead of the club fixing names after the fact.
//
// GET /api/title-search?q=fargo[&type=tv|movie]
//
// No type (the default) searches TMDB's multi index — one query covers both
// shows and movies, and each result says which it is, so the client can set
// the movie flag from the member's pick instead of asking up front.
// Returns { results: [] } when the query is too short or TMDB isn't
// configured, so clients degrade to plain free-text entry.
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type');
  if (q.length < 2 || !env.TMDB_TOKEN) return json({ results: [] });

  const path = (type === 'tv' || type === 'movie') ? `/search/${type}` : '/search/multi';
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3${path}?query=${encodeURIComponent(q)}&language=en-US&page=1&include_adult=false`,
      { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const data = await res.json();
    const results = (data.results || [])
      // multi also returns people — only titles are pickable
      .filter(r => (r.media_type || type) === 'tv' || (r.media_type || type) === 'movie')
      .slice(0, 8)
      .map(r => {
        const mediaType = r.media_type || type;
        const isMovie = mediaType === 'movie';
        const date = (isMovie ? r.release_date : r.first_air_date) || '';
        return {
          tmdb_id: r.id,
          media_type: mediaType,
          title: (isMovie ? r.title : r.name) || '',
          year: date ? date.slice(0, 4) : null,
          poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
        };
      })
      .filter(r => r.title);
    return json({ results });
  } catch (_) {
    return json({ results: [] });
  }
}

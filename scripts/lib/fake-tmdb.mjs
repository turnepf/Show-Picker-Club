// A stand-in TMDB for endpoint suites that add or edit shows.
//
// Every show is a TMDB entry: an add that TMDB can't identify is refused
// (422 no_match), and one TMDB can't be asked about is "try again later"
// (503). Suites that only care about what happens *after* a show exists use
// this to give every title a believable entry:
//
//   - /search/{tv|movie}?query=X answers one result for X, with a stable id
//     derived from the title and type, so the same title always lands on the
//     same entry and a series and a film of one name are different entries;
//   - /{tv|movie}/{id} answers that entry's detail (name, a date, no cast);
//   - a title in `unknown` gets no results, for the no-match path;
//   - `down: true` answers every request with TMDB's error shape.
//
// It returns null for any URL that isn't TMDB, so a suite can call it first
// inside its own fetch stub and fall through to whatever else it fakes.
//
//   const tmdb = fakeTmdb();
//   globalThis.fetch = async (url, init) => tmdb.respond(url) ?? myOtherFakes(url, init);
//   env.TMDB_TOKEN = 'test-token';

export function tmdbIdFor(title, type = 'tv') {
  let h = 0;
  for (const ch of `${type}:${String(title).trim().toLowerCase()}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 100000 + (h % 800000);
}

export function fakeTmdb({ unknown = [], down = false } = {}) {
  const state = { calls: [], unknown: new Set(unknown.map((t) => t.toLowerCase())), down, entries: new Map() };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  state.respond = (url) => {
    const target = String(url);
    if (!target.startsWith('https://api.themoviedb.org/')) return null;
    state.calls.push(target);
    if (state.down) return json({ success: false, status_code: 7, status_message: 'Service unavailable' }, 503);
    const u = new URL(target);
    const search = u.pathname.match(/\/search\/(tv|movie)$/);
    if (search) {
      const type = search[1];
      const q = (u.searchParams.get('query') || '').trim();
      if (!q || state.unknown.has(q.toLowerCase())) return json({ results: [] });
      const id = tmdbIdFor(q, type);
      state.entries.set(`${type}:${id}`, q);
      return json({
        results: [{
          id,
          [type === 'movie' ? 'title' : 'name']: q,
          [type === 'movie' ? 'release_date' : 'first_air_date']: '2020-01-01',
          poster_path: '/fake.jpg',
        }],
      });
    }
    const detail = u.pathname.match(/\/(tv|movie)\/(\d+)$/);
    if (detail) {
      const [, type, id] = detail;
      const name = state.entries.get(`${type}:${id}`) || `Entry ${id}`;
      return json({
        id: Number(id),
        [type === 'movie' ? 'title' : 'name']: name,
        [type === 'movie' ? 'release_date' : 'first_air_date']: '2020-01-01',
        poster_path: '/fake.jpg',
        genres: [],
        credits: { cast: [], crew: [] },
      });
    }
    return json({});
  };
  return state;
}

// A member's edit keeps the row's TMDB identity — invariant §17 on the edit
// path, where it didn't hold.
//
//   node scripts/show-edit-identity-test.mjs
//
// PUT /api/shows/:id re-enriches on every save. Handed no tmdb_id, it used to
// re-guess the entry from the title, and the UPDATE then stored whatever the
// search returned. Two TMDB entries can share an exact title (the 1974 Little
// House on the Prairie and the 2026 remake), and among same-named entries the
// matcher prefers the newest, so restoring the 1974 show from the archive, or
// editing its notes from a client that doesn't send the id, re-pointed it at
// the remake: new year, poster, overview, cast. The MCP member tools, the web
// edit and restore paths, and an iOS edit of a row nobody picked from
// type-ahead all send no id.
//
// The rule now: an edit that names no id enriches a pinned row by its own pin.
// The title search runs only for a row nothing ever pinned, or when the edit
// changes what the row is (a new title, or a flip between TV and movie, where
// the old pin names an entry in the wrong index). A pinned lookup that fails
// saves the edit without touching identity rather than guessing.
//
// Same harness as scripts/enrich-identity-test.mjs: the functions tree copied
// to a temp directory, schema.sql in node:sqlite behind a D1 shim, and a fake
// TMDB serving two same-titled entries in popularity order.

import { liftCopiesIntoTitles } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'show-edit-identity-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const showApi = await import(join(sandbox, 'functions', 'api/shows/[id].js'));

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fake TMDB ----

const TITLE = 'Little House on the Prairie';
const ORIGINAL = 1234;
const REMAKE = 283304;
const FARGO = 60622;
const FILM = 999;
const GONE = 777; // an entry TMDB no longer serves

const tv = (id, name, year, cast) => ({
  id, name, first_air_date: `${year}-01-01`, overview: `${name} (${year})`, poster_path: `/p${id}.jpg`,
  vote_average: 7.5, vote_count: 100, status: 'Ended', genres: [{ name: 'Drama' }],
  number_of_seasons: 1, number_of_episodes: 10, networks: [{ name: 'NBC', logo_path: `/n${id}.png` }],
  credits: { cast: cast.map((n, i) => ({ id: id * 10 + i, name: n, order: i })) }, external_ids: { imdb_id: `tt${id}` },
});
const TV = {
  [ORIGINAL]: tv(ORIGINAL, TITLE, 1974, ['Michael Landon']),
  [REMAKE]: tv(REMAKE, TITLE, 2026, ['Alice Halsey']),
  [FARGO]: tv(FARGO, 'Fargo', 2014, ['Billy Bob Thornton']),
};
const MOVIES = {
  [FILM]: {
    id: FILM, title: 'Frances Ha', release_date: '2013-05-17', overview: 'Frances.', poster_path: '/fh.jpg',
    vote_average: 7.1, vote_count: 50, genres: [{ name: 'Comedy' }], runtime: 86, status: 'Released',
    credits: { cast: [{ id: 501, name: 'Greta Gerwig', order: 0 }], crew: [] },
  },
};

let fetches = [];
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.themoviedb.org') throw new Error(`unexpected fetch: ${url}`);
  fetches.push(u.pathname);
  const q = (u.searchParams.get('query') || '').toLowerCase();
  if (u.pathname === '/3/search/tv') {
    // Popularity order, the original first. The matcher takes the newest of
    // several exact matches, so a title guess lands on the remake.
    const hit = (id) => ({ id, name: TV[id].name, first_air_date: TV[id].first_air_date, poster_path: TV[id].poster_path });
    if (q === TITLE.toLowerCase()) return jsonRes({ results: [hit(ORIGINAL), hit(REMAKE)] });
    if (q === 'fargo') return jsonRes({ results: [hit(FARGO)] });
    return jsonRes({ results: [] });
  }
  if (u.pathname === '/3/search/movie') {
    return jsonRes({ results: q === 'frances ha' ? [{ id: FILM, title: 'Frances Ha', release_date: '2013-05-17', poster_path: '/fh.jpg' }] : [] });
  }
  let m = u.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (m) return TV[m[1]] ? jsonRes(TV[m[1]]) : jsonRes({ status_message: 'not found' }, 404);
  m = u.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (m) return MOVIES[m[1]] ? jsonRes(MOVIES[m[1]]) : jsonRes({ status_message: 'not found' }, 404);
  m = u.pathname.match(/^\/3\/person\/(\d+)\/external_ids$/);
  if (m) return jsonRes({ imdb_id: `nm${m[1]}` });
  throw new Error(`unexpected fetch: ${url}`);
};

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() { const r = this.db.prepare(this.sql).all(...this.args); return r.length ? { ...r[0] } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('amy', 'Amy''s Shows', 'Amy', 'B', 'email')`).run();
  db.prepare(`INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES ('s-amy', 'amy@example.com', 'amy', ?, ?)`)
    .run(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addShow(env, o = {}) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, archived, tmdb_id, tmdb_type, release_year, overview, poster_url, notes, created_at, updated_at)
     VALUES (?, ?, 'amy', ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`
  ).run(o.title ?? TITLE, o.list ?? 'recommending', o.movie ? 1 : 0, o.archived ? 1 : 0,
    o.tmdb ?? null, o.tmdb ? (o.tmdbType ?? (o.movie ? 'movie' : 'tv')) : null,
    o.year ?? null, o.overview ?? null, o.poster ?? null, o.notes ?? null);
  // Facts seeded on the copy reach the shared row members read from.
  liftCopiesIntoTitles(env._db);
  return Number(r.lastInsertRowid);
}

async function put(env, id, body) {
  fetches = [];
  const res = await showApi.onRequestPut({
    env, params: { id: String(id) }, waitUntil: (p) => p,
    request: new Request(`${ORIGIN}/api/shows/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: 'session=s-amy' }, body: JSON.stringify(body),
    }),
  });
  return res.status;
}

const row = (env, id) => env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id);
const cast = (env, id) => env._db.prepare('SELECT name FROM actors_v WHERE show_id = ? ORDER BY ord').all(id).map((a) => a.name).join(',');
const searched = () => fetches.some((p) => p.startsWith('/3/search/'));

// ---- scenarios ----

console.log('\n== an edit that names no id keeps the pin');
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: ORIGINAL, year: 1974, archived: true });
  const status = await put(env, id, { archived: 0 });
  const r = row(env, id);
  check('restoring the 1974 show succeeds', status === 200, String(status));
  check('it is still the 1974 show', r.tmdb_id === ORIGINAL && r.release_year === 1974, `${r.tmdb_id} ${r.release_year}`);
  check('with the 1974 cast', cast(env, id) === 'Michael Landon', cast(env, id));
  check('fetched by its id, with no title search', !searched(), fetches.join(' '));
  check('and it is restored', r.archived === 0);
}
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: REMAKE, year: 2026, list: 'waiting' });
  await put(env, id, { notes: 'season 2 soon' });
  const r = row(env, id);
  check('a notes edit on the remake keeps the remake', r.tmdb_id === REMAKE && r.release_year === 2026, `${r.tmdb_id} ${r.release_year}`);
  check('and saves the note', r.notes === 'season 2 soon');
}
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: ORIGINAL, year: 1974 });
  await put(env, id, { title: 'little house on the prairie' });
  check('a title that differs only in case is not a new title', row(env, id).tmdb_id === ORIGINAL && !searched(), `${row(env, id).tmdb_id} ${fetches.join(' ')}`);
}
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: ORIGINAL, year: 1974 });
  await put(env, id, { movie: 0, notes: 'x' });
  check('re-sending the same TV/movie flag is not a flip', row(env, id).tmdb_id === ORIGINAL && !searched());
}

console.log('\n== an explicit id still decides');
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: ORIGINAL, year: 1974 });
  await put(env, id, { tmdb_id: REMAKE, tmdb_type: 'tv' });
  const r = row(env, id);
  check('a type-ahead pick re-points the row', r.tmdb_id === REMAKE && r.release_year === 2026, `${r.tmdb_id} ${r.release_year}`);
}

console.log('\n== changing what the row is still searches');
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: ORIGINAL, year: 1974 });
  await put(env, id, { title: 'Fargo' });
  const r = row(env, id);
  check('a new title is looked up by title', searched() && r.tmdb_id === FARGO && r.title === 'Fargo', `${r.tmdb_id} ${fetches.join(' ')}`);
}
{
  const env = makeEnv();
  // A film saved as TV and pinned to a TV entry: the pin is in the wrong index.
  const id = addShow(env, { title: 'Frances Ha', tmdb: ORIGINAL, tmdbType: 'tv', list: 'next' });
  await put(env, id, { movie: 1 });
  const r = row(env, id);
  check('a TV → movie flip searches the movie index', searched() && r.tmdb_id === FILM && r.tmdb_type === 'movie', `${r.tmdb_id}/${r.tmdb_type}`);
}

console.log('\n== a row nothing ever pinned');
{
  const env = makeEnv();
  const id = addShow(env, {});
  await put(env, id, { notes: 'y' });
  const r = row(env, id);
  check('is resolved by title, newest version first', searched() && r.tmdb_id === REMAKE, `${r.tmdb_id}`);
}

console.log('\n== a pinned lookup that fails');
{
  const env = makeEnv();
  const id = addShow(env, { tmdb: GONE, year: 1990, overview: 'kept', poster: '/kept.jpg' });
  const status = await put(env, id, { notes: 'still saves' });
  const r = row(env, id);
  check('the edit is saved', status === 200 && r.notes === 'still saves', `${status} ${r.notes}`);
  check('identity is untouched rather than guessed', r.tmdb_id === GONE && !searched(), `${r.tmdb_id} ${fetches.join(' ')}`);
  check('and the catalog fields are left as they were', r.release_year === 1990 && r.overview === 'kept' && r.poster_url === '/kept.jpg');
}

console.log('\n== someone else\'s copy carries its entry');
{
  // "Add to my list" from a group-mate's show sends this id, so the add is
  // that exact show rather than a title search's guess. The id is a catalog
  // fact; the owner's memos stay owner-only.
  const env = makeEnv();
  env._db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('bea', 'Bea''s Shows', 'Bea', 'C', 'email')`).run();
  env._db.prepare(`INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES ('s-bea', 'bea@example.com', 'bea', ?, ?)`)
    .run(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  const id = addShow(env, { tmdb: REMAKE, year: 2026, notes: 'my private note' });
  const res = await showApi.onRequestGet({
    env, params: { id: String(id) },
    request: new Request(`${ORIGIN}/api/shows/${id}`, { headers: { Cookie: 'session=s-bea' } }),
  });
  const { show } = await res.json();
  check('a group-mate sees which TMDB entry it is', show.tmdb_id === REMAKE && show.tmdb_type === 'tv', JSON.stringify({ id: show.tmdb_id, type: show.tmdb_type }));
  check('and still not the owner\'s note', !('notes' in show) && !JSON.stringify(show).includes('my private note'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

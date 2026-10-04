// Tests that a member's exact TMDB pick survives the background enrichment
// rotation — the rerelease bug (2026-08).
//
//   node scripts/enrich-identity-test.mjs
//
// Two TMDB entries can share one exact title: a remake next to the original
// it remade (Little House on the Prairie, 1974 and 2026). TMDB's search
// orders by popularity, both entries exact-match the title, so any path that
// resolves a row by TITLE lands on the popular original — which is how a
// member who picked the remake from type-ahead watched the 1974 series
// appear on her Watching list: the add stored her pick correctly, then the
// next /api/enrich rotation re-searched the title and overwrote the row
// (poster, year, overview, cast, "Ended") with the other show's data.
//
// The rule pinned here: **a stored tmdb_id is the row's identity.**
//
//   1. The background enrich pass fetches a stored id directly and never
//      re-guesses it from the title. Title search serves only rows with no
//      id yet.
//   2. Title-scoped propagation (catalog fields, cast, artwork, URLs) stops
//      at an identity boundary: a same-titled copy pinned to a DIFFERENT
//      tmdb_id keeps its own data. Grouped queues group by (title, tmdb_id)
//      so each pinned entry gets its own fetch.
//   3. Adding a show never inherits another member's network/URL from a copy
//      pinned to a different entry — that URL streams the wrong show.
//   4. Rows nothing ever pinned still resolve by title search (legacy
//      behavior), and the id they resolve to is stored.
//
// Same harness as scripts/watching-with-test.mjs: functions copied to a temp
// dir as ES modules, schema.sql loaded into node:sqlite behind a D1 shim.
// TMDB is a fake fetch that serves two same-titled entries the way the real
// index does — popular original first.

import { liftCopiesIntoTitles } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'enrich-identity-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const showsApi = await load('api/shows.js');
const enrichApi = await load('api/enrich.js');
const { rebuildTitles } = await load('_shared/titles.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

const D1_MAX_BOUND_PARAMS = 100;

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  guard() {
    if (this.args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(`D1_ERROR: too many bound parameters (${this.args.length} > ${D1_MAX_BOUND_PARAMS})`);
    }
  }
  async first() {
    this.guard();
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    this.guard();
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    this.guard();
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fake TMDB ----

const TITLE = 'Little House on the Prairie';
const ORIGINAL_ID = 197400; // the popular 1974 series — search returns it first
const REMAKE_ID = 202600;   // the 2026 remake the member actually picked
const FARGO_ID = 300;

const baseDetail = {
  videos: { results: [] },
  'watch/providers': { results: {} },
  content_ratings: { results: [] },
  created_by: [],
  genres: [{ name: 'Drama' }],
};

const DETAILS = {
  [ORIGINAL_ID]: {
    ...baseDetail,
    id: ORIGINAL_ID, name: TITLE, first_air_date: '1974-09-11',
    poster_path: '/old-poster.jpg', backdrop_path: '/old-backdrop.jpg',
    overview: 'The classic 1974 series.', tagline: 'Little house, big classic.',
    vote_average: 8.1, vote_count: 1200, status: 'Ended', original_language: 'en',
    number_of_episodes: 204, number_of_seasons: 9, episode_run_time: [45],
    networks: [{ name: 'NBC', logo_path: '/nbc.png' }],
    credits: { cast: [{ id: 11, name: 'Michael Landon', order: 0 }] },
  },
  [REMAKE_ID]: {
    ...baseDetail,
    id: REMAKE_ID, name: TITLE, first_air_date: '2026-03-01',
    poster_path: '/new-poster.jpg', backdrop_path: '/new-backdrop.jpg',
    overview: 'The 2026 reimagining.', tagline: 'The prairie, again.',
    vote_average: 7.4, vote_count: 88, status: 'Returning Series', original_language: 'en',
    number_of_episodes: 8, number_of_seasons: 1, episode_run_time: [52],
    networks: [{ name: 'Netflix', logo_path: '/netflix.png' }],
    credits: { cast: [{ id: 22, name: 'Alice Halsey', order: 0 }] },
  },
  [FARGO_ID]: {
    ...baseDetail,
    id: FARGO_ID, name: 'Fargo', first_air_date: '2014-04-15',
    poster_path: '/fargo.jpg', overview: 'An anthology of true crime.',
    vote_average: 8.3, vote_count: 5000, status: 'Ended',
    number_of_episodes: 51, number_of_seasons: 5, episode_run_time: [53],
    networks: [{ name: 'FX', logo_path: '/fx.png' }],
    credits: { cast: [{ id: 33, name: 'Allison Tolman', order: 0 }] },
  },
};

// Two films sharing one exact title — the movie pass has the same disease
// vector as TV (a 1995 classic next to its 2026 remake).
const MOVIE_ORIGINAL_ID = 199500;
const MOVIE_REMAKE_ID = 202699;
const MOVIE_TITLE = 'Heat';
const MOVIE_DETAILS = {
  [MOVIE_ORIGINAL_ID]: {
    id: MOVIE_ORIGINAL_ID, title: MOVIE_TITLE, release_date: '1995-12-15',
    poster_path: '/heat-1995.jpg', overview: 'The 1995 classic.',
    vote_average: 8.3, vote_count: 7000, runtime: 170, original_language: 'en',
    genres: [{ name: 'Crime' }], production_companies: [{ name: 'Regency' }],
    credits: { cast: [{ id: 44, name: 'Al Pacino', order: 0 }], crew: [{ job: 'Director', id: 55, name: 'Michael Mann' }] },
    videos: { results: [] }, 'watch/providers': { results: {} }, release_dates: { results: [] },
  },
  [MOVIE_REMAKE_ID]: {
    id: MOVIE_REMAKE_ID, title: MOVIE_TITLE, release_date: '2026-06-01',
    poster_path: '/heat-2026.jpg', overview: 'The 2026 sequel-remake.',
    vote_average: 7.0, vote_count: 40, runtime: 150, original_language: 'en',
    genres: [{ name: 'Crime' }], production_companies: [{ name: 'UA' }],
    credits: { cast: [{ id: 66, name: 'Adam Driver', order: 0 }], crew: [{ job: 'Director', id: 55, name: 'Michael Mann' }] },
    videos: { results: [] }, 'watch/providers': { results: {} }, release_dates: { results: [] },
  },
};

const searchHit = (id) => {
  const d = DETAILS[id];
  return { id: d.id, name: d.name, first_air_date: d.first_air_date, poster_path: d.poster_path };
};

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => data,
});

let fetchLog = [];
globalThis.fetch = async (url) => {
  url = String(url);
  fetchLog.push(url);
  const u = new URL(url);
  if (u.pathname === '/3/search/tv') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    // Popularity order, the way the real index answers — and adversarially: a
    // dateless exact-titled junk entry first, then the popular original, then
    // the remake. (Queries arrive with any "(YYYY)" suffix already stripped;
    // the suffixed form returns nothing, like the real index often does.)
    if (q === TITLE.toLowerCase()) {
      const junk = { id: 999999, name: TITLE, first_air_date: '', poster_path: null };
      return jsonRes({ results: [junk, searchHit(ORIGINAL_ID), searchHit(REMAKE_ID)] });
    }
    if (q === 'fargo') return jsonRes({ results: [searchHit(FARGO_ID)] });
    return jsonRes({ results: [] });
  }
  if (u.pathname === '/3/search/movie') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    if (q === MOVIE_TITLE.toLowerCase()) {
      // Popularity order again: the 1995 original first.
      const hit = (id) => ({ id, title: MOVIE_TITLE, release_date: MOVIE_DETAILS[id].release_date, poster_path: MOVIE_DETAILS[id].poster_path });
      return jsonRes({ results: [hit(MOVIE_ORIGINAL_ID), hit(MOVIE_REMAKE_ID)] });
    }
    return jsonRes({ results: [] });
  }
  const movie = u.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (movie) {
    const d = MOVIE_DETAILS[movie[1]];
    return d ? jsonRes(d) : jsonRes({ success: false, status_message: 'not found' }, 404);
  }
  const person = u.pathname.match(/^\/3\/person\/(\d+)\/external_ids$/);
  if (person) return jsonRes({ imdb_id: `nm${person[1].padStart(7, '0')}` });
  const tv = u.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (tv) {
    const d = DETAILS[tv[1]];
    return d ? jsonRes(d) : jsonRes({ success: false, status_message: 'not found' }, 404);
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    TMDB_TOKEN: 'test-token',
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

function addMember(env, slug, name) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial) VALUES (?, ?, ?, ?, ?)'
  ).run(slug, name, first, last || null, last ? last.charAt(0) : null);
  env._db.prepare(
    'INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)'
  ).run(`${slug}@example.com`, slug);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { slug, title, list = 'watching', tmdbId = null, tmdbType = null, network = null, networkUrl = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, tmdb_id, tmdb_type, network, network_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, tmdbId, tmdbType, network, networkUrl, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
}

const rowFor = (env, slug, title) =>
  env._db.prepare('SELECT * FROM shows_v WHERE member_slug = ? AND LOWER(title) = LOWER(?)').all(slug, title).map((r) => ({ ...r }))[0];
const castFor = (env, showId) =>
  env._db.prepare('SELECT name FROM actors_v WHERE show_id = ? ORDER BY ord').all(showId).map((r) => r.name);

function req(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });

const postShow = (env, cookie, body) =>
  showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie, method: 'POST', body })));
// These fixtures describe shows the pre-normalizing way, facts on the copy.
// Each run lifts them into the shared row first, as migration 076 did for
// production, since the passes read gaps from there and members read facts
// from there.
const runEnrich = async (env, cookie, body = {}) => {
  liftCopiesIntoTitles(env._db);
  await rebuildTitles(env);
  return enrichApi.onRequestPost(ctx(env, req('/api/enrich', { cookie, method: 'POST', body })));
};

// Patrick has the 1974 original pinned, with a real deep link. Jennifer is
// about to pick the remake.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'jennifer', 'Jennifer Turner');
  addMember(env, 'quinn', 'Quinn Rosa');
  addShow(env, {
    slug: 'patrick', title: TITLE, tmdbId: ORIGINAL_ID, tmdbType: 'tv',
    network: 'Peacock', networkUrl: 'https://www.peacocktv.com/watch/asset/tv/little-house/1974',
  });
  return env;
}

console.log('\n== picking the remake stores the remake, not the popular original');
{
  const env = club();
  const cookie = addSession(env, 'jennifer');
  const res = await postShow(env, cookie, {
    title: TITLE, list: 'watching', tmdb_id: REMAKE_ID, tmdb_type: 'tv',
  });
  check('add succeeds', res.status === 201, `got ${res.status}`);
  const row = rowFor(env, 'jennifer', TITLE);
  check('the pick is the identity', row.tmdb_id === REMAKE_ID, `got ${row.tmdb_id}`);
  check('remake year, not 1974', row.release_year === 2026, `got ${row.release_year}`);
  check('remake poster', (row.poster_url || '').includes('/new-poster.jpg'), row.poster_url);
  check('remake cast', castFor(env, row.id).join(',') === 'Alice Halsey', castFor(env, row.id).join(','));
  check("does not inherit the original's deep link", row.network_url !== rowFor(env, 'patrick', TITLE).network_url,
    row.network_url || '(null)');
}

console.log('\n== the background enrich pass keeps every pin — no title re-guessing');
{
  const env = club();
  const cookie = addSession(env, 'jennifer');
  await postShow(env, cookie, { title: TITLE, list: 'watching', tmdb_id: REMAKE_ID, tmdb_type: 'tv' });

  fetchLog = [];
  const res = await runEnrich(env, cookie);
  const body = await res.json();
  check('enrich pass ran over both copies', body.tvCandidates === 2 && body.tvErrors === 0,
    JSON.stringify(body));
  check('no title search was needed', !fetchLog.some((u) => u.includes('/search/tv')),
    fetchLog.filter((u) => u.includes('/search')).join(' '));

  const jen = rowFor(env, 'jennifer', TITLE);
  check('the pick survives the rotation', jen.tmdb_id === REMAKE_ID, `got ${jen.tmdb_id}`);
  check('remake poster survives', (jen.poster_url || '').includes('/new-poster.jpg'), jen.poster_url);
  check('remake year survives', jen.release_year === 2026, `got ${jen.release_year}`);
  check('remake overview survives', jen.overview === 'The 2026 reimagining.', jen.overview);
  check('a running remake is not marked complete', jen.full_series === 0, `got ${jen.full_series}`);
  check('remake episode count', jen.episodes_released === 8, `got ${jen.episodes_released}`);
  check('remake cast survives', castFor(env, jen.id).join(',') === 'Alice Halsey', castFor(env, jen.id).join(','));

  const pat = rowFor(env, 'patrick', TITLE);
  check("the original keeps its own identity", pat.tmdb_id === ORIGINAL_ID, `got ${pat.tmdb_id}`);
  check("the original keeps its own poster", (pat.poster_url || '').includes('/old-poster.jpg'), pat.poster_url);
  check("the original keeps its own year", pat.release_year === 1974, `got ${pat.release_year}`);
  check('an ended original is marked complete', pat.full_series === 1, `got ${pat.full_series}`);
  check("the original keeps its own cast", castFor(env, pat.id).join(',') === 'Michael Landon', castFor(env, pat.id).join(','));
}

console.log('\n== gaps mode fetches each pinned entry, not one row per title');
{
  const env = club();
  const cookie = addSession(env, 'jennifer');
  await postShow(env, cookie, { title: TITLE, list: 'watching', tmdb_id: REMAKE_ID, tmdb_type: 'tv' });
  // Wreck both copies the way the rate-limit bug did: no cast, no episode
  // count, but a fresh enriched_at stamp saying "done".
  env._db.prepare('DELETE FROM actors').run();
  env._db.prepare("UPDATE shows SET episodes_released = NULL, enriched_at = datetime('now')").run();
  // Gaps are read from the shared row since normalizing step 3c, so the
  // damage has to reach it too.
  env._db.prepare('DELETE FROM title_cast').run();
  env._db.prepare('UPDATE titles SET episodes_released = NULL').run();

  const body = await (await runEnrich(env, cookie, { mode: 'gaps' })).json();
  check('both pins are their own gap-queue entries', body.tvCandidates === 2 && body.tvErrors === 0,
    JSON.stringify(body));
  const jen = rowFor(env, 'jennifer', TITLE);
  const pat = rowFor(env, 'patrick', TITLE);
  check('remake refilled from the remake', jen.episodes_released === 8 && castFor(env, jen.id).join(',') === 'Alice Halsey',
    `${jen.episodes_released} / ${castFor(env, jen.id).join(',')}`);
  check('original refilled from the original', pat.episodes_released === 204 && castFor(env, pat.id).join(',') === 'Michael Landon',
    `${pat.episodes_released} / ${castFor(env, pat.id).join(',')}`);
}

console.log('\n== a row nothing ever pinned still resolves by title search');
{
  const env = makeEnv();
  addMember(env, 'quinn', 'Quinn Rosa');
  const cookie = addSession(env, 'quinn');
  const id = addShow(env, { slug: 'quinn', title: 'Fargo' });

  fetchLog = [];
  await runEnrich(env, cookie);
  const row = rowFor(env, 'quinn', 'Fargo');
  check('title search still runs for unpinned rows', fetchLog.some((u) => u.includes('/search/tv')));
  check('the resolved id is stored', row.tmdb_id === FARGO_ID, `got ${row.tmdb_id}`);
  check('and the data lands', (row.poster_url || '').includes('/fargo.jpg') && row.release_year === 2014,
    `${row.poster_url} / ${row.release_year}`);
  check('cast lands too', castFor(env, id).join(',') === 'Allison Tolman', castFor(env, id).join(','));
}

console.log('\n== a bare title means the newest version, and a "(YYYY)" suffix pins its own');
{
  // Three unpinned copies of the remade title: a bare one, and one suffixed
  // for each era — the shape real rows arrived in when TMDB's own entry was
  // named "Little House on the Prairie (2026)".
  const env = makeEnv();
  addMember(env, 'quinn', 'Quinn Rosa');
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'jennifer', 'Jennifer Turner');
  const bareId = addShow(env, { slug: 'quinn', title: TITLE });
  const newId = addShow(env, { slug: 'jennifer', title: `${TITLE} (2026)` });
  const oldId = addShow(env, { slug: 'patrick', title: `${TITLE} (1974)` });

  await runEnrich(env, addSession(env, 'quinn'));
  const bare = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(bareId) };
  const suffNew = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(newId) };
  const suffOld = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(oldId) };
  check('a bare title resolves to the newest version, not the popular original',
    bare.tmdb_id === REMAKE_ID, `got ${bare.tmdb_id}`);
  check('a dateless junk entry never wins, however popular', bare.tmdb_id !== 999999);
  check('"(2026)" resolves to the 2026 entry — the suffix searches stripped, picks pinned',
    suffNew.tmdb_id === REMAKE_ID && (suffNew.poster_url || '').includes('/new-poster.jpg'),
    `${suffNew.tmdb_id} / ${suffNew.poster_url}`);
  check('"(1974)" still gets the original — the year hint outranks newest',
    suffOld.tmdb_id === ORIGINAL_ID && suffOld.release_year === 1974,
    `${suffOld.tmdb_id} / ${suffOld.release_year}`);
}

console.log('\n== the movie pass honors pins the same way');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'jennifer', 'Jennifer Turner');
  // Both copies qualify for the movie pass (no poster yet), pinned to two
  // different films that share the title.
  const patId = addShow(env, { slug: 'patrick', title: MOVIE_TITLE, tmdbId: MOVIE_ORIGINAL_ID, tmdbType: 'movie' });
  const jenId = addShow(env, { slug: 'jennifer', title: MOVIE_TITLE, tmdbId: MOVIE_REMAKE_ID, tmdbType: 'movie' });
  env._db.prepare('UPDATE shows SET movie = 1').run();

  fetchLog = [];
  const body = await (await runEnrich(env, addSession(env, 'jennifer'))).json();
  check('both pins get their own fetch', body.movieCandidates === 2 && body.movieErrors === 0,
    JSON.stringify(body));
  check('no movie title search was needed', !fetchLog.some((u) => u.includes('/search/movie')),
    fetchLog.filter((u) => u.includes('/search')).join(' '));
  const pat = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(patId) };
  const jen = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(jenId) };
  check('the original film keeps its identity', (pat.poster_url || '').includes('/heat-1995.jpg') && pat.release_year === 1995,
    `${pat.poster_url} / ${pat.release_year}`);
  check('the remake film keeps its identity', (jen.poster_url || '').includes('/heat-2026.jpg') && jen.release_year === 2026,
    `${jen.poster_url} / ${jen.release_year}`);
  check('overviews do not cross', pat.overview === 'The 1995 classic.' && jen.overview === 'The 2026 sequel-remake.',
    `${pat.overview} / ${jen.overview}`);

  // An unpinned movie still resolves by search — and a bare title means the
  // newest version there too, not the popularity-ranked original.
  addMember(env, 'quinn', 'Quinn Rosa');
  const unpinnedId = addShow(env, { slug: 'quinn', title: MOVIE_TITLE });
  env._db.prepare('UPDATE shows SET movie = 1 WHERE id = ?').run(unpinnedId);
  fetchLog = [];
  await runEnrich(env, addSession(env, 'quinn'));
  const unpinned = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(unpinnedId) };
  check('an unpinned movie resolves by search', fetchLog.some((u) => u.includes('/search/movie')));
  check('and a bare movie title means the newest version', unpinned.tmdb_id === MOVIE_REMAKE_ID, `got ${unpinned.tmdb_id}`);
}

console.log('\n== artwork never crosses the identity boundary');
{
  const env = club();
  // An unpinned second copy of the title may borrow the original's poster;
  // a copy pinned to the remake may not.
  const unpinnedId = addShow(env, { slug: 'jennifer', title: TITLE });
  const pinnedId = addShow(env, { slug: 'quinn', title: TITLE, tmdbId: REMAKE_ID, tmdbType: 'tv' });
  env._db.prepare('UPDATE shows SET poster_url = ? WHERE member_slug = ?').run('https://image.tmdb.org/t/p/w500/old-poster.jpg', 'patrick');

  const cookie = addSession(env, 'jennifer');
  // posters mode runs the artwork sync first; the fake TMDB then answers by
  // stored id, so the pinned copy comes back with its own art, not borrowed.
  await runEnrich(env, cookie, { mode: 'posters' });
  const unpinned = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(unpinnedId) };
  const pinned = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(pinnedId) };
  // Since normalizing step 3c an unpinned copy isn't papered over with a
  // sibling's poster: it has no shared row, so it's looked up and pinned to
  // its own entry, which is what the borrowed poster never fixed.
  check('an unpinned copy is looked up and pinned rather than borrowing', !!unpinned.tmdb_id, String(unpinned.tmdb_id));
  check("a pinned copy never wears the other entry's poster",
    !(pinned.poster_url || '').includes('/old-poster.jpg'), pinned.poster_url);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

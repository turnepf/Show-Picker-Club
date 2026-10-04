// Migration 073's fields, and the order the rotation fills them in.
//
//   node scripts/enrich-imdb-status-test.mjs
//
// Four facts rode in on the TMDB detail call enrichment already makes and were
// thrown away: the title's IMDb id, TMDB's status word, the free / free-with-
// ads services, and each cast member's character. None is backfilled — the
// ordinary rotation stores them as titles come round — so the property that
// matters as much as the storing is the ORDER: Watching and Next Up are the
// lists members actually open, so a row on one of them that hasn't been
// through a pass since 073 goes ahead of the age rotation. Only that far,
// though: a hot-list row that already has the fields must not jump the age
// queue, or a long Watching list would take every slot every night and the
// rest of the library would never be refreshed.
//
// Pinned here:
//   1. The TV pass stores imdb_id (from the appended external_ids), the
//      status verbatim, free_on (known names only, Tubi mapped, an unknown
//      provider dropped) and character names, and propagates the catalog
//      fields to a sibling copy.
//   2. The movie pass reads imdb_id off the top level of the payload, writes
//      free_on as '' when TMDB answered and named no free service, and leaves
//      free_on NULL when the payload carried no provider block at all.
//   3. A malformed IMDb id is never stored (it goes straight into a URL).
//   4. Ordering: a Watching row missing the fields beats an older complete
//      Loved row; a Watching row that already has them does not; a real gap
//      still beats both. Movies mode does the same for Next Up.
//   5. GET /api/shows/:id/actors returns the character.
//
// Same harness as scripts/enrich-movie-detail-test.mjs.

import { liftCopiesIntoTitles } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'enrich-imdb-status-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const enrichApi = await import(join(sandbox, 'functions', 'api/enrich.js'));
const { rebuildTitles } = await import(join(sandbox, 'functions', '_shared/titles.js'));
const actorsApi = await import(join(sandbox, 'functions', 'api/shows/[id]/actors.js'));

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fake TMDB ----

const SERIES = {
  // Every series is complete in TMDB, so what a pass stores depends only on
  // whether the row was selected.
  701: { name: 'Severance', status: 'Returning Series', imdb: 'tt11280740' },
  702: { name: 'Succession', status: 'Ended', imdb: 'tt7660850' },
  703: { name: 'Lodge 49', status: 'Canceled', imdb: 'tt6878486' },
  704: { name: 'The Bear', status: 'Returning Series', imdb: 'tt14452776' },
  // TMDB's external_ids sometimes carries junk; it must never reach a URL.
  705: { name: 'Broken Id', status: 'Ended', imdb: 'javascript:alert(1)' },
};

const FILMS = {
  801: { title: 'Sinners', imdb: 'tt31193180', free: false },
  // No provider block at all in the payload: TMDB was not asked about
  // providers, so free_on must stay NULL rather than read "asked, none".
  802: { title: 'Conclave', imdb: 'tt20215234', noProviders: true },
  803: { title: 'Flow', imdb: 'tt4772188', free: false },
};

const tvDetail = (id) => {
  const s = SERIES[id];
  return {
    id: Number(id), name: s.name, first_air_date: '2022-02-18', status: s.status,
    poster_path: `/${id}.jpg`, overview: `${s.name}.`, vote_average: 8.4, vote_count: 900,
    number_of_episodes: 19, number_of_seasons: 2, episode_run_time: [50],
    genres: [{ name: 'Drama' }], networks: [{ name: 'Apple TV+', logo_path: '/atv.png' }],
    created_by: [],
    credits: { cast: [
      { id: 9000 + Number(id), name: `${s.name} Lead`, character: '  Mark S.  ', order: 0 },
      { id: 9100 + Number(id), name: `${s.name} Second`, character: '', order: 1 },
    ] },
    external_ids: { imdb_id: s.imdb },
    videos: { results: [] }, content_ratings: { results: [] },
    'watch/providers': { results: { US: {
      link: 'https://tmdb/watch',
      flatrate: [{ provider_name: 'Apple TV Plus', display_priority: 1 }],
      // Free and with-ads: a known network (Pluto TV), a free service mapped
      // by name (Tubi TV → Tubi), and one we can't name, which is dropped.
      ads: [{ provider_name: 'Tubi TV', display_priority: 3 },
            { provider_name: 'Pluto TV', display_priority: 2 }],
      free: [{ provider_name: 'Some Obscure FAST Channel', display_priority: 1 }],
    } } },
  };
};

const movieDetail = (id) => {
  const f = FILMS[id];
  const out = {
    id: Number(id), title: f.title, release_date: '2025-04-18', status: 'Released',
    imdb_id: f.imdb, poster_path: `/${id}.jpg`, overview: `${f.title}.`, tagline: 't',
    vote_average: 7.7, vote_count: 900, runtime: 120, original_language: 'en',
    genres: [{ name: 'Drama' }], production_companies: [{ name: 'A24' }],
    credits: { cast: [{ id: 9500 + Number(id), name: `${f.title} Lead`, character: 'Smoke', order: 0 }],
               crew: [] },
    videos: { results: [] }, release_dates: { results: [] },
  };
  if (!f.noProviders) {
    out['watch/providers'] = { results: { US: { link: 'https://tmdb/watch',
      flatrate: [{ provider_name: 'Max', display_priority: 1 }] } } };
  }
  return out;
};

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => data,
});

let fetchLog = [];
globalThis.fetch = async (url) => {
  url = String(url);
  fetchLog.push(url);
  const u = new URL(url);
  const tv = u.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (tv) return SERIES[tv[1]] ? jsonRes(tvDetail(tv[1])) : jsonRes({ success: false }, 404);
  const movie = u.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (movie) return FILMS[movie[1]] ? jsonRes(movieDetail(movie[1])) : jsonRes({ success: false }, 404);
  const person = u.pathname.match(/^\/3\/person\/(\d+)\/external_ids$/);
  if (person) return jsonRes({ imdb_id: `nm${person[1].padStart(7, '0')}` });
  if (u.pathname === '/3/search/tv' || u.pathname === '/3/search/movie') return jsonRes({ results: [] });
  throw new Error(`unexpected fetch: ${url}`);
};

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  for (const [slug, name] of [['patrick', 'Patrick Turner'], ['amy', 'Amy Turner']]) {
    db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run(slug, name, name.split(' ')[0]);
  }
  db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run('patrick@example.com', 'patrick');
  db.prepare('INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('sess', 'patrick@example.com', 'patrick', new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return {
    TMDB_TOKEN: 'test-token',
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

// A row with no gap for the old gates to find: poster, cast (ids resolved, so
// the actor backfill stays out of it), episode count, genres, streaming_on.
// `filled` says whether a post-073 pass has already been through it.
function addRow(env, { title, tmdbId, list, movie = 0, member = 'patrick', enrichedAt, filled = false, gap = false }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, poster_url, network,
                        genres, overview, runtime, episodes_released, streaming_on, tmdb_status,
                        enriched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '/have.jpg', 'Max', 'Drama', 'here', 50, ?, '', ?, ?, '2026-01-01', '2026-01-01')`
  ).run(title, list, member, movie, tmdbId, movie ? 'movie' : 'tv',
        movie ? null : (gap ? null : 10), filled ? 'Ended' : null, enrichedAt);
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
  env._db.prepare('INSERT INTO actors (show_id, name, imdb_id, ord) VALUES (?, ?, ?, 0)').run(id, `${title} Lead`, 'nm0000001');
  return id;
}

const row = (env, id) => ({ ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id) });

// These fixtures describe shows the pre-normalizing way, facts on the copy.
// Each run lifts them into the shared row first, as migration 076 did for
// production, since the passes read gaps from there and members read facts
// from there.
const runEnrich = async (env, body = {}) => {
  liftCopiesIntoTitles(env._db);
  await rebuildTitles(env);
  return enrichApi.onRequestPost({
  env,
  request: new Request(ORIGIN + '/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'session=sess' },
    body: JSON.stringify(body),
  }),
  waitUntil: () => {},
  });
};

const fetchedTv = () => fetchLog.map((u) => new URL(u).pathname.match(/^\/3\/tv\/(\d+)$/)).filter(Boolean).map((m) => Number(m[1]));
const fetchedMovies = () => fetchLog.map((u) => new URL(u).pathname.match(/^\/3\/movie\/(\d+)$/)).filter(Boolean).map((m) => Number(m[1]));

// ---------------------------------------------------------------- 1

console.log('\nThe TV pass stores the four new facts and propagates them');
{
  const env = makeEnv();
  const mine = addRow(env, { title: 'Severance', tmdbId: 701, list: 'watching', enrichedAt: '2026-09-01' });
  // Amy's copy of the same entry, archived so the rotation picks Patrick's.
  const hers = addRow(env, { title: 'Severance', tmdbId: 701, list: 'loved', member: 'amy', enrichedAt: '2026-09-02' });
  env._db.prepare('UPDATE shows SET archived = 1 WHERE id = ?').run(hers);

  fetchLog = [];
  await runEnrich(env, { max_tmdb: 1 });
  const a = row(env, mine);
  const b = row(env, hers);
  check('the TV detail call appends external_ids',
    fetchLog.some((u) => u.includes('/3/tv/701?') && u.includes('external_ids')), fetchLog.join(' '));
  check('imdb_id stored from external_ids', a.imdb_id === 'tt11280740', a.imdb_id);
  check('status stored verbatim', a.tmdb_status === 'Returning Series', a.tmdb_status);
  check('free_on keeps known names in priority order, maps Tubi, drops the unknown',
    a.free_on === 'Pluto TV, Tubi', JSON.stringify(a.free_on));
  check('sibling copy receives imdb_id', b.imdb_id === 'tt11280740', b.imdb_id);
  check('sibling copy receives status and free_on',
    b.tmdb_status === 'Returning Series' && b.free_on === 'Pluto TV, Tubi', `${b.tmdb_status} / ${b.free_on}`);

  const cast = env._db.prepare('SELECT name, character_name FROM actors_v WHERE show_id = ? ORDER BY ord').all(mine);
  check('character stored, trimmed', cast[0]?.character_name === 'Mark S.', JSON.stringify(cast));
  check('an uncredited role is NULL, not empty', cast[1] && cast[1].character_name === null, JSON.stringify(cast[1]));
  const sibCast = env._db.prepare('SELECT character_name FROM actors_v WHERE show_id = ? ORDER BY ord').all(hers);
  check('sibling cast carries characters too', sibCast[0]?.character_name === 'Mark S.', JSON.stringify(sibCast));

  // 5. the actors endpoint hands it to the apps
  const res = await actorsApi.onRequestGet({ env, params: { id: String(mine) } });
  const body = await res.json();
  check('GET /api/shows/:id/actors returns character',
    body.actors?.[0]?.character === 'Mark S.' && body.actors?.[0]?.name === 'Severance Lead', JSON.stringify(body));
}

// ---------------------------------------------------------------- 2 + 3

console.log('\nThe movie pass: top-level imdb_id, asked-vs-never-asked free_on');
{
  const env = makeEnv();
  const sinners = addRow(env, { title: 'Sinners', tmdbId: 801, list: 'next', movie: 1, enrichedAt: '2026-09-01' });
  const conclave = addRow(env, { title: 'Conclave', tmdbId: 802, list: 'next', movie: 1, enrichedAt: '2026-09-02' });
  await runEnrich(env, { mode: 'movies', max_tmdb: 2 });
  const s = row(env, sinners);
  const c = row(env, conclave);
  check('movie imdb_id read from the top level', s.imdb_id === 'tt31193180', s.imdb_id);
  check('movie status stored', s.tmdb_status === 'Released', s.tmdb_status);
  check("free_on is '' when TMDB answered and named no free service", s.free_on === '', JSON.stringify(s.free_on));
  check('free_on stays NULL when the payload had no provider block', c.free_on === null, JSON.stringify(c.free_on));
  check('…while the rest of that payload is still stored', c.imdb_id === 'tt20215234' && c.tmdb_status === 'Released');
}
{
  const env = makeEnv();
  const id = addRow(env, { title: 'Broken Id', tmdbId: 705, list: 'watching', enrichedAt: '2026-09-01' });
  await runEnrich(env, { max_tmdb: 1 });
  const r = row(env, id);
  check('a malformed IMDb id is not stored', r.imdb_id === null, r.imdb_id);
  check('…but the pass still marks the row done', r.tmdb_status === 'Ended', r.tmdb_status);
}

// ---------------------------------------------------------------- 4

console.log('\nWatching and Next Up get the new fields first, without starving the rest');
{
  const env = makeEnv();
  // Oldest in the age rotation, on a list nobody opens much.
  addRow(env, { title: 'Succession', tmdbId: 702, list: 'loved', enrichedAt: '2026-08-01' });
  // Newer, but on Watching and never through a post-073 pass.
  addRow(env, { title: 'The Bear', tmdbId: 704, list: 'watching', enrichedAt: '2026-09-20' });
  fetchLog = [];
  await runEnrich(env, { max_tmdb: 1 });
  check('a Watching row missing the fields beats an older complete Loved row',
    fetchedTv()[0] === 704, JSON.stringify(fetchedTv()));
}
{
  const env = makeEnv();
  addRow(env, { title: 'Succession', tmdbId: 702, list: 'loved', enrichedAt: '2026-08-01' });
  addRow(env, { title: 'The Bear', tmdbId: 704, list: 'watching', enrichedAt: '2026-09-20', filled: true });
  fetchLog = [];
  await runEnrich(env, { max_tmdb: 1 });
  check('a Watching row that already has them waits its turn in the age rotation',
    fetchedTv()[0] === 702, JSON.stringify(fetchedTv()));
}
{
  const env = makeEnv();
  addRow(env, { title: 'The Bear', tmdbId: 704, list: 'watching', enrichedAt: '2026-08-01' });
  // A real gap (no episode count) on a cold list, newer than the hot row.
  addRow(env, { title: 'Lodge 49', tmdbId: 703, list: 'loved', enrichedAt: '2026-09-01', gap: true });
  fetchLog = [];
  await runEnrich(env, { max_tmdb: 1 });
  check('a real gap still goes ahead of a hot row missing only the new fields',
    fetchedTv()[0] === 703, JSON.stringify(fetchedTv()));
}
{
  const env = makeEnv();
  addRow(env, { title: 'The Bear', tmdbId: 704, list: 'loved', enrichedAt: '2026-08-01', gap: true });
  addRow(env, { title: 'Lodge 49', tmdbId: 703, list: 'next', enrichedAt: '2026-09-01', gap: true });
  fetchLog = [];
  await runEnrich(env, { max_tmdb: 1 });
  check('among real gaps, Next Up goes before an older Loved row',
    fetchedTv()[0] === 703, JSON.stringify(fetchedTv()));
}
{
  const env = makeEnv();
  addRow(env, { title: 'Flow', tmdbId: 803, list: 'loved', movie: 1, enrichedAt: '2026-08-01' });
  addRow(env, { title: 'Sinners', tmdbId: 801, list: 'next', movie: 1, enrichedAt: '2026-09-20' });
  fetchLog = [];
  await runEnrich(env, { mode: 'movies', max_tmdb: 1 });
  check('movies mode: a Next Up film missing the fields beats an older Loved film',
    fetchedMovies()[0] === 801, JSON.stringify(fetchedMovies()));
}
{
  const env = makeEnv();
  addRow(env, { title: 'Flow', tmdbId: 803, list: 'loved', movie: 1, enrichedAt: '2026-08-01' });
  addRow(env, { title: 'Sinners', tmdbId: 801, list: 'next', movie: 1, enrichedAt: '2026-09-20', filled: true });
  fetchLog = [];
  await runEnrich(env, { mode: 'movies', max_tmdb: 1 });
  check('movies mode: a filled Next Up film does not jump the age rotation',
    fetchedMovies()[0] === 803, JSON.stringify(fetchedMovies()));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

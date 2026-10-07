// A memo-only save never reaches TMDB.
//
//   node scripts/memo-save-test.mjs
//
// The show card edits Notes and Watching With in place and saves every time
// the member leaves a field (there's no edit screen any more). PUT
// /api/shows/:id used to re-enrich on every save, so each of those saves
// made a TMDB round trip and charged a lookup to the member's daily ceiling
// (migration 072, member_spend) for fields no catalog lookup feeds.
//
// The rule: a body whose only changes are memos (notes, watching_with,
// recommended_by, watcher_slugs) writes them and nothing else. Both client
// shapes count — the web sends just the memo, the iOS card sends the whole
// row back as it was. Any real change beside the memo (list, service,
// title, TV/movie, archived, a new pick) still takes the full path, and so
// does a body with no memo at all, exactly as before.
//
// Same harness as show-edit-identity-test.mjs: the functions tree copied to
// a temp directory, schema.sql in node:sqlite behind a D1 shim, a fake TMDB
// that records every request.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'memo-save-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const showApi = await import(join(sandbox, 'functions', 'api/shows/[id].js'));

const ORIGIN = 'https://showpicker.club';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fake TMDB: one show, every request recorded ----

const SEV = 95396;
const SHOW = {
  id: SEV, name: 'Severance', first_air_date: '2022-02-18', overview: 'Fresh from TMDB.', poster_path: '/sev.jpg',
  vote_average: 8.4, vote_count: 900, status: 'Returning Series', genres: [{ name: 'Drama' }],
  number_of_seasons: 2, number_of_episodes: 19, networks: [{ name: 'Apple TV+', logo_path: '/atv.png' }],
  credits: { cast: [{ id: 1, name: 'Adam Scott', order: 0 }] }, external_ids: { imdb_id: 'tt11280740' },
};
let fetches = [];
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  fetches.push(u.hostname + u.pathname);
  if (u.hostname !== 'api.themoviedb.org') return jsonRes({}, 404);
  if (u.pathname === `/3/tv/${SEV}`) return jsonRes(SHOW);
  if (u.pathname === '/3/search/tv') return jsonRes({ results: [{ id: SEV, name: 'Severance', first_air_date: '2022-02-18' }] });
  if (u.pathname.startsWith('/3/person/')) return jsonRes({ imdb_id: 'nm1' });
  return jsonRes({ status_message: 'not found' }, 404);
};

// ---- D1 shim over node:sqlite ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('amy', 'Amy''s Shows', 'Amy', 'B', 'email')`).run();
  db.prepare(`INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES ('s-amy', 'amy@example.com', 'amy', ?, ?)`)
    .run(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addShow(env) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, network, network_url, movie, full_series, archived, tmdb_id, tmdb_type,
                        overview, notes, watching_with, recommended_by, created_at, updated_at)
     VALUES ('Severance', 'watching', 'amy', 'Apple TV+', 'https://tv.apple.com/us/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx',
             0, NULL, 0, ?, 'tv', 'Stored overview.', 'old note', 'Ali', 'Rosa',
             '2026-09-01 00:00:00', '2026-09-01 00:00:00')`
  ).run(SEV);
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
  return { status: res.status, json: await res.json() };
}

const row = (env, id) => env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id);
const lookupsCharged = (env) =>
  env._db.prepare(`SELECT COALESCE(SUM(lookups), 0) AS n FROM member_spend WHERE member_slug = 'amy'`).get().n;

// What the iOS card sends: the row exactly as it is, memos edited.
const iosBody = (overrides = {}) => ({
  title: 'Severance', network: 'Apple TV+', list: 'watching', notes: 'old note', recommended_by: 'Rosa',
  movie: 0, full_series: 0, watching_with: 'Ali', archived: 0, ...overrides,
});

// ---- scenarios ----

console.log('\n== a memo-only save writes the memo and nothing else');
{
  const env = makeEnv();
  const id = addShow(env);
  const { status, json } = await put(env, id, { notes: 'S2 finale was wild' });
  const r = row(env, id);
  check('the web shape (just the memo) saves', status === 200 && r.notes === 'S2 finale was wild', `${status} ${r.notes}`);
  check('without any outside request', fetches.length === 0, fetches.join(' '));
  check('and charges no lookup', lookupsCharged(env) === 0, String(lookupsCharged(env)));
  check('it is the member talking, so updated_at moves', r.updated_at !== '2026-09-01 00:00:00', r.updated_at);
  check('the catalog details are left alone', r.overview === 'Stored overview.', r.overview);
  check('the other memos are kept', r.watching_with === 'Ali' && r.recommended_by === 'Rosa', `${r.watching_with} ${r.recommended_by}`);
  check('the response carries the saved row', json.show && json.show.notes === 'S2 finale was wild' && Array.isArray(json.show.watchers));
}
{
  const env = makeEnv();
  const id = addShow(env);
  const { status } = await put(env, id, iosBody({ notes: 'from the phone', watching_with: 'Ali, Bob', watcher_slugs: [] }));
  const r = row(env, id);
  check('the iOS shape (whole row, memos changed) saves', status === 200 && r.notes === 'from the phone' && r.watching_with === 'Ali, Bob', `${status} ${r.notes} ${r.watching_with}`);
  check('also without any outside request', fetches.length === 0, fetches.join(' '));
  check('and charges no lookup', lookupsCharged(env) === 0);
  check('the stored watch link survives', r.network_url.startsWith('https://tv.apple.com/'), r.network_url);
}
{
  const env = makeEnv();
  const id = addShow(env);
  await put(env, id, iosBody({ network: 'apple tv+', title: 'severance', full_series: null, notes: 'case' }));
  check('same values spelled differently still count as unchanged', fetches.length === 0 && row(env, id).notes === 'case', fetches.join(' '));
}
{
  const env = makeEnv();
  const id = addShow(env);
  await put(env, id, { notes: null });
  check('clearing a note is a memo save too', row(env, id).notes === null && fetches.length === 0);
}

console.log('\n== anything more than a memo takes the full path');
for (const [name, body, verify] of [
  ['a list move', { notes: 'n', list: 'waiting' }, (r) => r.list === 'waiting'],
  ['a service change', iosBody({ notes: 'n', network: 'Hulu' }), (r) => r.network === 'Hulu'],
  ['an archive', { notes: 'n', archived: 1 }, (r) => r.archived === 1],
  ['a TV/movie flip', iosBody({ notes: 'n', movie: 1 }), () => true],
  ['a new type-ahead pick', { notes: 'n', tmdb_id: 12345, tmdb_type: 'tv' }, () => true],
]) {
  const env = makeEnv();
  const id = addShow(env);
  await put(env, id, body);
  check(`${name} still looks the show up`, fetches.some((f) => f.startsWith('api.themoviedb.org')), fetches.join(' '));
  check(`${name} still charges the lookup`, lookupsCharged(env) === 1, String(lookupsCharged(env)));
  check(`${name} is applied`, verify(row(env, id)));
}
{
  const env = makeEnv();
  const id = addShow(env);
  await put(env, id, { list: 'watching' });
  check('a body with no memo at all behaves as before', fetches.length > 0 && lookupsCharged(env) === 1, fetches.join(' '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

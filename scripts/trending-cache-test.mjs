// Tests for /api/popular's daily snapshot (migration 067).
//
//   node scripts/trending-cache-test.mjs
//
// Trending became a once-per-UTC-day computation after bot traffic against
// the public endpoint burned the free tier's entire daily D1 rows_read
// budget on 2026-09-01 and took the API down. The properties worth pinning
// are the ones that keep the cache both cheap and honest:
//
//   1. The first request of a day computes and stores the snapshot; every
//      later request that day serves the stored ranking — observable because
//      a title added AFTER the snapshot does not trend until the day rolls.
//   2. The snapshot always holds the full TRENDING_MAX ranking, whatever the
//      first request asked for — a later ?limit= expansion must page the same
//      cached ranking, not come back short (or force a recompute).
//   3. A stale (yesterday's) snapshot is replaced, not served — and the table
//      stays at one row rather than accumulating a row per day.
//   4. Nothing session-scoped is cached. Member NAMES are resolved fresh per
//      request from the cached slugs: logged out sees no names, a group-mate
//      sees them, a logged-in stranger doesn't, and the raw member_slugs
//      never reach any response — same three-tier rule as before the cache.
//   5. A corrupt snapshot recomputes instead of erroring — cache poisoning
//      must not be able to take down a public endpoint.
//   6. A database that predates migration 067 (no trending_cache table at
//      all) still serves Trending — the cache degrades to the old
//      compute-per-request behavior rather than throwing.
//
// Same harness as scripts/vibe-scope-test.mjs.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'trending-cache-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const popular = await load('api/popular.js');

const ORIGIN = 'https://showpicker.club';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    // D1 refuses >100 bound parameters (docs/INVARIANTS.md §15); node:sqlite
    // doesn't, so enforce it here or an unchunked query passes on a laptop.
    if (args.length > 100) throw new Error(`too many SQL parameters: ${args.length}`);
    return new Stmt(this.db, this.sql, args.map(a => (a === undefined ? null : a)));
  }
  async first() { const r = this.db.prepare(this.sql).all(...this.args); return r.length ? { ...r[0] } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(r => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes ?? 0) } }; }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

function addMember(env, slug) {
  env._db.prepare('INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?,?,?,0,0)')
    .run(slug, `${slug}'s Shows`, slug);
}
function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare('INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}
function addShow(env, { slug, title, list = 'watching' }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, added_by, archived, created_at)
     VALUES (?,?,?,'member',0,?)`
  ).run(title, list, slug, new Date().toISOString());
}
function addGroup(env, name, creator, members) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?,?)').run(name, creator);
  const id = env._db.prepare('SELECT MAX(id) AS id FROM groups').get().id;
  for (const m of members) {
    env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?,?)').run(id, m);
  }
  return id;
}
const cacheRow = (env) => env._db.prepare('SELECT day, payload FROM trending_cache').all();

const req = (path, session) => new Request(`${ORIGIN}${path}`, {
  headers: session ? { Cookie: `session=${session}` } : {},
});
const body = async (res) => JSON.parse(await res.text());
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

console.log('\n== First request computes the snapshot; the rest of the day serves it');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'Severance' });

  const first = await popular.onRequestGet({ env, request: req('/api/popular') });
  check('first request is 200', first.status === 200);
  check('first request trends the existing title',
        (await body(first)).shows.some(s => s.title === 'Severance'));
  const rows = cacheRow(env);
  check('snapshot row stored for today', rows.length === 1 && rows[0].day === today,
        JSON.stringify(rows.map(r => r.day)));

  // A title added after the snapshot must NOT trend today — that invisibility
  // is the observable proof later requests read the cache, not the tables.
  addShow(env, { slug: 'patrick', title: 'Added After Snapshot' });
  const later = await body(await popular.onRequestGet({ env, request: req('/api/popular') }));
  check('a title added after the snapshot waits for tomorrow',
        !later.shows.some(s => s.title === 'Added After Snapshot'),
        later.shows.map(s => s.title).join(','));
}

console.log('\n== The snapshot holds the full ranking, whatever the first request asked');
{
  const env = makeEnv();
  for (let i = 0; i < 25; i++) {
    const slug = `m${i}`;
    addMember(env, slug);
    for (let j = 0; j <= i; j++) addShow(env, { slug, title: `Title ${j}` });
  }
  const dflt = await body(await popular.onRequestGet({ env, request: req('/api/popular') }));
  check('default request returns ten', dflt.shows.length === 10, `got ${dflt.shows.length}`);
  const more = await body(await popular.onRequestGet({ env, request: req('/api/popular?limit=25') }));
  check('?limit=25 after a default call still returns 25 from the cache',
        more.shows.length === 25, `got ${more.shows.length}`);
  check('the expansion did not recompute (still one snapshot row)',
        cacheRow(env).length === 1);
}

console.log('\n== Yesterday\'s snapshot is replaced, and the table stays at one row');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'Old News' });
  await popular.onRequestGet({ env, request: req('/api/popular') });

  // Roll the stored snapshot back a day and add a new hot title.
  env._db.prepare('UPDATE trending_cache SET day = ?').run(yesterday);
  addShow(env, { slug: 'patrick', title: 'Fresh Today' });

  const b = await body(await popular.onRequestGet({ env, request: req('/api/popular') }));
  check('a stale snapshot recomputes', b.shows.some(s => s.title === 'Fresh Today'),
        b.shows.map(s => s.title).join(','));
  const rows = cacheRow(env);
  check('yesterday\'s row is gone', rows.length === 1 && rows[0].day === today,
        JSON.stringify(rows.map(r => r.day)));
}

console.log('\n== Names come from the session, never the cache');
{
  const env = makeEnv();
  for (const slug of ['patrick', 'whitt', 'stranger']) addMember(env, slug);
  addGroup(env, 'Family', 'patrick', ['patrick', 'whitt']);
  addShow(env, { slug: 'whitt', title: 'Poker Face' });
  const sPatrick = addSession(env, 'patrick');
  const sStranger = addSession(env, 'stranger');

  // Prime the cache logged OUT, so any leak would have to come from the cache.
  const anon = await body(await popular.onRequestGet({ env, request: req('/api/popular') }));
  const anonRow = anon.shows.find(s => s.title === 'Poker Face');
  check('logged out sees the title', !!anonRow);
  check('logged out sees no names', anonRow.members.length === 0, JSON.stringify(anonRow.members));
  check('member_slugs never reaches the response', !('member_slugs' in anonRow));

  const mate = await body(await popular.onRequestGet({ env, request: req('/api/popular', sPatrick) }));
  const mateRow = mate.shows.find(s => s.title === 'Poker Face');
  check('a group-mate is named, resolved fresh from the cached snapshot',
        mateRow.members.join(',') === 'whitt', JSON.stringify(mateRow.members));
  check('member_slugs stripped for group-mates too', !('member_slugs' in mateRow));

  const out = await body(await popular.onRequestGet({ env, request: req('/api/popular', sStranger) }));
  const outRow = out.shows.find(s => s.title === 'Poker Face');
  check('a logged-in stranger gets no names', outRow.members.length === 0,
        JSON.stringify(outRow.members));
}

console.log('\n== A corrupt snapshot recomputes instead of erroring');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'Severance' });
  env._db.prepare('INSERT INTO trending_cache (day, payload) VALUES (?, ?)')
    .run(today, 'not json {{{');
  const res = await popular.onRequestGet({ env, request: req('/api/popular') });
  check('corrupt payload still answers 200', res.status === 200);
  check('and answers with recomputed shows',
        (await body(res)).shows.some(s => s.title === 'Severance'));
  check('the corrupt row was overwritten with a real snapshot',
        (() => { try { return Array.isArray(JSON.parse(cacheRow(env)[0].payload)); } catch { return false; } })());
}

console.log('\n== A pre-067 database (no trending_cache) still serves Trending');
{
  const env = makeEnv();
  env._db.exec('DROP TABLE trending_cache');
  addMember(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'Severance' });
  const res = await popular.onRequestGet({ env, request: req('/api/popular') });
  check('answers 200 with no cache table', res.status === 200);
  check('and still trends', (await body(res)).shows.some(s => s.title === 'Severance'));
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

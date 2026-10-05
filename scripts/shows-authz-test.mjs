// Tests for two rules on the `shows` row that a session gate alone does not
// enforce — written from the 2026-09 security audit, where both were live.
//
//   node scripts/shows-authz-test.mjs
//
//   1. **A row you may not write is a row you may not read.**
//      PUT /api/shows/:id/move scoped its UPDATE by member_slug and then
//      re-read the row by primary key alone, so a move that legitimately
//      changed nothing still answered 200 with somebody else's whole row —
//      notes, watching_with, recommended_by, and added_by, which carries a
//      member's login email address. Signup is open and self-service, so the
//      caller needed no relationship to the victim at all, and a 200 carrying
//      a null show marked an unallocated id, which made the id space walkable
//      rather than guessable. The properties pinned here are that the
//      read-back carries the write's predicate, that a refused move is a 404,
//      and that an unallocated id and a foreign one are indistinguishable.
//      The owner's own move must keep working, including a re-move onto the
//      list the row is already on — SQLite counts a matched row as changed
//      even when no column value differs, so that case must not 404.
//
//   2. **The network name is markup by the time anyone reads it.**
//      It is rendered into the member page's service-count footer and into
//      the admin URL-cleanup console, and canonicalNetwork() *echoes* a name
//      it doesn't recognize rather than rejecting it, so an arbitrary string
//      survives the write untouched. Escaping the two sinks fixes today's
//      sinks; rejecting markup at both writers is what keeps the next read
//      path from having to know. Both writers are covered, because guarding
//      only the insert leaves the edit handler open.
//
//   3. **A URL one member pasted is not evidence for anybody else's row.**
//      POST /api/sync-urls copies a "good" network_url across every member's
//      copy of a title, but network_url has two writers with very different
//      trust — Watchmode/TMDB enrichment, and a member's own request body,
//      which safeNetworkUrl checks for scheme and character class but not for
//      host. So one self-enrolled member could point the Watch button at a
//      host of their choosing, club-wide, under a real service's name. The
//      rule pinned here is provenance: a URL is only propagated when its host
//      canonicalizes to the row's own service, and a refusal is counted in
//      `skipped` rather than swallowed. The demo-account exclusion is a
//      one-account denylist and was never the control.
//
// Same harness as scripts/watching-with-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json so Node loads the .js
// files as the ES modules they are, and schema.sql is loaded into node:sqlite
// behind a thin D1 shim, so the SQL under test is executed. TMDB is a
// stand-in that knows every title (scripts/lib/fake-tmdb.mjs), since an add
// TMDB can't identify is refused.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { fakeTmdb } from './lib/fake-tmdb.mjs';

// Every added show must be a TMDB entry, so adds go to a stand-in TMDB that
// knows every title (scripts/lib/fake-tmdb.mjs). Nothing else goes out.
const tmdb = fakeTmdb();
globalThis.fetch = async (url) => tmdb.respond(url)
  ?? new Response('{}', { headers: { 'Content-Type': 'application/json' } });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'shows-authz-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const showsApi = await load('api/shows.js');
const showApi = await load('api/shows/[id].js');
const moveApi = await load('api/shows/[id]/move.js');
const syncUrlsApi = await load('api/sync-urls.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addMember(env, slug, name) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial, disabled) VALUES (?, ?, ?, ?, ?, 0)'
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

// A row carrying every field the product defines as owner-only, so a leak is
// visible rather than inferred.
function addPrivateShow(env, { slug, title, list = 'watching' }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, notes, watching_with, recommended_by, added_by, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, 'PRIVATE-NOTE', 'PRIVATE-WATCHING-WITH', 'PRIVATE-RECOMMENDER',
    `${slug}@example.com`, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

const rowById = (env, id) =>
  env._db.prepare('SELECT * FROM shows WHERE id = ?').get(id);

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

const moveShow = (env, cookie, id, list) =>
  moveApi.onRequestPut(ctx(env, req(`/api/shows/${id}/move`, { cookie, method: 'PUT', body: { list } }), { id: String(id) }));
const postShow = (env, cookie, body) =>
  showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie, method: 'POST', body })));
const putShow = (env, cookie, id, body) =>
  showApi.onRequestPut(ctx(env, req(`/api/shows/${id}`, { cookie, method: 'PUT', body }), { id: String(id) }));
// The sweep runs from the nightly job since 2026-09 (a member session is a
// no-op — see spend-limits-test.mjs), so drive it the way the job does.
const syncUrls = (env) => {
  env.CRON_SECRET = 'test-cron-secret';
  const request = req('/api/sync-urls', { method: 'POST' });
  request.headers.set('X-Cron-Secret', 'test-cron-secret');
  return syncUrlsApi.onRequestPost(ctx(env, request));
};

// A row with an explicit network + URL, which is what the propagation reads
// and writes. Kept separate from addPrivateShow so the memo fields stay out
// of the way here.
function addLinkedShow(env, { slug, title, network, url }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, network, network_url, created_at, updated_at)
     VALUES (?, 'watching', ?, 0, ?, ?, ?, ?)`
  ).run(title, slug, network, url, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

// Patrick and Stacy share nothing. Stacy is the stranger open self-enrollment
// makes possible — a full member, in no group and no household with anyone.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  return env;
}

console.log('\n== a move you may not make tells you nothing about the row');
{
  const env = club();
  const victim = addPrivateShow(env, { slug: 'patrick', title: 'Severance', list: 'watching' });
  const cookie = addSession(env, 'stacy');

  const res = await moveShow(env, cookie, victim, 'next');
  check('a foreign id is 404, not 200', res.status === 404, `got ${res.status}`);

  const body = await res.json();
  const serialized = JSON.stringify(body);
  check('no show object comes back', body.show === undefined);
  check('the private note does not leak', !serialized.includes('PRIVATE-NOTE'));
  check('watching_with does not leak', !serialized.includes('PRIVATE-WATCHING-WITH'));
  check('the recommender does not leak', !serialized.includes('PRIVATE-RECOMMENDER'));
  check('the login email in added_by does not leak', !serialized.includes('patrick@example.com'));
  check('the owner slug does not leak', !serialized.includes('patrick'));

  const after = rowById(env, victim);
  check('the victim row is untouched', after.list === 'watching' && after.notes === 'PRIVATE-NOTE');
}

console.log('\n== an unallocated id is indistinguishable from a foreign one');
{
  const env = club();
  const victim = addPrivateShow(env, { slug: 'patrick', title: 'Severance' });
  const cookie = addSession(env, 'stacy');

  const foreign = await moveShow(env, cookie, victim, 'next');
  const missing = await moveShow(env, cookie, victim + 9999, 'next');
  check('both are 404', foreign.status === 404 && missing.status === 404,
    `got ${foreign.status} and ${missing.status}`);
  check('and carry the same body',
    JSON.stringify(await foreign.json()) === JSON.stringify(await missing.json()));
}

console.log('\n== the owner can still move their own row');
{
  const env = club();
  const mine = addPrivateShow(env, { slug: 'patrick', title: 'Severance', list: 'watching' });
  const cookie = addSession(env, 'patrick');

  const res = await moveShow(env, cookie, mine, 'next');
  check('a move I own is 200', res.status === 200, `got ${res.status}`);
  const { show } = await res.json();
  check('the row comes back', show && show.id === mine);
  check('it landed on the new list', show.list === 'next');
  check('my own memo is still mine to read', show.notes === 'PRIVATE-NOTE');
  check('the write actually happened', rowById(env, mine).list === 'next');

  // SQLite counts a matched row as changed even when no column value differs,
  // and updated_at moves on every call — so a re-move onto the list the row is
  // already on must not read as "matched nothing" and 404.
  const again = await moveShow(env, cookie, mine, 'next');
  check('re-moving onto the same list still succeeds', again.status === 200, `got ${again.status}`);

  const noSession = await moveShow(env, null, mine, 'watching');
  check('no session is still 401', noSession.status === 401, `got ${noSession.status}`);
  const badList = await moveShow(env, cookie, mine, 'nonsense');
  check('an invalid list is still 400', badList.status === 400, `got ${badList.status}`);
}

console.log('\n== the network name cannot carry markup past either writer');
{
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const env = club();
  const cookie = addSession(env, 'patrick');

  const added = await postShow(env, cookie, { title: 'Severance', list: 'watching', network: PAYLOAD });
  check('the add path refuses markup', added.status === 400, `got ${added.status}`);
  check('and stores nothing',
    env._db.prepare('SELECT COUNT(*) AS n FROM shows').get().n === 0);

  // Each character the renderer escapes is refused on its own, so the guard
  // can't be walked around with a single quote or a bare ampersand.
  for (const ch of ['<', '>', '"', "'", '&']) {
    const r = await postShow(env, cookie, { title: `Show ${ch}`, list: 'watching', network: `Netflix${ch}` });
    check(`the add path refuses ${JSON.stringify(ch)}`, r.status === 400, `got ${r.status}`);
  }

  const ok = await postShow(env, cookie, { title: 'Severance', list: 'watching', network: 'Apple TV+' });
  check('an ordinary network still saves', ok.status === 201, `got ${ok.status}`);
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);

  const edited = await putShow(env, cookie, id, { title: 'Severance', list: 'watching', network: PAYLOAD });
  check('the edit path refuses markup too', edited.status === 400, `got ${edited.status}`);
  check('the stored network is unchanged',
    !String(rowById(env, id).network || '').includes('<'));

  // Absent means "leave it alone" on this handler, and that must not be read
  // as an empty string running into the guard.
  const untouched = await putShow(env, cookie, id, { title: 'Severance Season 2', list: 'watching' });
  check('an edit that omits network still saves', untouched.status === 200, `got ${untouched.status}`);
}

console.log('\n== a URL one member pasted is never pushed onto anyone else');
{
  const env = club();
  // Patrick pasted it; safeNetworkUrl is happy (https, no funny characters),
  // but the host is not Netflix and never came from a provider.
  const mine = addLinkedShow(env, {
    slug: 'patrick', title: 'Severance', network: 'Netflix', url: 'https://evil.example/watch/severance',
  });
  const theirs = addLinkedShow(env, {
    slug: 'stacy', title: 'Severance', network: 'Netflix', url: 'https://www.netflix.com/search?q=Severance',
  });

  const res = await syncUrls(env);
  const body = await res.json();
  check('the foreign host is refused', body.synced === 0, `synced ${body.synced}`);
  check('and counted rather than swallowed', body.skipped >= 1, `skipped ${body.skipped}`);
  check("the other member's row still has its placeholder",
    rowById(env, theirs).network_url.includes('/search'));
  check("the pasted URL stays on the row that has it",
    rowById(env, mine).network_url === 'https://evil.example/watch/severance');
}

console.log('\n== a real provider link still propagates');
{
  const env = club();
  addLinkedShow(env, {
    slug: 'patrick', title: 'Severance', network: 'Netflix', url: 'https://www.netflix.com/title/81244942',
  });
  const theirs = addLinkedShow(env, {
    slug: 'stacy', title: 'Severance', network: 'Netflix', url: 'https://www.netflix.com/search?q=Severance',
  });

  const body = await (await syncUrls(env)).json();
  check('the provider link is propagated', body.synced === 1, `synced ${body.synced}`);
  check('and lands on the placeholder row',
    rowById(env, theirs).network_url === 'https://www.netflix.com/title/81244942');
}

console.log('\n== propagation stops at a copy pinned to a different show');
{
  const env = club();
  // Two shows sharing one title — a remake next to the original it remade.
  // The donor is pinned; the row that names a different tmdb_id is not its
  // copy, and its Watch button must not be rewritten to stream the wrong one.
  const donor = addLinkedShow(env, {
    slug: 'patrick', title: 'The Office', network: 'Peacock', url: 'https://www.peacocktv.com/watch/asset/us-office',
  });
  env._db.prepare('UPDATE shows SET tmdb_id = 2316 WHERE id = ?').run(donor);
  const other = addLinkedShow(env, {
    slug: 'stacy', title: 'The Office', network: 'Peacock', url: 'https://www.peacocktv.com/search?q=The+Office',
  });
  env._db.prepare('UPDATE shows SET tmdb_id = 2996 WHERE id = ?').run(other);

  await syncUrls(env);
  check('a differently-pinned copy keeps its own URL',
    rowById(env, other).network_url.includes('/search'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

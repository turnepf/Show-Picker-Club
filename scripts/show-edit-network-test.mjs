#!/usr/bin/env node
//
// Who decides what service a show is on, when the member and the stored link
// disagree.
//
// PUT /api/shows/:id used to read the network off the row's existing
// `network_url` and let that beat the dropdown:
//
//     const network = networkFromUrl(network_url) || canonicalNetwork(...)
//
// The rule was written when members pasted their own links, where "the URL
// says Netflix" really was the member talking. Since Watchmode nobody pastes
// them — they arrive from a machine — so what it actually did was let a
// machine's answer outrank a person's. A row holding a tv.apple.com deep link
// could not be moved off Apple TV+ at all: every save read the old link and
// put the network back, with no error to explain why the change hadn't taken.
// Found by trying to move Ted Lasso off Apple TV+ on a real phone.
//
// A machine never overwrites a member's answer — docs/INVARIANTS.md §20 — and
// a link a machine fetched is still the machine talking. The cases below pin
// which way each disagreement resolves, plus the two consequences of moving a
// row: its old link goes (it points at the wrong app now), and the replacement
// looked up for the new service reaches only copies naming that service.
//
// No network: TMDB and Watchmode are stubbed. Node 22 for node:sqlite.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'show-edit-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const ORIGIN = 'https://showpicker.club';
const TITLE = 'Ted Lasso';
const APPLE_URL = 'https://tv.apple.com/us/show/ted-lasso/umc.cmc.vtoh0mn0xn7t3c643xqonfzy';
const HULU_URL = 'https://www.hulu.com/series/ted-lasso-abc123';
const NETFLIX_URL = 'https://www.netflix.com/title/81234567';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- stub the outside world BEFORE the handler is imported ----

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => data,
  text: async () => JSON.stringify(data),
});

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  // TMDB: answer every enrichment call with a title and nothing else, so the
  // handler's enrichment step neither fails nor supplies a network of its own.
  if (u.hostname === 'api.themoviedb.org') {
    if (u.pathname.startsWith('/3/search/')) {
      return jsonRes({ results: [{ id: 4242, name: TITLE, title: TITLE, first_air_date: '2020-08-14' }] });
    }
    return jsonRes({ id: 4242, name: TITLE, title: TITLE, networks: [], credits: { cast: [] },
                     genres: [], videos: { results: [] }, 'watch/providers': { results: {} } });
  }
  // Finds nothing by default; the one case that needs a replacement link
  // swaps this out locally.
  if (u.hostname.includes('watchmode')) return jsonRes([]);
  return jsonRes({}, 404);
};

const showsApi = await import(join(sandbox, 'functions', 'api/shows/[id].js'));

// ---- D1 shim ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (s) => { for (const x of s) await x.run(); } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addMember(env, slug) {
  env._db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run(slug, slug, slug);
  env._db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)')
    .run(`${slug}@example.com`, slug);
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT OR IGNORE INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { member, network, url, title = TITLE }) {
  env._db.prepare(
    `INSERT INTO shows (title, network, network_url, list, member_slug, archived, network_logo_url)
     VALUES (?, ?, ?, 'watching', ?, 0, 'https://logo.example/old.png')`
  ).run(title, network, url, member);
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

const row = (env, id) => env._db.prepare('SELECT * FROM shows WHERE id = ?').get(id);

// waitUntil is awaited rather than dropped: the URL propagation runs in it,
// and it is half of what this file is about.
async function edit(env, cookie, id, body) {
  const pending = [];
  const request = new Request(`${ORIGIN}/api/shows/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${cookie}` },
    body: JSON.stringify(body),
  });
  const res = await showsApi.onRequestPut({
    env, request, params: { id: String(id) }, waitUntil: (p) => pending.push(p),
  });
  await Promise.allSettled(pending);
  return res;
}

// ---------------------------------------------------------------------------

console.log('\n== the member outranks the link a machine fetched');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  const id = addShow(env, { member: 'patrick', network: 'Apple TV+', url: APPLE_URL });

  const res = await edit(env, cookie, id, { title: TITLE, network: 'Hulu', list: 'watching' });
  check('the edit succeeds', res.status === 200, `got ${res.status}`);
  check('and the show is on Hulu, not back on Apple TV+',
    row(env, id).network === 'Hulu', `got ${row(env, id).network}`);
}

console.log('\n== the old link goes with the old service');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  const id = addShow(env, { member: 'patrick', network: 'Apple TV+', url: APPLE_URL });

  await edit(env, cookie, id, { title: TITLE, network: 'Netflix', list: 'watching' });
  const after = row(env, id);
  // Watchmode is stubbed to find nothing, so nothing refills it — which is
  // exactly the case worth pinning: no link at all beats a confident link
  // into the wrong app.
  check('the Apple link does not survive the move', after.network_url !== APPLE_URL,
    String(after.network_url));
  check('the badge from the old service is cleared too', after.network_logo_url === null,
    String(after.network_logo_url));
}

console.log('\n== a link pasted in the same edit still wins');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  const id = addShow(env, { member: 'patrick', network: 'Apple TV+', url: APPLE_URL });

  // The member hands over a Netflix URL while the picker still says Hulu.
  // That URL is the member talking, so it decides — and it is kept.
  const res = await edit(env, cookie, id,
    { title: TITLE, network: 'Hulu', network_url: NETFLIX_URL, list: 'watching' });
  check('the pasted URL decides the service', row(env, id).network === 'Netflix',
    `got ${row(env, id).network} (${res.status})`);
  check('and the pasted URL is kept', row(env, id).network_url === NETFLIX_URL,
    String(row(env, id).network_url));
}

console.log('\n== an edit that names neither leaves the service alone');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  const id = addShow(env, { member: 'patrick', network: 'Apple TV+', url: APPLE_URL });

  await edit(env, cookie, id, { title: TITLE, list: 'recommending', notes: 'rewatching' });
  const after = row(env, id);
  check('the service is untouched', after.network === 'Apple TV+', String(after.network));
  check('the link is untouched', after.network_url === APPLE_URL, String(after.network_url));
  check('and the edit that was asked for happened', after.list === 'recommending', after.list);
}

console.log('\n== one member moving their copy does not relink anyone else\'s');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  addMember(env, 'quinn');
  const mine = addShow(env, { member: 'patrick', network: 'Apple TV+', url: APPLE_URL });
  const theirs = addShow(env, { member: 'quinn', network: 'Apple TV+', url: APPLE_URL });

  // Watchmode answers for Hulu this time, so there IS a replacement link to
  // propagate — the case where scoping matters.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname.includes('watchmode')) return jsonRes([{ source_id: 1, web_url: HULU_URL }]);
    return realFetch(url);
  };

  await edit(env, cookie, mine, { title: TITLE, network: 'Hulu', list: 'watching' });
  globalThis.fetch = realFetch;

  check('my copy moved to Hulu', row(env, mine).network === 'Hulu', String(row(env, mine).network));
  check('their copy still says Apple TV+', row(env, theirs).network === 'Apple TV+',
    String(row(env, theirs).network));
  check('and their copy did not get handed a Hulu link',
    row(env, theirs).network_url !== HULU_URL, String(row(env, theirs).network_url));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

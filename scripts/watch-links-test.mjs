#!/usr/bin/env node
//
// One Watch link per show per service (migration 089, `watch_links`).
//
// A link used to live on every member's copy, so a fix in Show Cleanup reached
// only the copies it was pasted onto and the next member to add the show got a
// search page again. Now the link belongs to (TMDB entry, service) and shows_v
// reads it for every copy on that service, falling back to the copy's own
// column when there is none.
//
// What's pinned is who may write it, because a shared link is a club-wide
// write (docs/INVARIANTS.md §24):
//   - an admin save overwrites; a Watchmode answer and the nightly lift only
//     fill, so a machine never replaces a link an operator chose;
//   - a member's own pasted link stays on their copy — it never becomes the
//     Watch button for anybody else;
//   - only a real link whose host is that service is ever shared: no search
//     pages, no info pages, no Hulu link stored as the Netflix one;
//   - it stops at the service: a copy of the same show on another service
//     reads that service's link, not this one;
//   - the lift picks the link most copies carry, after normalizing, and a
//     second run finds nothing to do.
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
const sandbox = mkdtempSync(join(tmpdir(), 'watch-links-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const ORIGIN = 'https://showpicker.club';
const TMDB_ID = 4242;
const TITLE = 'Hacks';
const HBO = 'https://play.hbomax.com/show/67e940b7-aab2-46ce-a62b-c7308cde9de7';
const HBO_INFO = 'https://www.hbomax.com/show/67e940b7-aab2-46ce-a62b-c7308cde9de7?utm_source=universal_search';
const HBO_OTHER = 'https://play.hbomax.com/show/11111111-2222-3333-4444-555555555555';
const HULU = 'https://www.hulu.com/series/hacks-0f2c';
const APPLE = 'https://tv.apple.com/us/show/hacks/umc.cmc.1234567890abcdefghijklmn';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => data, text: async () => JSON.stringify(data),
});

// TMDB answers with the pinned entry and nothing else; Watchmode finds nothing
// unless a case swaps `watchmodeSources` in.
let watchmodeSources = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.themoviedb.org') {
    if (u.pathname.startsWith('/3/search/')) {
      return jsonRes({ results: [{ id: TMDB_ID, name: TITLE, first_air_date: '2021-05-13' }] });
    }
    return jsonRes({ id: TMDB_ID, name: TITLE, networks: [], credits: { cast: [] },
                     genres: [], videos: { results: [] }, 'watch/providers': { results: {} } });
  }
  if (u.hostname.includes('watchmode')) {
    if (u.pathname.includes('/search')) return jsonRes({ title_results: [{ id: 1, name: TITLE, tmdb_id: TMDB_ID, tmdb_type: 'tv' }] });
    return jsonRes(watchmodeSources);
  }
  return jsonRes({}, 404);
};

const links = await import(join(sandbox, 'functions', '_shared/watch-links.js'));
const cleanupApi = await import(join(sandbox, 'functions', 'api/admin-url-cleanup.js'));
const showApi = await import(join(sandbox, 'functions', 'api/shows/[id].js'));

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  const DB = {
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => { const out = []; for (const x of stmts) out.push(await x.run()); return out; },
  };
  return { DB, TMDB_TOKEN: 'test', WATCHMODE_API_KEY: 'test', _db: db };
}

function addMember(env, slug, { admin = false } = {}) {
  env._db.prepare('INSERT INTO members (slug, name, first_name, is_admin) VALUES (?, ?, ?, ?)').run(slug, slug, slug, admin ? 1 : 0);
  env._db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run(`${slug}@example.com`, slug);
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { member, network = null, url = null, enriched = null }) {
  env._db.prepare('INSERT OR IGNORE INTO members (slug, name, first_name) VALUES (?, ?, ?)').run(member, member, member);
  env._db.prepare(
    `INSERT INTO shows (title, network, network_url, list, member_slug, archived, tmdb_id, tmdb_type, enriched_at)
     VALUES (?, ?, ?, 'watching', ?, 0, ?, 'tv', ?)`
  ).run(TITLE, network, url, member, TMDB_ID, enriched);
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

const seen = (env, id) => env._db.prepare('SELECT network_url FROM shows_v WHERE id = ?').get(id).network_url;
const shared = (env, network) => env._db.prepare(
  'SELECT url, source FROM watch_links WHERE tmdb_type = ? AND tmdb_id = ? AND network = ?'
).get('tv', TMDB_ID, network);

async function cleanupSave(env, cookie, id, network, url) {
  const request = new Request(`${ORIGIN}/api/admin-url-cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${cookie}` },
    body: JSON.stringify({ action: 'save', id, network, network_url: url }),
  });
  return cleanupApi.onRequestPost({ env, request, waitUntil: () => {} });
}

async function memberEdit(env, cookie, id, body) {
  const pending = [];
  const request = new Request(`${ORIGIN}/api/shows/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${cookie}` },
    body: JSON.stringify(body),
  });
  const res = await showApi.onRequestPut({ env, request, params: { id: String(id) }, waitUntil: (p) => pending.push(p) });
  await Promise.allSettled(pending);
  return res;
}

// ---------------------------------------------------------------------------

console.log('\n== what may be shared at all');
{
  check('a real link on its own service is shared', links.shareableUrl(HBO, 'HBO Max') === HBO);
  check('an HBO Max info page is moved to the player first', links.shareableUrl(HBO_INFO, 'HBO Max') === HBO);
  check('a search page is never shared', links.shareableUrl('https://www.hulu.com/search?q=hacks', 'Hulu') === null);
  check('the HBO Max search fallback is never shared', links.shareableUrl('https://play.hbomax.com/search?q=Hacks', 'HBO Max') === null);
  check('a Hulu link is not the HBO Max link', links.shareableUrl(HULU, 'HBO Max') === null);
  check('an Apple link is Apple TV+\'s', links.shareableUrl(APPLE, 'Apple TV+') === APPLE);
  check('and the rent-or-buy store\'s', links.shareableUrl(APPLE, 'Apple TV Store') === APPLE);
  check('markup is never shared', links.shareableUrl('https://www.hulu.com/series/"><script>', 'Hulu') === null);
  check('no network, nothing shared', links.shareableUrl(HULU, null) === null);
}

console.log('\n== a Show Cleanup save is every copy\'s link on that service');
{
  const env = makeEnv();
  const admin = addMember(env, 'patrick', { admin: true });
  addMember(env, 'eric'); addMember(env, 'amy');
  const mine = addShow(env, { member: 'patrick', network: 'HBO Max', url: 'https://play.hbomax.com/search?q=Hacks' });
  const hulu = addShow(env, { member: 'amy', network: 'Hulu', url: HULU });

  const res = await cleanupSave(env, admin, mine, 'HBO Max', HBO_INFO);
  check('the save answers ok', res.status === 200, `got ${res.status}`);
  check('the show has one HBO Max link, the player one', shared(env, 'HBO Max')?.url === HBO, JSON.stringify(shared(env, 'HBO Max')));
  check('the saved copy reads it', seen(env, mine) === HBO);

  // A member who adds the show tomorrow gets it with no second paste.
  const later = addShow(env, { member: 'eric', network: 'HBO Max', url: 'https://play.hbomax.com/search?q=Hacks' });
  check('a copy added later reads it too', seen(env, later) === HBO, seen(env, later));
  check('a copy on another service keeps its own service\'s link', seen(env, hulu) === HULU, seen(env, hulu));

  // An operator's second answer replaces the first.
  await cleanupSave(env, admin, mine, 'HBO Max', HBO_OTHER);
  check('a second admin save overwrites', shared(env, 'HBO Max')?.url === HBO_OTHER);
}

console.log('\n== a machine fills, it never replaces');
{
  const env = makeEnv();
  addShow(env, { member: 'patrick', network: 'HBO Max' });
  const row = { tmdb_id: TMDB_ID, tmdb_type: 'tv' };
  await links.setWatchLink(env, row, 'HBO Max', HBO, 'admin');
  const r = await links.setWatchLink(env, row, 'HBO Max', HBO_OTHER, 'watchmode');
  check('Watchmode does not replace the operator\'s link', r === null && shared(env, 'HBO Max').url === HBO);
  const r2 = await links.setWatchLink(env, row, 'Hulu', HULU, 'watchmode');
  check('but fills a service that has none', r2 === HULU && shared(env, 'Hulu').source === 'watchmode');
  check('an unpinned row stores nothing', (await links.setWatchLink(env, { tmdb_id: null }, 'Hulu', HULU, 'admin')) === null);
}

console.log('\n== a Prime link that lands on the show replaces one that does not');
{
  const env = makeEnv();
  addShow(env, { member: 'patrick', network: 'Amazon Prime Video' });
  const row = { tmdb_id: TMDB_ID, tmdb_type: 'tv' };
  const ASIN = 'https://www.amazon.com/gp/video/detail/B095RFRQNJ/';
  const GTI = 'https://watch.amazon.com/detail?gti=amzn1.dv.gti.a314b20c-bc97-4fdd-8f15-fe912ab92f7d';
  const GTI2 = 'https://watch.amazon.com/detail?gti=amzn1.dv.gti.5ea9f68d-5bf9-bb34-dc15-2f971f46c793';

  await links.setWatchLink(env, row, 'Amazon Prime Video', ASIN, 'copy');
  check('fill-only leaves the ASIN link in place',
    (await links.setWatchLink(env, row, 'Amazon Prime Video', GTI, 'watchmode')) === null
      && shared(env, 'Amazon Prime Video').url === ASIN);
  check('the upgrade replaces it',
    (await links.upgradeAmazonWatchLink(env, row, 'Amazon Prime Video', GTI)) === GTI
      && shared(env, 'Amazon Prime Video').url === GTI);
  check('but never replaces a link that already lands on the show',
    (await links.upgradeAmazonWatchLink(env, row, 'Amazon Prime Video', GTI2)) === null
      && shared(env, 'Amazon Prime Video').url === GTI);
  check('nor upgrades to a link that does not land on the show',
    (await links.upgradeAmazonWatchLink(env, row, 'Amazon Prime Video', ASIN)) === null);

  const env2 = makeEnv();
  addShow(env2, { member: 'patrick', network: 'Amazon Prime Video' });
  await links.setWatchLink(env2, row, 'Amazon Prime Video', ASIN, 'admin');
  check('and never replaces an operator\'s link',
    (await links.upgradeAmazonWatchLink(env2, row, 'Amazon Prime Video', GTI)) === null
      && shared(env2, 'Amazon Prime Video').url === ASIN);
}

console.log('\n== a member\'s pasted link stays on their copy (§24)');
{
  const env = makeEnv();
  const stranger = addMember(env, 'stranger');
  addMember(env, 'patrick');
  const theirs = addShow(env, { member: 'stranger', network: 'HBO Max' });
  const mine = addShow(env, { member: 'patrick', network: 'HBO Max' });

  const res = await memberEdit(env, stranger, theirs, { network: 'HBO Max', list: 'watching', network_url: HBO_OTHER, tmdb_id: TMDB_ID, tmdb_type: 'tv' });
  check('the member\'s edit saves', res.status === 200, `got ${res.status}`);
  check('nothing is shared from it', shared(env, 'HBO Max') === undefined, JSON.stringify(shared(env, 'HBO Max')));
  check('their own copy shows their link', seen(env, theirs) === HBO_OTHER, seen(env, theirs));
  check('nobody else\'s Watch button changes', seen(env, mine) === null, seen(env, mine));

  // Once the show has a real link, it is what every copy shows — the
  // member's paste is a fallback, not an override.
  await links.setWatchLink(env, { tmdb_id: TMDB_ID, tmdb_type: 'tv' }, 'HBO Max', HBO, 'admin');
  check('the shared link wins over a copy\'s own', seen(env, theirs) === HBO && seen(env, mine) === HBO);
}

console.log('\n== a Watchmode answer on an edit becomes the shared link');
{
  const env = makeEnv();
  const cookie = addMember(env, 'patrick');
  addMember(env, 'eric');
  const mine = addShow(env, { member: 'patrick', network: 'HBO Max', url: HBO });
  const erics = addShow(env, { member: 'eric', network: 'Hulu' });
  watchmodeSources = [{ region: 'US', type: 'sub', name: 'Hulu', web_url: HULU }];
  const res = await memberEdit(env, cookie, mine, { network: 'Hulu', list: 'watching', tmdb_id: TMDB_ID, tmdb_type: 'tv' });
  watchmodeSources = [];
  check('the move saves', res.status === 200, `got ${res.status}`);
  check('Watchmode\'s Hulu link is the show\'s Hulu link', shared(env, 'Hulu')?.url === HULU, JSON.stringify(shared(env, 'Hulu')));
  check('Eric\'s Hulu copy reads it', seen(env, erics) === HULU, seen(env, erics));
}

console.log('\n== the nightly lift');
{
  const env = makeEnv();
  // Three HBO Max copies: two carry the same link (one with tracking junk),
  // one an older different one. The majority wins after normalizing.
  addShow(env, { member: 'a', network: 'HBO Max', url: HBO, enriched: '2026-01-01' });
  addShow(env, { member: 'b', network: 'HBO Max', url: HBO_INFO, enriched: '2026-02-01' });
  addShow(env, { member: 'c', network: 'HBO Max', url: HBO_OTHER, enriched: '2026-03-01' });
  // A Netflix copy holding a Hulu link — the host doesn't match, never lifted.
  addShow(env, { member: 'd', network: 'Netflix', url: HULU });
  // A Peacock copy on a search page — not a link, never lifted.
  addShow(env, { member: 'e', network: 'Peacock', url: 'https://www.peacocktv.com/search?q=hacks' });
  // Disney+ already has an operator's link; a copy's different one loses.
  const DISNEY = 'https://www.disneyplus.com/series/hacks/abc';
  await links.setWatchLink(env, { tmdb_id: TMDB_ID, tmdb_type: 'tv' }, 'Disney+', DISNEY, 'admin');
  addShow(env, { member: 'f', network: 'Disney+', url: 'https://www.disneyplus.com/series/hacks/zzz' });

  const n = await links.liftWatchLinks(env);
  check('one link lifted', n === 1, `lifted ${n}`);
  check('the link most copies carry wins', shared(env, 'HBO Max')?.url === HBO && shared(env, 'HBO Max').source === 'copy',
    JSON.stringify(shared(env, 'HBO Max')));
  check('a link on the wrong host is not lifted', shared(env, 'Netflix') === undefined);
  check('a search page is not lifted', shared(env, 'Peacock') === undefined);
  check('an operator\'s link is not replaced', shared(env, 'Disney+').url === DISNEY);
  check('a second run finds nothing to do', (await links.liftWatchLinks(env)) === 0);
}

console.log('\n== a tie goes to the most recently enriched copy');
{
  const env = makeEnv();
  addShow(env, { member: 'a', network: 'HBO Max', url: HBO, enriched: '2026-01-01' });
  addShow(env, { member: 'b', network: 'HBO Max', url: HBO_OTHER, enriched: '2026-05-01' });
  await links.liftWatchLinks(env);
  check('the newer link wins a tie', shared(env, 'HBO Max')?.url === HBO_OTHER, JSON.stringify(shared(env, 'HBO Max')));
}

console.log('\n== the show\'s own page beats an episode, a clean link beats a tracked one');
{
  const env = makeEnv();
  const EPISODE = 'https://tv.apple.com/us/episode/pilot/umc.cmc.aaaa?showId=umc.cmc.1234567890abcdefghijklmn';
  for (const m of ['a', 'b', 'c']) addShow(env, { member: m, network: 'Apple TV+', url: EPISODE });
  addShow(env, { member: 'd', network: 'Apple TV+', url: APPLE });
  const TRACKED = `${HBO}?utm_medium=sharebutton`;
  for (const m of ['e', 'f', 'g']) addShow(env, { member: m, network: 'HBO Max', url: TRACKED });
  addShow(env, { member: 'h', network: 'HBO Max', url: HBO });
  await links.liftWatchLinks(env);
  check('one show link outranks three episode links', shared(env, 'Apple TV+')?.url === APPLE, JSON.stringify(shared(env, 'Apple TV+')));
  check('one clean link outranks three tracked ones', shared(env, 'HBO Max')?.url === HBO, JSON.stringify(shared(env, 'HBO Max')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Tests for /api/activity — the club-wide feed and the per-member scoping the
// member page's admin strip reads.
//
//   node scripts/activity-feed-test.mjs
//
// Written alongside the 2026-08 signup-email fix. The email announces a new
// member and deep-links at their page; the strip that lands there answers
// "what have they actually added?" from this endpoint, so three things have to
// hold and none of them is visible in a diff:
//
//   1. It stays session-gated. It reports who-added-what across the whole
//      club, which is exactly the kind of derived data the public surface
//      must not carry (docs/INVARIANTS.md).
//   2. A member's feed shows what *they* chose. Seeded starter rows
//      (added_by='seed', the operator's picks) headlining a new member's feed
//      would be a lie about someone who has added nothing.
//   3. Bulk adds collapse per list. Grouping on member+timestamp alone
//      reported "added 5 shows to Watching" for an import that touched four
//      lists — tolerable on a club-wide feed, wrong on a page where every
//      line is the same person.
//
// Same harness as scripts/passkey-flow-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json so Node loads the
// .js files as the ES modules they are, and schema.sql is loaded into
// node:sqlite behind a thin D1 shim, so the SQL under test is executed.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'activity-feed-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const activity = await load('api/activity.js');

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
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  return {
    DB: { prepare: (sql) => new Stmt(db, sql) },
    _db: db,
  };
}

function addMember(env, slug, name) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, 0)'
  ).run(slug, name, name.split(' ')[0]);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

// created_at drives both ordering and burst collapsing, so every fixture row
// states its own.
function addShow(env, { slug, title, list = 'watching', at, addedBy = null, archived = 0 }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, created_at, updated_at, added_by, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, at, at, addedBy, archived);
}

function get(path, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { headers });
}

const call = async (env, path, opts) =>
  activity.onRequestGet({ env, request: get(path, opts) });

// ---- scenarios ----

console.log('\n== the feed is members-only');
{
  const env = makeEnv();
  addMember(env, 'stacy', 'Stacy Kallay');
  addShow(env, { slug: 'stacy', title: 'Severance', at: '2026-08-11T12:00:00Z' });

  const anon = await call(env, '/api/activity');
  check('no session is 401', anon.status === 401, `got ${anon.status}`);
  check('and the body carries no titles', !(await anon.text()).includes('Severance'));

  const expired = addSession(env, 'stacy');
  env._db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), expired);
  const stale = await call(env, '/api/activity', { cookie: expired });
  check('an expired session is 401 too', stale.status === 401, `got ${stale.status}`);
}

console.log('\n== club-wide feed');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'The Bear', at: '2026-08-10T09:00:00Z' });
  addShow(env, { slug: 'stacy', title: 'Severance', at: '2026-08-11T12:00:00Z' });

  const { feed } = await (await call(env, '/api/activity', { cookie })).json();
  check('newest first', feed[0].title === 'Severance', JSON.stringify(feed.map((f) => f.title)));
  check('the line names the member', feed[0].text === 'Stacy added "Severance" to Watching', feed[0].text);
  check('and carries structured fields beside it',
        feed[0].list === 'watching' && feed[0].memberSlug === undefined && feed[0].member_slug === 'stacy',
        JSON.stringify(feed[0]));
  check('everyone is included', feed.length === 2, `got ${feed.length}`);
}

console.log('\n== ?member= scopes the feed to one person');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, 'patrick');
  addShow(env, { slug: 'patrick', title: 'The Bear', at: '2026-08-10T09:00:00Z' });
  addShow(env, { slug: 'stacy', title: 'Severance', at: '2026-08-11T12:00:00Z', list: 'next' });

  const { feed } = await (await call(env, '/api/activity?member=stacy', { cookie })).json();
  check('only that member is in it', feed.length === 1 && feed[0].member_slug === 'stacy',
        JSON.stringify(feed));
  check('the name is dropped from the line', feed[0].text === 'Added "Severance" to Next Up', feed[0].text);
  check('the list label rides along', feed[0].list_label === 'Next Up', feed[0].list_label);

  // An unknown slug is an empty feed, not somebody else's.
  const { feed: none } = await (await call(env, '/api/activity?member=nobody', { cookie })).json();
  check('an unknown slug returns nothing', none.length === 0, JSON.stringify(none));
}

console.log('\n== a new member with only seeded rows has added nothing');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, 'patrick');
  addShow(env, { slug: 'stacy', title: 'Starter Pick', at: '2026-08-11T12:00:00Z', addedBy: 'seed' });
  addShow(env, { slug: 'stacy', title: 'Archived Thing', at: '2026-08-11T12:30:00Z', archived: 1 });

  const { feed } = await (await call(env, '/api/activity?member=stacy', { cookie })).json();
  check('seeded and archived rows are both left out', feed.length === 0, JSON.stringify(feed));
}

console.log('\n== bulk adds collapse per list');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, 'patrick');
  // One import, one second, two lists.
  for (const t of ['Andor', 'Shrinking', 'Slow Horses']) {
    addShow(env, { slug: 'stacy', title: t, list: 'watching', at: '2026-08-11T12:00:00Z' });
  }
  for (const t of ['Dune', 'Sinners']) {
    addShow(env, { slug: 'stacy', title: t, list: 'next', at: '2026-08-11T12:00:00Z' });
  }

  const { feed } = await (await call(env, '/api/activity?member=stacy', { cookie })).json();
  check('one line per list, not one line for the burst', feed.length === 2, JSON.stringify(feed.map((f) => f.text)));
  const counts = Object.fromEntries(feed.map((f) => [f.list, f.count]));
  check('each line counts only its own list', counts.watching === 3 && counts.next === 2,
        JSON.stringify(counts));
  check('and says so', feed.some((f) => f.text === 'Added 3 shows to Watching'),
        JSON.stringify(feed.map((f) => f.text)));

  // Two adds a minute apart are two separate events, not one burst.
  addShow(env, { slug: 'stacy', title: 'Poker Face', list: 'watching', at: '2026-08-11T12:05:00Z' });
  const { feed: later } = await (await call(env, '/api/activity?member=stacy', { cookie })).json();
  check('a later add stays its own line', later[0].text === 'Added "Poker Face" to Watching', later[0].text);
}

console.log('\n== limit');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  const cookie = addSession(env, 'patrick');
  // More than the 50-row ceiling, so the clamp below is actually load-bearing.
  for (let i = 0; i < 60; i++) {
    addShow(env, { slug: 'patrick', title: `Show ${i}`, at: `2026-08-11T12:${String(i).padStart(2, '0')}:00Z` });
  }

  const dflt = await (await call(env, '/api/activity', { cookie })).json();
  check('defaults to 10', dflt.feed.length === 10, `got ${dflt.feed.length}`);

  const three = await (await call(env, '/api/activity?limit=3', { cookie })).json();
  check('honors a smaller limit', three.feed.length === 3, `got ${three.feed.length}`);

  // Clamped rather than trusted: the query string is caller-controlled.
  const huge = await (await call(env, '/api/activity?limit=9999', { cookie })).json();
  check('clamps a huge limit to 50', huge.feed.length === 50, `got ${huge.feed.length}`);

  const junk = await (await call(env, '/api/activity?limit=abc', { cookie })).json();
  check('falls back on junk', junk.feed.length === 10, `got ${junk.feed.length}`);

  const zero = await (await call(env, '/api/activity?limit=0', { cookie })).json();
  check('and on zero', zero.feed.length === 10, `got ${zero.feed.length}`);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

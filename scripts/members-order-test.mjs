// Tests for /api/members — what each tier sees, and the admin roster order.
//
//   node scripts/members-order-test.mjs
//
// The endpoint answers logged-out callers, so the properties pinned are the
// ones that keep it narrow. Logged out: slugs and first names, alphabetical,
// no counts, no activity, and no read of shows or sessions (§18 — a crawler
// must not be able to turn it into a library scan). A member: counts added,
// still alphabetical, still no activity — the order alone would say who is
// active. An admin: last_activity_at, most recent first, where activity is
// the later of a non-seed show write and the latest sessions.last_seen_at
// (/auth/check stamps it on launch and every return to the foreground).
//
// Same harness as scripts/activity-feed-test.mjs: functions/ copied to a temp
// ES-module sandbox, schema.sql loaded into node:sqlite behind a D1 shim.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'members-order-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const members = await import(join(sandbox, 'functions', 'api/members.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
withLegacyShowColumns(db);
const env = { DB: { prepare: (sql) => new Stmt(db, sql) } };

const addMember = (slug) => db.prepare(
  'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, 0)'
).run(slug, slug, slug);
const addShow = (slug, at, addedBy = null) => db.prepare(
  `INSERT INTO shows (title, list, member_slug, created_at, updated_at, added_by, archived)
   VALUES (?, 'watching', ?, ?, ?, ?, 0)`
).run(`${slug}-${at}`, slug, at, at, addedBy);
const addSession = (slug, seen) => db.prepare(
  'INSERT INTO sessions (id, email, member_slug, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
).run(`s-${slug}-${seen}`, slug, slug, '2099-01-01T00:00:00.000Z', seen, seen);

// A shim that records every statement, so the logged-out tier can be held to
// never touching shows or sessions.
const seen = [];
env.DB = { prepare: (sql) => { seen.push(sql); return new Stmt(db, sql); } };

// alice: edited a show yesterday, never opened since.
addMember('alice'); addShow('alice', '2026-09-22 18:00:00');
// bob: no edits at all, opened the app today.
addMember('bob'); addSession('bob', '2026-09-23 07:15:42');
// carol: edited today at 09:00, after a 06:00 open.
addMember('carol'); addShow('carol', '2026-09-23 09:00:00'); addSession('carol', '2026-09-23 06:00:00');
// dave: only seed rows and an old open; the open still counts.
addMember('dave'); addShow('dave', '2026-09-23 12:00:00', 'seed'); addSession('dave', '2026-09-01 10:00:00');
// erin: nothing at all.
addMember('erin');
// frank: two devices; the later open wins.
addMember('frank'); addSession('frank', '2026-08-01 10:00:00'); addSession('frank', '2026-09-10 23:59:59');
// zed: the admin doing the asking, with a live session.
addMember('zed'); db.prepare("UPDATE members SET is_admin = 1 WHERE slug = 'zed'").run();
addSession('zed', '2026-09-23 12:30:00');

const call = async (sessionId) => {
  const headers = sessionId ? { Cookie: `session=${sessionId}` } : {};
  seen.length = 0;
  const res = await members.onRequestGet({ env, request: new Request('https://showpicker.club/api/members', { headers }) });
  return (await res.json()).members;
};
const alpha = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'zed'];

console.log('logged out');
let list = await call(null);
check('alphabetical', JSON.stringify(list.map((m) => m.slug)) === JSON.stringify(alpha), JSON.stringify(list.map((m) => m.slug)));
check('no activity field', list.every((m) => !('last_activity_at' in m)));
check('no counts', list.every((m) => !('show_count' in m) && !('watching_count' in m)));
check('still names everyone, for link resolution', list.every((m) => m.slug && m.name));
check('reads neither shows nor sessions', !seen.some((q) => /\b(shows|sessions)\b/.test(q.replace(/FROM members/g, ''))), JSON.stringify(seen));

console.log('a member (not admin)');
list = await call('s-bob-2026-09-23 07:15:42');
check('alphabetical', JSON.stringify(list.map((m) => m.slug)) === JSON.stringify(alpha), JSON.stringify(list.map((m) => m.slug)));
check('no activity field', list.every((m) => !('last_activity_at' in m)));
check('counts present', list.find((m) => m.slug === 'carol').show_count === 1);

console.log('an admin');
list = await call('s-zed-2026-09-23 12:30:00');
const order = list.map((m) => m.slug);
const at = Object.fromEntries(list.map((m) => [m.slug, m.last_activity_at]));
check('most recent first, nothing-at-all last',
  JSON.stringify(order) === JSON.stringify(['zed', 'carol', 'bob', 'alice', 'frank', 'dave', 'erin']), JSON.stringify(order));
check('an app open alone counts as activity', at.bob === '2026-09-23 07:15:42', at.bob);
check('a later edit beats an earlier open', at.carol === '2026-09-23 09:00:00', at.carol);
check('seed rows still count for nothing', at.dave === '2026-09-01 10:00:00', at.dave);
check('the latest of several sessions wins', at.frank === '2026-09-10 23:59:59', at.frank);
check('no activity reads as null', at.erin === null, String(at.erin));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

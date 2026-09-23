// Tests for /api/members' roster order — what counts as "recently active".
//
//   node scripts/members-order-test.mjs
//
// Every client roster sorts on last_activity_at, so this is the one place
// the definition lives. Two sources feed it: a member-initiated write to a
// non-seed show (exact time), and opening an app, read off the latest
// sessions.last_seen_at that /auth/check stamps. The open is truncated to
// the day because this endpoint answers logged-out callers — an exact stamp
// would publish who had the app open in the last hour.
//
// Same harness as scripts/activity-feed-test.mjs: functions/ copied to a temp
// ES-module sandbox, schema.sql loaded into node:sqlite behind a D1 shim.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() { const r = this.db.prepare(this.sql).all(...this.args); return r.length ? { ...r[0] } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes ?? 0) } }; }
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
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

// alice: edited a show yesterday, never opened since.
addMember('alice'); addShow('alice', '2026-09-22 18:00:00');
// bob: no edits at all, opened the app today.
addMember('bob'); addSession('bob', '2026-09-23 07:15:42');
// carol: edited today at 09:00, which beats a same-day open.
addMember('carol'); addShow('carol', '2026-09-23 09:00:00'); addSession('carol', '2026-09-23 06:00:00');
// dave: only seed rows and an old open; the open still counts.
addMember('dave'); addShow('dave', '2026-09-23 12:00:00', 'seed'); addSession('dave', '2026-09-01 10:00:00');
// erin: nothing at all.
addMember('erin');
// frank: two devices; the later open wins.
addMember('frank'); addSession('frank', '2026-08-01 10:00:00'); addSession('frank', '2026-09-10 23:59:59');

const res = await members.onRequestGet({ env, request: new Request('https://showpicker.club/api/members') });
const body = await res.json();
const order = body.members.map((m) => m.slug);
const at = Object.fromEntries(body.members.map((m) => [m.slug, m.last_activity_at]));

console.log('/api/members order');
check('most recent first, nothing-at-all last',
  JSON.stringify(order) === JSON.stringify(['carol', 'bob', 'alice', 'frank', 'dave', 'erin']), JSON.stringify(order));
check('an app open alone counts as activity', at.bob === '2026-09-23 00:00:00', at.bob);
check('an app open is published at day granularity only', !Object.values(at).some((v) => v && /07:15|06:00|23:59/.test(v)));
check('a same-day edit keeps its exact time and wins', at.carol === '2026-09-23 09:00:00', at.carol);
check('seed rows still count for nothing', at.dave === '2026-09-01 00:00:00', at.dave);
check('the latest of several sessions wins', at.frank === '2026-09-10 00:00:00', at.frank);
check('no activity reads as null', at.erin === null, String(at.erin));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

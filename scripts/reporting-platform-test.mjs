// Tests for GET /api/reporting's "Active by platform" breakdown — the one
// number on that dashboard that is easy to read as bigger than it is.
//
//   node scripts/reporting-platform-test.mjs
//
// It used to count sessions. Sessions are cheap and plural: a reinstall, a
// second sign-in, a browser tab and a phone all mint their own row, so a
// two-member club could read "13 iPhone" and look like thirteen people. It
// counts distinct members now, and three things have to hold for that to
// mean anything:
//
//   1. Several sessions for one member on one platform are one person.
//   2. A member on two platforms is one person on each row — the rows
//      deliberately don't sum to Active members.
//   3. Sessions with no member (an anonymous tvOS device) have nothing to
//      dedupe by, so each still counts as one, rather than collapsing into a
//      single phantom person or vanishing from the breakdown entirely.
//
// Plus the gate: the whole endpoint is admin-only, and a logged-in non-admin
// is not "nearly an admin" for club-wide metrics.
//
// Same harness as scripts/activity-feed-test.mjs: the functions tree is
// copied to a temp directory with a `type: module` package.json so Node loads
// the .js files as the ES modules they are, and schema.sql is loaded into
// node:sqlite behind a thin D1 shim, so the SQL under test is executed.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'reporting-platform-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const reporting = await load('api/reporting.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0) } };
  }
}

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql) },
    _db: db,
  };
}

function addMember(env, slug, name, { admin = false } = {}) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, ?, 0)'
  ).run(slug, name, name.split(' ')[0], admin ? 1 : 0);
}

// `slug` may be null: that is an anonymous device (tvOS signs in without
// carrying a member on the session row).
let sessionSeq = 0;
function addSession(env, { slug = null, platform = null, lastSeen = 'now' } = {}) {
  const id = `session-${++sessionSeq}`;
  const seen = lastSeen === 'now'
    ? new Date().toISOString()
    : lastSeen; // an explicit timestamp, or null for "never checked in"
  env._db.prepare(
    `INSERT INTO sessions (id, email, member_slug, expires_at, created_at, last_seen_at, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, slug || `anon-${id}`, slug, new Date(Date.now() + 86400000).toISOString(),
        new Date().toISOString(), seen, platform);
  return id;
}

const call = async (env, cookie) => reporting.onRequestGet({
  env,
  request: new Request(`${ORIGIN}/api/reporting`, {
    headers: cookie ? { Cookie: `session=${cookie}` } : {},
  }),
});

const body = async (env, cookie) => (await call(env, cookie)).json();

// ---- scenarios ----

console.log('\n== the dashboard is admin-only');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const anonRes = await call(env, undefined);
  check('no session is 403', anonRes.status === 403, `got ${anonRes.status}`);

  const memberCookie = addSession(env, { slug: 'stacy', platform: 'iphone' });
  const memberRes = await call(env, memberCookie);
  check('a logged-in non-admin is 403 too', memberRes.status === 403, `got ${memberRes.status}`);

  const adminCookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  const adminRes = await call(env, adminCookie);
  check('the admin gets the report', adminRes.status === 200, `got ${adminRes.status}`);
}

console.log('\n== platform rows count people, not sessions');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  // Patrick again on the same iPhone: a reinstall and a re-login, three
  // session rows for one person.
  addSession(env, { slug: 'patrick', platform: 'iphone' });
  addSession(env, { slug: 'patrick', platform: 'iphone' });
  addSession(env, { slug: 'stacy', platform: 'iphone' });

  const r = await body(env, cookie);
  const bp = r.active_by_platform;
  check('four iPhone sessions across two people read as 2',
        bp.day.iphone === 2, JSON.stringify(bp.day));
  check('and the week/month windows agree',
        bp.week.iphone === 2 && bp.month.iphone === 2, JSON.stringify(bp));
  check('active members matches', r.active_members.day === 2, `got ${r.active_members.day}`);
}

console.log('\n== one person on two platforms counts on both rows');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  addSession(env, { slug: 'patrick', platform: 'ipad' });
  addSession(env, { slug: 'patrick', platform: 'web-large' });

  const r = await body(env, cookie);
  const day = r.active_by_platform.day;
  check('each platform he used says 1',
        day.iphone === 1 && day.ipad === 1 && day['web-large'] === 1, JSON.stringify(day));
  check('so the rows sum past active members (3 vs 1) by design',
        Object.values(day).reduce((a, b) => a + b, 0) === 3 && r.active_members.day === 1,
        JSON.stringify(day));
}

console.log('\n== sessions with no member each count as one');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  // Two Apple TVs in two houses, neither carrying a member slug.
  addSession(env, { slug: null, platform: 'tvos' });
  addSession(env, { slug: null, platform: 'tvos' });

  const day = (await body(env, cookie)).active_by_platform.day;
  check('two anonymous devices are two, not one', day.tvos === 2, JSON.stringify(day));
}

console.log('\n== a missing platform lands in "unknown", and stale sessions drop out');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, { slug: 'patrick', platform: null });
  // Stacy last checked in ten days ago: inside the month, outside the week.
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  addSession(env, { slug: 'stacy', platform: 'iphone', lastSeen: tenDaysAgo });

  const bp = (await body(env, cookie)).active_by_platform;
  check('a null platform is reported as unknown', bp.day.unknown === 1, JSON.stringify(bp.day));
  check('a 10-day-old session is out of the week window',
        bp.week.iphone === undefined, JSON.stringify(bp.week));
  check('but inside the month window', bp.month.iphone === 1, JSON.stringify(bp.month));
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

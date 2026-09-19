// Tests for GET /api/reporting's people numbers — Active members, "Active by
// platform" and "How people sign in", the three that are easy to read as
// bigger than they are.
//
//   node scripts/reporting-platform-test.mjs
//
// They used to count sessions. Sessions are per device and plural: a
// reinstall, a second sign-in, a browser tab and a phone all mint their own
// row, so a two-member club could read "13 iPhone" and look like thirteen
// people. Every one of them counts distinct *people* now — one member on
// three Apple TVs, two Macs or four Rokus is one user, not three, two or
// four — and these things have to hold for that to mean anything:
//
//   1. Several sessions for one member on one platform are one person.
//   2. A member on two platforms is one person on each row — the rows
//      deliberately don't sum to Active members.
//   3. Sign-in methods count people too: four devices signed in with Apple
//      is one person who depends on Apple.
//   4. Sessions with no member (a legacy row from before member_slug) fall
//      back to the identity they do carry, so one person's old devices
//      collapse into one person and two strangers stay two.
//   5. A session reaches the breakdown under the platform it actually used.
//      /auth/check is the only writer of sessions.platform *and* the write
//      that makes a session visible here, so a check sent without the header
//      counts the member in "Unknown" — and used to hold them there for an
//      hour behind the once-an-hour throttle.
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
const authCheck = await load('auth/check.js');

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

// `slug` may be null: that is a session from before member_slug existed, which
// carries only the identity in `email`. `identity` sets that column; it
// defaults to something unique per row, so a test that doesn't care about it
// gets two distinct strangers rather than an accidental match.
let sessionSeq = 0;
function addSession(env, { slug = null, platform = null, lastSeen = 'now',
                           identity = null, method = null, createdAt = null } = {}) {
  const id = `session-${++sessionSeq}`;
  const seen = lastSeen === 'now'
    ? new Date().toISOString()
    : lastSeen; // an explicit timestamp, or null for "never checked in"
  env._db.prepare(
    `INSERT INTO sessions (id, email, member_slug, expires_at, created_at, last_seen_at, platform, auth_method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, identity || slug || `anon-${id}`, slug, new Date(Date.now() + 86400000).toISOString(),
        createdAt || new Date().toISOString(), seen, platform, method);
  return id;
}

// A client calling GET /auth/check, with or without naming its platform. The
// endpoint defers its writes to waitUntil, so collect and await them — in the
// Worker they land before the next request, and the point of these cases is
// what the *next* read sees.
async function authCheckAs(env, cookie, clientPlatform) {
  const pending = [];
  await authCheck.onRequestGet({
    env,
    waitUntil: (p) => pending.push(p),
    request: new Request(`${ORIGIN}/auth/check`, {
      headers: {
        Cookie: `session=${cookie}`,
        ...(clientPlatform ? { 'X-Client-Platform': clientPlatform } : {}),
      },
    }),
  });
  await Promise.all(pending);
}

const platformOf = (env, id) =>
  env._db.prepare('SELECT platform FROM sessions WHERE id = ?').get(id).platform;

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

console.log('\n== one person\'s pile of devices is one person');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  // Three Apple TVs, two Macs and four Rokus — all Patrick's.
  for (let i = 0; i < 3; i++) addSession(env, { slug: 'patrick', platform: 'tvos' });
  for (let i = 0; i < 2; i++) addSession(env, { slug: 'patrick', platform: 'mac' });
  for (let i = 0; i < 4; i++) addSession(env, { slug: 'patrick', platform: 'roku' });
  // Stacy has one of each, so every row should read 2, never 10.
  addSession(env, { slug: 'stacy', platform: 'tvos' });
  addSession(env, { slug: 'stacy', platform: 'mac' });
  addSession(env, { slug: 'stacy', platform: 'roku' });

  const r = await body(env, cookie);
  const day = r.active_by_platform.day;
  check('three Apple TVs and one are two people', day.tvos === 2, JSON.stringify(day));
  check('two Macs and one are two people', day.mac === 2, JSON.stringify(day));
  check('four Rokus and one are two people', day.roku === 2, JSON.stringify(day));
  check('and the club is two active members, not ten',
        r.active_members.day === 2, `got ${r.active_members.day}`);
}

console.log('\n== legacy sessions with no member dedupe on the identity they carry');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  // Two Apple TVs in one house, from before member_slug: same identity.
  addSession(env, { slug: null, identity: 'jc@example.com', platform: 'tvos' });
  addSession(env, { slug: null, identity: 'jc@example.com', platform: 'tvos' });
  // A third in someone else's house.
  addSession(env, { slug: null, identity: 'whitt@example.com', platform: 'tvos' });

  const day = (await body(env, cookie)).active_by_platform.day;
  check('one person\'s two old devices are one, the stranger\'s is another',
        day.tvos === 2, JSON.stringify(day));
}

console.log('\n== a slug can never collide with a legacy identity');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone' });
  // A member-less row whose identity happens to read exactly like a slug.
  addSession(env, { slug: null, identity: 'patrick', platform: 'tvos' });

  const r = await body(env, cookie);
  check('the member and the lookalike stay two people',
        r.active_members.day === 2, `got ${r.active_members.day}`);
}

console.log('\n== sign-in methods count people, not sessions');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone', method: 'apple' });
  // Patrick signs in with Apple on three more devices.
  addSession(env, { slug: 'patrick', platform: 'tvos', method: 'apple' });
  addSession(env, { slug: 'patrick', platform: 'mac', method: 'apple' });
  addSession(env, { slug: 'patrick', platform: 'ipad', method: 'apple' });
  // ...and once by email, which is a second row for the same person.
  addSession(env, { slug: 'patrick', platform: 'web-large', method: 'email' });
  addSession(env, { slug: 'stacy', platform: 'iphone', method: 'sms' });

  const sm = (await body(env, cookie)).signin_methods;
  check('four Apple sign-ins by one person read as 1',
        sm.week.apple === 1, JSON.stringify(sm.week));
  check('his email sign-in is the same person on the other row',
        sm.week.email === 1, JSON.stringify(sm.week));
  check('and Stacy is the only one on SMS', sm.week.sms === 1, JSON.stringify(sm.week));
  check('so the rows do not sum to the session count (3 vs 6)',
        Object.values(sm.week).reduce((a, b) => a + b, 0) === 3, JSON.stringify(sm.week));
  check('the 30- and 90-day windows agree',
        sm.month.apple === 1 && sm.quarter.apple === 1, JSON.stringify(sm));
}

console.log('\n== sign-in windows are cut by when the session was minted');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  addMember(env, 'stacy', 'Stacy Kallay');
  const cookie = addSession(env, { slug: 'patrick', platform: 'iphone', method: 'apple' });
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
  addSession(env, { slug: 'stacy', platform: 'iphone', method: 'sms', createdAt: fortyDaysAgo });

  const sm = (await body(env, cookie)).signin_methods;
  check('a 40-day-old sign-in is outside the month window',
        sm.month.sms === undefined, JSON.stringify(sm.month));
  check('but inside the quarter', sm.quarter.sms === 1, JSON.stringify(sm.quarter));
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

console.log('\n== a session is stamped with the platform it actually used');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  // A fresh session, never checked in: no last_seen_at, no platform.
  const id = addSession(env, { slug: 'patrick', lastSeen: null });

  // A page that forgets the header still makes the session countable, and
  // that is exactly how a member lands in the Unknown row.
  await authCheckAs(env, id, null);
  check('a header-less check leaves the platform unknown',
        platformOf(env, id) === null, `got ${platformOf(env, id)}`);
  check('and the dashboard shows them under unknown',
        (await body(env, id)).active_by_platform.day.unknown === 1);

  // The next check names the platform. The once-an-hour throttle used to skip
  // this write entirely, holding the member in Unknown for the rest of the
  // hour; a session with no platform yet takes one immediately.
  await authCheckAs(env, id, 'web-large');
  check('a named platform backfills straight past the throttle',
        platformOf(env, id) === 'web-large', `got ${platformOf(env, id)}`);
  const day = (await body(env, id)).active_by_platform.day;
  check('so they move onto the web row', day['web-large'] === 1, JSON.stringify(day));
  check('and out of unknown', day.unknown === undefined, JSON.stringify(day));
}

console.log('\n== a stamped platform is neither erased nor rewritten every request');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: true });
  const id = addSession(env, { slug: 'patrick', lastSeen: null });
  await authCheckAs(env, id, 'iphone');
  check('the first named check stamps it', platformOf(env, id) === 'iphone');

  // A later call that omits the header keeps the last known platform.
  await authCheckAs(env, id, null);
  check('a header-less check does not erase it', platformOf(env, id) === 'iphone',
        `got ${platformOf(env, id)}`);

  // And once it is set, the backfill can't fire again: inside the throttle
  // hour nothing is written at all, so a second platform doesn't churn the row.
  await authCheckAs(env, id, 'ipad');
  check('and the row is not rewritten inside the throttle hour',
        platformOf(env, id) === 'iphone', `got ${platformOf(env, id)}`);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

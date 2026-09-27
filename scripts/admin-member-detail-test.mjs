// Tests for the two endpoints behind the admin member screen:
// GET /api/admin-member-emails — the roster behind Manage Members, and the
// `?member=<slug>` narrowing the screen's detail block reads — and
// GET /api/admin-member-groups, its Groups section.
//
//   node scripts/admin-member-detail-test.mjs
//
// The first hands back every member's login emails and phone numbers, so two
// things have to hold and neither shows up in a rendered page:
//
//   1. It is admin-only. A logged-in non-admin is not "nearly an admin" here;
//      they are a member whose club-mates' phone numbers are none of their
//      business.
//   2. `?member=` returns that member and no one else. The strip draws contact
//      details under a name — a filter that quietly matched more than one row
//      would put the wrong person's email under the wrong person's name.
//
// The second is the only place a private group's membership is legible to
// somebody outside the group, so the same two properties matter and one more:
// it answers with membership and never content.
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'admin-member-detail-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const roster = await load('api/admin-member-emails.js');
const memberGroups = await load('api/admin-member-groups.js');

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
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

function addMember(env, slug, { admin = 0, via = 'apple', email, phone, joined } = {}) {
  env._db.prepare(
    `INSERT INTO members (slug, name, first_name, last_name, is_admin, disabled, enrolled_via, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(slug, `${slug}'s Shows`, slug, 'Member', admin, via, joined ?? '2026-08-01T00:00:00Z');
  if (email) {
    env._db.prepare('INSERT INTO member_emails (member_slug, email, is_primary) VALUES (?, ?, 1)')
      .run(slug, email);
  }
  if (phone) {
    env._db.prepare('INSERT INTO member_phones (member_slug, phone, is_primary) VALUES (?, ?, 1)')
      .run(slug, phone);
  }
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { slug, title, list = 'watching', archived = 0, addedBy = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, created_at, updated_at, added_by, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', addedBy, archived);
}

function addGroup(env, { name, creator, created = '2026-08-01T00:00:00Z', members = [] }) {
  const r = env._db.prepare(
    'INSERT INTO groups (name, creator_slug, created_at) VALUES (?, ?, ?)'
  ).run(name, creator, created);
  const id = Number(r.lastInsertRowid);
  for (const slug of [creator, ...members]) {
    env._db.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, member_slug) VALUES (?, ?)'
    ).run(id, slug);
  }
  return id;
}

const get = (path, cookie) =>
  new Request(ORIGIN + path, { headers: cookie ? { Cookie: `session=${cookie}` } : {} });

const call = (env, path, cookie) => roster.onRequestGet({ env, request: get(path, cookie) });
const callGroups = (env, path, cookie) =>
  memberGroups.onRequestGet({ env, request: get(path, cookie) });

// ---- scenarios ----

console.log('\n== contact details are admin-only');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1, email: 'patrick@example.com' });
  addMember(env, 'stacy', { email: 'stacy@example.com', phone: '+15551234567' });

  const anon = await call(env, '/api/admin-member-emails');
  check('no session is refused', anon.status === 403, `got ${anon.status}`);
  check('and leaks no address', !(await anon.text()).includes('stacy@example.com'));

  const memberCookie = addSession(env, 'stacy');
  const member = await call(env, '/api/admin-member-emails', memberCookie);
  check('a logged-in non-admin is refused too', member.status === 403, `got ${member.status}`);
  check('including their own row', !(await member.text()).includes('stacy@example.com'));

  const adminCookie = addSession(env, 'patrick');
  const admin = await call(env, '/api/admin-member-emails', adminCookie);
  check('an admin gets the roster', admin.status === 200, `got ${admin.status}`);
  check('with everyone on it', (await admin.json()).members.length === 2);
}

console.log('\n== ?member= narrows to exactly one row');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1, email: 'patrick@example.com' });
  addMember(env, 'stacy', { email: 'stacy@example.com', phone: '+15551234567' });
  addMember(env, 'quinn', { email: 'quinn@example.com' });
  const cookie = addSession(env, 'patrick');

  const { members } = await (await call(env, '/api/admin-member-emails?member=stacy', cookie)).json();
  check('one row comes back', members.length === 1, JSON.stringify(members.map((m) => m.slug)));
  check('and it is the right person', members[0].slug === 'stacy', members[0]?.slug);
  check('with their contacts attached',
        members[0].emails[0] === 'stacy@example.com' && members[0].phones[0] === '+15551234567',
        JSON.stringify(members[0]));
  check('and nobody else\'s', JSON.stringify(members).indexOf('quinn@example.com') === -1);

  const unknown = await (await call(env, '/api/admin-member-emails?member=nobody', cookie)).json();
  check('an unknown slug returns nothing', unknown.members.length === 0);

  // The WHERE clause is assembled as a string; the value must still be bound.
  const injected = await (await call(
    env, `/api/admin-member-emails?member=${encodeURIComponent("x' OR '1'='1")}`, cookie)).json();
  check('a slug that looks like SQL matches nothing', injected.members.length === 0,
        JSON.stringify(injected.members.map((m) => m.slug)));
}

console.log('\n== what the admin strip reads');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'stacy', { via: 'apple', email: 'stacy@example.com', joined: '2026-08-09T00:00:00Z' });
  const cookie = addSession(env, 'patrick');
  addShow(env, { slug: 'stacy', title: 'Severance' });
  addShow(env, { slug: 'stacy', title: 'Andor', list: 'next' });
  addShow(env, { slug: 'stacy', title: 'Old Thing', archived: 1 });
  addShow(env, { slug: 'stacy', title: 'Starter', addedBy: 'seed' });

  const { members } = await (await call(env, '/api/admin-member-emails?member=stacy', cookie)).json();
  const m = members[0];
  check('the join date rides along', m.joined_at === '2026-08-09T00:00:00Z', m.joined_at);
  check('normalised to fraction-less UTC ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.joined_at || ''),
        m.joined_at);
  check('how they enrolled', m.enrolled_via === 'apple', m.enrolled_via);
  check('active non-seed shows are counted', m.show_count === 2, `got ${m.show_count}`);
  check('archived shows are counted separately', m.archived_count === 1, `got ${m.archived_count}`);
  check('and the 30-day rollup is per list', m.activity_30d && typeof m.activity_30d.watching === 'number',
        JSON.stringify(m.activity_30d));
  // The admin member screen draws list_counts and show_count one above the
  // other, so a disagreement between them is visible. Same filters on both:
  // active, non-seed. The seeded row and the archived one are in neither.
  const lc = m.list_counts || {};
  check('current list totals ride along', lc.watching === 1 && lc.next === 1
        && lc.waiting === 0 && lc.recommending === 0, JSON.stringify(lc));
  check('and they sum to show_count',
        lc.watching + lc.waiting + lc.recommending + lc.next === m.show_count,
        `${JSON.stringify(lc)} vs ${m.show_count}`);
}

console.log('\n== a member\'s groups are admin-only');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'stacy');
  addMember(env, 'thayna');
  addGroup(env, { name: 'Thursday Night', creator: 'stacy', members: ['thayna'] });

  const anon = await callGroups(env, '/api/admin-member-groups?member=stacy');
  check('no session is refused', anon.status === 403, `got ${anon.status}`);
  check('and names no group', !(await anon.text()).includes('Thursday Night'));

  // The bar is admin, not "is in the group". A member has /api/groups for the
  // groups that are theirs; this endpoint is the operator's view and answers
  // nobody else, even about themselves.
  const memberCookie = addSession(env, 'stacy');
  const member = await callGroups(env, '/api/admin-member-groups?member=stacy', memberCookie);
  check('a logged-in non-admin is refused', member.status === 403, `got ${member.status}`);
  check('including for a group they are in', !(await member.text()).includes('Thursday Night'));

  const adminCookie = addSession(env, 'patrick');
  const admin = await callGroups(env, '/api/admin-member-groups?member=stacy', adminCookie);
  check('an admin gets the groups', admin.status === 200, `got ${admin.status}`);
  // The point of the answer: an admin who is in none of these groups still
  // sees them. That is the disclosure this endpoint makes on purpose.
  check('though the admin is in none of them', (await admin.json()).groups.length === 1);
}

console.log('\n== which groups, and who is in them');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'stacy');
  addMember(env, 'thayna');
  addMember(env, 'quinn');
  const cookie = addSession(env, 'patrick');
  addGroup(env, { name: 'Thursday Night', creator: 'stacy', members: ['thayna'], created: '2026-08-02T00:00:00Z' });
  addGroup(env, { name: 'Movie Club', creator: 'thayna', members: ['quinn'], created: '2026-08-05T00:00:00Z' });
  addGroup(env, { name: 'Not Hers', creator: 'quinn', created: '2026-08-06T00:00:00Z' });

  const { groups } = await (await callGroups(env, '/api/admin-member-groups?member=thayna', cookie)).json();
  check('every group she is in comes back', groups.length === 2, JSON.stringify(groups.map((g) => g.name)));
  check('newest first', groups[0].name === 'Movie Club', groups[0]?.name);
  check('a group she is not in does not', !JSON.stringify(groups).includes('Not Hers'));

  const thursday = groups.find((g) => g.name === 'Thursday Night');
  check('the roster is the whole group', thursday.members.length === 2,
        JSON.stringify(thursday.members.map((m) => m.slug)));
  check('named, not just slugged', thursday.members.every((m) => (m.name || '').includes('Member')),
        JSON.stringify(thursday.members.map((m) => m.name)));
  check('and the creator is marked',
        thursday.members.find((m) => m.slug === 'stacy').is_creator === 1
        && thursday.members.find((m) => m.slug === 'thayna').is_creator === 0,
        JSON.stringify(thursday.members));
  check('the count matches the roster it opens',
        thursday.member_count === thursday.members.length,
        `${thursday.member_count} vs ${thursday.members.length}`);

  const none = await (await callGroups(env, '/api/admin-member-groups?member=patrick', cookie)).json();
  check('a member in no groups gets an empty list', none.groups.length === 0);

  const unknown = await (await callGroups(env, '/api/admin-member-groups?member=nobody', cookie)).json();
  check('an unknown slug returns nothing', unknown.groups.length === 0);

  const noSlug = await callGroups(env, '/api/admin-member-groups', cookie);
  check('a missing member is a 400, not everyone\'s groups', noSlug.status === 400, `got ${noSlug.status}`);

  // The group id list is assembled into the IN (…) clause as placeholders;
  // the member slug is bound. Neither may become a string the caller writes.
  const injected = await (await callGroups(
    env, `/api/admin-member-groups?member=${encodeURIComponent("x' OR '1'='1")}`, cookie)).json();
  check('a slug that looks like SQL matches nothing', injected.groups.length === 0,
        JSON.stringify(injected.groups.map((g) => g.name)));
}

console.log('\n== membership, never content');
{
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'stacy');
  addMember(env, 'thayna');
  const cookie = addSession(env, 'patrick');
  addGroup(env, { name: 'Thursday Night', creator: 'stacy', members: ['thayna'] });
  addShow(env, { slug: 'stacy', title: 'Severance' });
  addShow(env, { slug: 'thayna', title: 'The Bear' });

  const body = await (await callGroups(env, '/api/admin-member-groups?member=thayna', cookie)).text();
  check('the group\'s shows stay out of it',
        !body.includes('Severance') && !body.includes('The Bear'), body);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

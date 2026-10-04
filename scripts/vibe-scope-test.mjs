// Tests for /api/vibe's scoping — who is allowed to read whose vibe, and what
// the taste exclusion (functions/_shared/excluded-members.js) does and doesn't
// take away.
//
//   node scripts/vibe-scope-test.mjs
//
// Written for the 2026-08 "Paula doesn't see her vibe" report. The exclusion
// list keeps a sprawling library out of the club's shared signals; it had also
// been deciding who may LOOK at a profile, which dropped its member from her
// own picker, answered her own slug with "excluded from taste analysis", and
// hid her from the group-mates whose vibes she could read. Group membership
// decides visibility; the exclusion decides math. Four things have to hold at
// once, and none of them is visible in a diff:
//
//   1. It stays session-gated. A taste fingerprint is derived from a member's
//      library, which never belongs on the public surface (docs/INVARIANTS.md).
//   2. An excluded member reads her own vibe — she is in her own picker and
//      her own slug returns a real profile.
//   3. Her group-mates read it too, symmetrically, exactly like any other
//      member's. Group scoping is still the wall: a member outside the group
//      is 403, not a courtesy view.
//   4. Her library still doesn't leak into anyone else's numbers: a title only
//      she holds is never an aligned pick for someone else.
//
// Plus the trait-fill queue, which is what makes (2) more than a blank screen:
// a title only an excluded member holds still gets scored, because title_traits
// is a catalog of titles rather than a tally of whose taste counts.
//
// Same harness as scripts/activity-feed-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json so Node loads the
// .js files as the ES modules they are, and schema.sql is loaded into
// node:sqlite behind a thin D1 shim, so the SQL under test is executed.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'vibe-scope-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const vibe = await load('api/vibe.js');
const vibeFill = await load('api/admin-vibe-fill.js');
const { TRAIT_NAMES } = await load('_shared/vibe-traits.js');
const { EXCLUDED_FROM_TASTE } = await load('_shared/excluded-members.js');

const ORIGIN = 'https://showpicker.club';
// The list is data, not a constant of the test — read the real one so this
// keeps testing whoever is actually on it.
const EXCLUDED = EXCLUDED_FROM_TASTE[0];

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

function addMember(env, slug, name, { admin = 0 } = {}) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, ?, 0)'
  ).run(slug, name, name.split(' ')[0], admin);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addGroup(env, name, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run(name, slugs[0]);
  const { id } = env._db.prepare('SELECT MAX(id) AS id FROM groups').get();
  for (const s of slugs) {
    env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  }
}

function addShow(env, { slug, title, list = 'watching', archived = 0, addedBy = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, added_by, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, addedBy, archived, '2026-08-01T00:00:00Z');
}

// Every trait defaults to 0.5; `lean` nudges the few that decide a cluster, so
// two fixtures can be told apart without spelling out 26 columns each.
function addTraits(env, title, lean = {}) {
  // Fixture shows are unpinned, so each one's key is its title (migration 081).
  const cols = ['show_key', 'title', ...TRAIT_NAMES, 'scored_at'];
  const values = [
    'title:' + title.trim().toLowerCase(), title,
    ...TRAIT_NAMES.map((t) => (typeof lean[t] === 'number' ? lean[t] : 0.5)),
    '2026-08-02T00:00:00Z',
  ];
  env._db.prepare(
    `INSERT OR REPLACE INTO title_traits (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
}

function get(path, { cookie, cron } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `session=${cookie}`;
  if (cron) headers['X-Cron-Secret'] = cron;
  return new Request(ORIGIN + path, { headers });
}

const call = async (env, path, opts) =>
  vibe.onRequestGet({ env, request: get(path, opts) });

// A club where the excluded member and one other member share a group, plus a
// stranger in no group at all.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, EXCLUDED, 'Paula Turner');
  addMember(env, 'stranger', 'Stacy Kallay');
  addGroup(env, 'Household', ['patrick', EXCLUDED]);

  // Shared title — the only one of hers the club also carries.
  addShow(env, { slug: 'patrick', title: 'Severance', list: 'watching' });
  addShow(env, { slug: EXCLUDED, title: 'Severance', list: 'watching' });
  addTraits(env, 'Severance', { warmth: 0.2, darkness: 0.8, intellectual_curiosity: 0.9 });

  // Hers alone, on both weighted lists, so her fingerprint is mostly these.
  // Five scored titles is the floor for naming a cluster at all
  // (_shared/vibe-match.js#MIN_SCORED_FOR_CLUSTER), and these tests are about
  // what she can reach, not about a thin library — so she clears it.
  addShow(env, { slug: EXCLUDED, title: 'Only Paula Watches This', list: 'recommending' });
  addShow(env, { slug: EXCLUDED, title: 'Her Other One', list: 'watching' });
  addShow(env, { slug: EXCLUDED, title: 'And Another', list: 'recommending' });
  addShow(env, { slug: EXCLUDED, title: 'One More Of Hers', list: 'waiting' });
  addTraits(env, 'Only Paula Watches This', { warmth: 0.9, comfort_coziness: 0.9, darkness: 0.1 });
  addTraits(env, 'Her Other One', { warmth: 0.8, humor_warmth: 0.9, cynicism: 0.1 });
  addTraits(env, 'And Another', { warmth: 0.85, community_belonging: 0.8, cynicism: 0.15 });
  addTraits(env, 'One More Of Hers', { warmth: 0.75, optimism: 0.8, nihilism: 0.1 });

  // A title only the stranger holds — a legitimate aligned pick for anyone.
  addShow(env, { slug: 'stranger', title: 'The Bear', list: 'recommending' });
  addTraits(env, 'The Bear', { warmth: 0.7, chaos_intensity: 0.9 });

  return env;
}

console.log('\n== the vibe is members-only');
{
  const env = club();
  const anon = await call(env, `/api/vibe?member=${EXCLUDED}`);
  check('no session is 401', anon.status === 401, `got ${anon.status}`);
  check('and the body carries no titles', !(await anon.text()).includes('Only Paula Watches This'));

  const expired = addSession(env, 'patrick');
  env._db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), expired);
  const stale = await call(env, '/api/vibe', { cookie: expired });
  check('an expired session is 401 too', stale.status === 401, `got ${stale.status}`);
}

console.log('\n== an excluded member reads her own vibe');
{
  const env = club();
  const cookie = addSession(env, EXCLUDED);

  const { members, member } = await (await call(env, `/api/vibe?member=${EXCLUDED}`, { cookie })).json();
  check('she is in her own picker', members.some((m) => m.slug === EXCLUDED),
        JSON.stringify(members.map((m) => m.slug)));
  check('and the profile is a real read, not the exclusion notice',
        member && member.excluded !== true && !!member.cluster, JSON.stringify(member));
  check('computed from her whole library, not just the shared title',
        member.scored_count === 5 && member.active_count === 5,
        `${member.scored_count}/${member.active_count}`);

  // No ?member= at all is the app's first call; the picker must still hold her.
  const { members: bare } = await (await call(env, '/api/vibe', { cookie })).json();
  check('the picker lists her before a slug is chosen', bare.some((m) => m.slug === EXCLUDED),
        JSON.stringify(bare.map((m) => m.slug)));
}

console.log('\n== and so do her group-mates, symmetrically');
{
  const env = club();
  const cookie = addSession(env, 'patrick');

  const { members } = await (await call(env, '/api/vibe', { cookie })).json();
  check('a group-mate sees her in the picker', members.some((m) => m.slug === EXCLUDED),
        JSON.stringify(members.map((m) => m.slug)));

  const { member } = await (await call(env, `/api/vibe?member=${EXCLUDED}`, { cookie })).json();
  check('and reads the same profile she does',
        member && member.excluded !== true && !!member.cluster && member.scored_count === 5,
        JSON.stringify(member));

  // Symmetry is the point: she could already read theirs.
  const hers = await (await call(env, '/api/vibe', { cookie: addSession(env, EXCLUDED) })).json();
  check('the view is mutual', hers.members.some((m) => m.slug === 'patrick'),
        JSON.stringify(hers.members.map((m) => m.slug)));
}

console.log('\n== two group-mates with the same taste still read differently');
{
  const env = makeEnv();
  addMember(env, 'ada', 'Ada Lovelace');
  addMember(env, 'bo', 'Bo Diddley');
  addMember(env, 'cy', 'Cy Twombly');
  addGroup(env, 'Twins', ['ada', 'bo']);

  // The same six titles each, so their fingerprints are identical to the last
  // decimal. Left to a plain best-match they are the same person.
  const shared = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  shared.forEach((t, i) => {
    addTraits(env, t, { prestige_energy: 0.7 + i * 0.01, moral_ambiguity: 0.68, darkness: 0.6 });
    for (const who of ['ada', 'bo', 'cy']) {
      addShow(env, { slug: who, title: t, list: i % 2 ? 'watching' : 'recommending' });
    }
  });

  const adaCookie = addSession(env, 'ada');
  const boCookie = addSession(env, 'bo');
  const adaVibe = await (await call(env, '/api/vibe?member=ada', { cookie: adaCookie })).json();
  const boVibe = await (await call(env, '/api/vibe?member=bo', { cookie: boCookie })).json();
  check('both get a persona', !!adaVibe.member.cluster && !!boVibe.member.cluster,
        JSON.stringify([adaVibe.member.cluster?.id, boVibe.member.cluster?.id]));
  check('and identical libraries do not produce identical personas',
        adaVibe.member.cluster.id !== boVibe.member.cluster.id,
        `${adaVibe.member.cluster.id} vs ${boVibe.member.cluster.id}`);

  // The label must not depend on who is asking — a group-mate looking at Ada
  // sees what Ada sees.
  const adaSeenByBo = await (await call(env, '/api/vibe?member=ada', { cookie: boCookie })).json();
  check('and the same person reads the same to everyone',
        adaSeenByBo.member.cluster.id === adaVibe.member.cluster.id,
        `${adaSeenByBo.member.cluster.id} vs ${adaVibe.member.cluster.id}`);

  // Cy is in no group, so nothing was taken from him: he keeps his own best.
  const cyVibe = await (await call(env, '/api/vibe?member=cy', { cookie: addSession(env, 'cy') })).json();
  check('a member in no group is untouched by the rule',
        cyVibe.member.cluster.assigned === false, JSON.stringify(cyVibe.member.cluster.assigned));
}

console.log('\n== group scoping is untouched');
{
  const env = club();
  const cookie = addSession(env, 'stranger');
  const outside = await call(env, '/api/vibe?member=patrick', { cookie });
  check('a member outside the group is still 403', outside.status === 403, `got ${outside.status}`);

  const { members } = await (await call(env, '/api/vibe', { cookie })).json();
  check('and their picker is themselves only',
        members.length === 1 && members[0].slug === 'stranger',
        JSON.stringify(members.map((m) => m.slug)));

  // The excluded member is not a special case here either — she is refused
  // for the same reason anyone outside the group is.
  const outsideHers = await call(env, `/api/vibe?member=${EXCLUDED}`, { cookie });
  check('an excluded member is 403 to a non-group-mate too',
        outsideHers.status === 403, `got ${outsideHers.status}`);
  check('with nothing of hers in the body',
        !(await outsideHers.text()).includes('Only Paula Watches This'));
}

console.log('\n== her library still stays out of the club pool');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const { member } = await (await call(env, '/api/vibe?member=patrick', { cookie })).json();
  const picks = (member.aligned_picks || []).map((p) => p.title);
  check('a title only she holds is never an aligned pick for someone else',
        !picks.includes('Only Paula Watches This') && !picks.includes('Her Other One'),
        JSON.stringify(picks));
  check('a title the rest of the club holds still is', picks.includes('The Bear'),
        JSON.stringify(picks));
}

console.log('\n== the trait-fill queue covers her titles');
{
  const env = club();
  // Two unscored titles: one hers alone, one the stranger's. Both must queue —
  // an unscored title of hers is what makes her own vibe read blank.
  addShow(env, { slug: EXCLUDED, title: 'Unscored Of Hers', list: 'watching' });
  addShow(env, { slug: 'stranger', title: 'Unscored Of Theirs', list: 'watching' });

  addMember(env, 'admin', 'Ada Admin', { admin: 1 });
  const cookie = addSession(env, 'admin');
  const status = await (await vibeFill.onRequestGet({ env, request: get('/api/admin-vibe-fill', { cookie }) })).json();
  check('both unscored titles are queued', status.fill_remaining === 2,
        JSON.stringify(status));

  // An archived-everywhere title is still skipped — that filter is separate.
  const gated = await vibeFill.onRequestGet({ env, request: get('/api/admin-vibe-fill') });
  check('and the queue stays admin-gated', gated.status === 403, `got ${gated.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

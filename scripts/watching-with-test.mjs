// Tests for "Watching With" as people — the first cross-member write since
// suggest-a-show and share-to-member were retired in 2026-07.
//
//   node scripts/watching-with-test.mjs
//
// Naming a group-mate on a show writes to *their* library: the title lands on
// their list and their copy names you back. That is a genuinely different
// proposition from every other write in this codebase, and the properties
// worth pinning are the ones that keep it from being an open tap on other
// people's lists:
//
//   1. Only a member you share a private group with can be named. A
//      hand-typed slug for a stranger writes nothing — it is dropped, not
//      honoured, and it does not fail the rest of the save.
//   2. A list they already made is never rearranged. If they have the title
//      on Next Up and you have it on Watching, theirs stays on Next Up. No
//      duplicate row, no reordering, no silent promotion.
//   3. Unlinking takes your name off their copy and leaves the show there.
//      It arrived on their list and they may have started watching it;
//      deleting it is their call, not the tagger's.
//   4. The free text still works. "my sister" was always a legal value and
//      still is, and it survives a linked name being added and removed
//      around it.
//   5. It stays owner-only. `watchers` is as personal as `watching_with` —
//      another member reading your list gets neither.
//
// Plus the two cleanups nothing else would do: an archived copy is brought
// back rather than duplicated, and deleting your own copy takes your name off
// the rows that mirror it (the foreign-key cascade only reaches the links
// hanging off the row being deleted).
//
// Same harness as scripts/vibe-scope-test.mjs: the functions tree is copied to
// a temp directory with a `type: module` package.json so Node loads the .js
// files as the ES modules they are, and schema.sql is loaded into node:sqlite
// behind a thin D1 shim, so the SQL under test is executed. No TMDB_TOKEN is
// set, so enrichment returns its empty shape without touching the network.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'watching-with-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const showsApi = await load('api/shows.js');
const showApi = await load('api/shows/[id].js');
const groupMembersApi = await load('api/group-members.js');
const { MAX_WATCHERS, composeWatchingWith, forgetMemberAsWatcher } = await load('_shared/watchers.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

// D1 refuses a query with more than 100 bound parameters. node:sqlite is far
// more permissive (32k+), which is how an IN (...) built over a whole library
// could pass every test here and still 500 in production — so the shim
// enforces the real limit.
const D1_MAX_BOUND_PARAMS = 100;

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  guard() {
    if (this.args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(`D1_ERROR: too many bound parameters (${this.args.length} > ${D1_MAX_BOUND_PARAMS})`);
    }
  }
  async first() {
    this.guard();
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    this.guard();
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    this.guard();
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

function addMember(env, slug, name, { disabled = 0 } = {}) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial, disabled) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(slug, name, first, last || null, last ? last.charAt(0) : null, disabled);
  // The same email addSession() stamps on the session — added_by carries the
  // session email, and attribution resolves it back through member_emails.
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

function addGroup(env, name, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run(name, slugs[0]);
  const { id } = env._db.prepare('SELECT MAX(id) AS id FROM groups').get();
  for (const s of slugs) {
    env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  }
}

function addShow(env, { slug, title, list = 'watching', archived = 0, tmdbId = null, watchingWith = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, tmdb_id, watching_with, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, archived, tmdbId, watchingWith, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

const rowsFor = (env, slug) =>
  env._db.prepare('SELECT * FROM shows WHERE member_slug = ? ORDER BY id').all(slug).map((r) => ({ ...r }));
const rowFor = (env, slug, title) =>
  rowsFor(env, slug).find((r) => r.title.toLowerCase() === title.toLowerCase());
const linksFor = (env, showId) =>
  env._db.prepare('SELECT member_slug FROM show_watchers WHERE show_id = ? ORDER BY member_slug')
    .all(showId).map((r) => r.member_slug);

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

const postShow = (env, cookie, body) =>
  showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie, method: 'POST', body })));
const putShow = (env, cookie, id, body) =>
  showApi.onRequestPut(ctx(env, req(`/api/shows/${id}`, { cookie, method: 'PUT', body }), { id: String(id) }));
const deleteShow = (env, cookie, id) =>
  showApi.onRequestDelete(ctx(env, req(`/api/shows/${id}`, { cookie, method: 'DELETE' }), { id: String(id) }));
const getShows = (env, cookie, member) =>
  showsApi.onRequestGet(ctx(env, req(`/api/shows?member=${member}`, { cookie })));

// Patrick and Quinn share a group. Stacy is a member of the club in no group
// with either of them — the stranger self-enrollment made possible, and the
// reason the gate is group membership rather than "is a member".
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'quinn', 'Quinn Rosa');
  addMember(env, 'stacy', 'Stacy Kallay');
  addGroup(env, 'Household', ['patrick', 'quinn']);
  return env;
}

console.log('\n== the picker only offers people you share a group with');
{
  const env = club();
  const anon = await groupMembersApi.onRequestGet(ctx(env, req('/api/group-members')));
  check('no session is 401', anon.status === 401, `got ${anon.status}`);

  const cookie = addSession(env, 'patrick');
  const { members } = await (await groupMembersApi.onRequestGet(
    ctx(env, req('/api/group-members', { cookie })))).json();
  check('a group-mate is offered', members.some((m) => m.slug === 'quinn'));
  check('a member in no shared group is not', !members.some((m) => m.slug === 'stacy'));
  check('and neither are you', !members.some((m) => m.slug === 'patrick'));
  check('the group is named', (members.find((m) => m.slug === 'quinn').groups || []).includes('Household'));

  // A disabled account can't act on anything landing on its list, so it isn't
  // offered as someone to watch with.
  addMember(env, 'gone', 'Gone Away', { disabled: 1 });
  addGroup(env, 'Old Crew', ['patrick', 'gone']);
  const after = await (await groupMembersApi.onRequestGet(
    ctx(env, req('/api/group-members', { cookie })))).json();
  check('a disabled account is not offered', !after.members.some((m) => m.slug === 'gone'));
}

console.log('\n== naming a group-mate puts the show on their list, both ways');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const res = await postShow(env, cookie, {
    title: 'The Rehearsal', list: 'watching', watcher_slugs: ['quinn'],
  });
  check('the add succeeds', res.status === 201, `got ${res.status}`);
  const { show } = await res.json();

  const theirs = rowFor(env, 'quinn', 'The Rehearsal');
  check('it lands on their list', !!theirs);
  check('on the same list as the tagger', theirs && theirs.list === 'watching', theirs && theirs.list);
  check('their copy names the tagger', theirs && theirs.watching_with === 'Patrick',
    theirs && theirs.watching_with);
  check('the tagger’s copy names them', show.watching_with === 'Quinn', show.watching_with);
  check('the link is stored on the tagger’s row', linksFor(env, show.id).includes('quinn'));
  check('and mirrored on theirs', linksFor(env, theirs.id).includes('patrick'));
  check('the response carries the watchers', (show.watchers || []).some((w) => w.slug === 'quinn'));
}

console.log('\n== a member you share no group with cannot be named');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const res = await postShow(env, cookie, {
    title: 'Andor', list: 'watching', watcher_slugs: ['stacy'],
  });
  check('the save still succeeds', res.status === 201, `got ${res.status}`);
  const { show } = await res.json();
  check('nothing lands on their list', rowsFor(env, 'stacy').length === 0);
  check('no link is written', linksFor(env, show.id).length === 0);
  check('and their name is not composed in', !show.watching_with, String(show.watching_with));

  // The same slug typed into the free-text field is just text — it names
  // nobody and writes nothing, which is exactly the old behaviour.
  const plain = await postShow(env, cookie, {
    title: 'Shrinking', list: 'watching', watching_with: 'stacy',
  });
  const row = (await plain.json()).show;
  check('free text is left as typed', row.watching_with === 'stacy', String(row.watching_with));
  check('and still writes to nobody', rowsFor(env, 'stacy').length === 0);
}

console.log('\n== a list they already made is not rearranged');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const theirsBefore = addShow(env, { slug: 'quinn', title: 'Severance', list: 'next' });
  const { show } = await (await postShow(env, cookie, {
    title: 'Severance', list: 'watching', watcher_slugs: ['quinn'],
  })).json();

  const theirRows = rowsFor(env, 'quinn');
  check('no duplicate row is created', theirRows.length === 1, `got ${theirRows.length}`);
  check('their placement is untouched', theirRows[0].list === 'next', theirRows[0].list);
  check('the existing row is what gets linked', theirRows[0].id === theirsBefore);
  check('and it names the tagger', theirRows[0].watching_with === 'Patrick', theirRows[0].watching_with);
  check('the tagger’s own list is unaffected', show.list === 'watching');
}

console.log('\n== an archived copy comes back rather than duplicating');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const shelved = addShow(env, { slug: 'quinn', title: 'Poker Face', list: 'next', archived: 1 });
  await postShow(env, cookie, { title: 'Poker Face', list: 'watching', watcher_slugs: ['quinn'] });

  const theirRows = rowsFor(env, 'quinn');
  check('still one row', theirRows.length === 1, `got ${theirRows.length}`);
  check('the same row', theirRows[0].id === shelved);
  check('unarchived', theirRows[0].archived === 0);
  check('onto the tagger’s list', theirRows[0].list === 'watching', theirRows[0].list);
}

console.log('\n== unlinking takes the name off and leaves the show');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'Slow Horses', list: 'watching', watcher_slugs: ['quinn'],
  })).json();
  const theirs = rowFor(env, 'quinn', 'Slow Horses');
  check('precondition: it named them', theirs.watching_with === 'Patrick');

  await putShow(env, cookie, show.id, {
    title: 'Slow Horses', list: 'watching', watching_with: null, archived: 0, watcher_slugs: [],
  });

  const after = rowFor(env, 'quinn', 'Slow Horses');
  check('their row survives', !!after);
  check('still on their list', after && after.list === 'watching');
  check('but no longer names the tagger', after && after.watching_with === null, String(after && after.watching_with));
  check('the mirror link is gone', linksFor(env, after.id).length === 0);
  check('and so is the tagger’s', linksFor(env, show.id).length === 0);
  const mine = rowFor(env, 'patrick', 'Slow Horses');
  check('the tagger’s field clears too', mine.watching_with === null, String(mine.watching_with));
}

console.log('\n== free text and linked names coexist');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'The Bear', list: 'watching', watching_with: 'my sister', watcher_slugs: ['quinn'],
  })).json();
  check('both are in the display string', show.watching_with === 'my sister, Quinn', show.watching_with);

  // The client sends the composed string straight back on the next save. The
  // name must not accumulate.
  const again = await (await putShow(env, cookie, show.id, {
    title: 'The Bear', list: 'watching', watching_with: 'my sister, Quinn',
    archived: 0, watcher_slugs: ['quinn'],
  })).json();
  check('re-saving does not double the name', again.show.watching_with === 'my sister, Quinn', again.show.watching_with);

  const dropped = await (await putShow(env, cookie, show.id, {
    title: 'The Bear', list: 'watching', watching_with: 'my sister, Quinn',
    archived: 0, watcher_slugs: [],
  })).json();
  check('unlinking leaves the free text alone', dropped.show.watching_with === 'my sister', dropped.show.watching_with);
  check('and the name is really gone', !dropped.show.watching_with.includes('Quinn'));
}

console.log('\n== more than one person at a time');
{
  const env = club();
  addMember(env, 'amy', 'Amy Turner');
  addGroup(env, 'Movie Night', ['patrick', 'amy']);
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'Dune', list: 'watching', watcher_slugs: ['quinn', 'amy'],
  })).json();

  check('both are linked', linksFor(env, show.id).join(',') === 'amy,quinn', linksFor(env, show.id).join(','));
  check('both get the show', !!rowFor(env, 'quinn', 'Dune') && !!rowFor(env, 'amy', 'Dune'));
  check('both names are on the tagger’s row', show.watching_with === 'Amy, Quinn', show.watching_with);
  // Each of their copies names the tagger and nobody else: Quinn and Amy
  // share no group, so neither learns the other was named.
  check('their copy names the tagger only',
    rowFor(env, 'quinn', 'Dune').watching_with === 'Patrick',
    rowFor(env, 'quinn', 'Dune').watching_with);
  check('and does not name the other person',
    !rowFor(env, 'quinn', 'Dune').watching_with.includes('Amy'));

  // Dropping one keeps the other.
  await putShow(env, cookie, show.id, {
    title: 'Dune', list: 'watching', watching_with: 'Amy, Quinn', archived: 0, watcher_slugs: ['amy'],
  });
  check('dropping one keeps the other', linksFor(env, show.id).join(',') === 'amy');
  check('the dropped one keeps their show', !!rowFor(env, 'quinn', 'Dune'));
  check('but stops naming the tagger', rowFor(env, 'quinn', 'Dune').watching_with === null,
    String(rowFor(env, 'quinn', 'Dune').watching_with));
  check('the kept one still names them', rowFor(env, 'amy', 'Dune').watching_with === 'Patrick');
}

console.log('\n== one add cannot fan out without limit');
{
  const env = club();
  const many = [];
  for (let i = 0; i < MAX_WATCHERS + 5; i++) {
    addMember(env, `m${i}`, `Member${i} Test`);
    many.push(`m${i}`);
  }
  addGroup(env, 'Big Group', ['patrick', ...many]);
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'Succession', list: 'watching', watcher_slugs: many,
  })).json();
  check(`at most ${MAX_WATCHERS} are linked`, linksFor(env, show.id).length === MAX_WATCHERS,
    `got ${linksFor(env, show.id).length}`);
  const written = many.filter((s) => rowsFor(env, s).length > 0).length;
  check('and no more rows than that are written', written === MAX_WATCHERS, `got ${written}`);
}

console.log('\n== deleting your copy takes your name off theirs');
{
  const env = club();
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'Fargo', list: 'watching', watcher_slugs: ['quinn'],
  })).json();
  const theirs = rowFor(env, 'quinn', 'Fargo');
  check('precondition: named', theirs.watching_with === 'Patrick');

  await deleteShow(env, cookie, show.id);
  const after = rowFor(env, 'quinn', 'Fargo');
  check('their show survives the delete', !!after);
  check('no longer naming the deleted copy’s owner', after && after.watching_with === null,
    String(after && after.watching_with));
  check('and no dangling link is left behind', after && linksFor(env, after.id).length === 0);
}

console.log('\n== who is named stays as private as the field it came from');
{
  const env = club();
  const mine = addSession(env, 'patrick');
  await postShow(env, mine, { title: 'Silo', list: 'watching', watcher_slugs: ['quinn'] });

  const own = await (await getShows(env, mine, 'patrick')).json();
  check('the owner sees their own watchers', (own.shows[0].watchers || []).some((w) => w.slug === 'quinn'));

  const theirs = addSession(env, 'quinn');
  const other = await (await getShows(env, theirs, 'patrick')).json();
  const row = other.shows.find((s) => s.title === 'Silo');
  check('another member gets no watchers', !row.watchers || row.watchers.length === 0);
  check('and no watching_with either', row.watching_with === undefined);

  const anon = await showsApi.onRequestGet(ctx(env, req('/api/shows?member=patrick')));
  check('logged out is 401', anon.status === 401, `got ${anon.status}`);
}

console.log('\n== a member leaving takes their name with them');
{
  // Account deletion deletes explicitly rather than leaning on cascades, and
  // `watching_with` is text rather than a foreign key — so nothing removes a
  // departed member's name from other people's rows unless this does.
  const env = club();
  const cookie = addSession(env, 'patrick');
  const { show } = await (await postShow(env, cookie, {
    title: 'Deadwood', list: 'watching', watching_with: 'my sister', watcher_slugs: ['quinn'],
  })).json();
  check('precondition: both are named', show.watching_with === 'my sister, Quinn', show.watching_with);

  await forgetMemberAsWatcher(env, 'quinn');
  const after = rowFor(env, 'patrick', 'Deadwood');
  check('the departing member’s name is gone', !after.watching_with.includes('Quinn'), after.watching_with);
  check('and the free text is untouched', after.watching_with === 'my sister', after.watching_with);
}

console.log('\n== the arriving copy says who put it there');
{
  // A tag lands a title on a list its owner never touched, and before this
  // the copy carried no visible explanation — Paula's "not sure where this
  // came from". The owner's reads now resolve added_by back to the member it
  // belongs to; everyone else still gets nothing, same rule as added_by.
  const env = club();
  const cookie = addSession(env, 'patrick');
  await postShow(env, cookie, {
    title: 'Fruitvale Station', list: 'watching', movie: 1, watcher_slugs: ['quinn'],
  });

  const theirs = addSession(env, 'quinn');
  const { shows } = await (await getShows(env, theirs, 'quinn')).json();
  const arrived = shows.find((s) => s.title === 'Fruitvale Station');
  check('the recipient sees who added it',
    arrived.added_by_member && arrived.added_by_member.slug === 'patrick',
    JSON.stringify(arrived.added_by_member));
  check('as a display name, not an email', arrived.added_by_member?.name === 'Patrick',
    String(arrived.added_by_member?.name));

  const detail = await (await showApi.onRequestGet(
    ctx(env, req(`/api/shows/${arrived.id}`, { cookie: theirs }), { id: String(arrived.id) }))).json();
  check('the single-show read carries it too',
    detail.show.added_by_member && detail.show.added_by_member.slug === 'patrick',
    JSON.stringify(detail.show.added_by_member));

  const own = await (await getShows(env, cookie, 'patrick')).json();
  const mine = own.shows.find((s) => s.title === 'Fruitvale Station');
  check('your own adds carry no attribution', mine.added_by_member === undefined,
    JSON.stringify(mine.added_by_member));

  const other = await (await getShows(env, theirs, 'patrick')).json();
  const visible = other.shows.find((s) => s.title === 'Fruitvale Station');
  check('another member gets neither added_by nor its name',
    visible.added_by === undefined && visible.added_by_member === undefined);
}

console.log('\n== a library bigger than one query’s bind limit still loads');
{
  // watchersForShows takes one id per owned row, and D1 binds at most 100
  // parameters per query — so the day a library crossed 100 active rows, the
  // owner's own list load (and only the owner's: the watchers lookup runs
  // just for them) started 500ing. The lookup pages through the ids now.
  const env = club();
  const cookie = addSession(env, 'patrick');
  for (let i = 0; i < 120; i++) {
    addShow(env, { slug: 'patrick', title: `Filler ${i}` });
  }
  await postShow(env, cookie, {
    title: 'Fruitvale Station', list: 'watching', movie: 1, watcher_slugs: ['quinn'],
  });

  const res = await getShows(env, cookie, 'patrick');
  check('the owner’s list still loads', res.status === 200, `got ${res.status}`);
  const { shows } = await res.json();
  check('every row is there', shows.length === 121, `got ${shows.length}`);
  const tagged = shows.find((s) => s.title === 'Fruitvale Station');
  check('watchers survive the chunk seams', (tagged.watchers || []).some((w) => w.slug === 'quinn'));
}

console.log('\n== the display string is composed, not accumulated');
{
  // Unit-level: the function that keeps watching_with honest. `knownNames`
  // carries the names linked *before* the change as well as after, which is
  // what lets a dropped name be removed instead of surviving as free text.
  check('names append after free text',
    composeWatchingWith('my sister', ['Quinn']) === 'my sister, Quinn');
  check('an already-present name is not doubled',
    composeWatchingWith('my sister, Quinn', ['Quinn']) === 'my sister, Quinn');
  check('a dropped name is removed',
    composeWatchingWith('my sister, Quinn', [], ['Quinn']) === 'my sister');
  check('an empty result is null, not an empty string',
    composeWatchingWith('Quinn', [], ['Quinn']) === null);
  check('matching ignores case and padding',
    composeWatchingWith('  quinn , my sister', ['Quinn']) === 'my sister, Quinn');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

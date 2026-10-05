// Tests for POST /api/admin-query and the admin_query MCP tool — club-wide
// questions about shows in one call ("how many unique shows", "how many from
// 2020 on", "which TV shows have no genres, per member").
//
//   node scripts/admin-query-test.mjs
//
// Three things have to hold, and none of them shows up in a rendered page:
//
//   1. Who. An admin session, or an admin's AI connection holding
//      members:admin — and nothing else. The connector half needed a new
//      gate, so the suite also pins that the flag it rides on opens this
//      endpoint only: every other admin gate still refuses a delegated
//      request, flag or no flag.
//   2. What. The query is a spec over named fields, never SQL, so a value is
//      always data and an unknown field, op or measure is a 400. Private memos
//      are presence-only (countable, never returned) and nothing reaches
//      login emails.
//   3. The numbers. "titles" means one TMDB entry (or one title when TMDB
//      never matched), a multi-valued breakdown doesn't double-count totals,
//      the demo account and disabled members stay out, and a date filter
//      reads both stored timestamp shapes.
//
// Same harness as scripts/admin-member-detail-test.mjs: the functions tree is
// copied to a temp directory with a `type: module` package.json, and
// schema.sql is loaded into node:sqlite behind a thin D1 shim, so the SQL
// under test is executed.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'admin-query-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const queryApi = await load('api/admin-query.js');
const emailsApi = await load('api/admin-member-emails.js');
const { actingAs } = await load('_shared/auth.js');
const { toolNamed, toolsFor } = await load('_shared/mcp-tools.js');

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
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())) },
    DEMO_LOGIN_EMAIL: 'demo@example.com',
    _db: db,
  };
}

function addMember(env, slug, { admin = 0, disabled = 0, email } = {}) {
  env._db.prepare(
    `INSERT INTO members (slug, name, first_name, last_name, is_admin, disabled, enrolled_via)
     VALUES (?, ?, ?, 'Member', ?, ?, 'email')`
  ).run(slug, `${slug}'s Shows`, slug, admin, disabled);
  env._db.prepare('INSERT INTO member_emails (member_slug, email, is_primary) VALUES (?, ?, 1)')
    .run(slug, email || `${slug}@example.com`);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, slug, title, o = {}) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, archived, tmdb_id, tmdb_type, release_year,
       genres, seasons_released, network, notes, added_by, rating, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, o.list || 'watching', slug, o.movie ? 1 : 0, o.archived ? 1 : 0,
    o.tmdb ?? null, o.tmdb ? (o.movie ? 'movie' : 'tv') : null, o.year ?? null,
    o.genres ?? null, o.seasons ?? null, o.network ?? null, o.notes ?? null,
    `${slug}@example.com`, o.rating ?? null, o.created ?? '2026-09-01 00:00:00');
  const id = Number(r.lastInsertRowid);
  if (o.mine) {
    env._db.prepare(
      `INSERT INTO show_ratings (tmdb_id, tmdb_type, season_number, member_slug, rating) VALUES (?, ?, 0, ?, ?)`
    ).run(o.tmdb, o.movie ? 'movie' : 'tv', slug, o.mine);
  }
  for (const [i, name] of (o.cast || []).entries()) {
    env._db.prepare('INSERT INTO actors (show_id, name, ord) VALUES (?, ?, ?)').run(id, name, i);
  }
  // Facts seeded on the copy reach the shared row members read from.
  liftCopiesIntoTitles(env._db);
  return id;
}

// The club the numbers below are computed against.
//   rows (non-demo, non-disabled): 7
//   titles: tv:283304, tv:1234, movie:999, movie:555, title:unmatched show = 5
function seed() {
  const env = makeEnv();
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'eric');
  addMember(env, 'christine');
  addMember(env, 'demo', { email: 'demo@example.com' });
  addMember(env, 'banned', { disabled: 1 });

  addShow(env, 'eric', 'Little House on the Prairie', {
    list: 'waiting', tmdb: 283304, year: 2026, network: 'Netflix', rating: '6.7', mine: 8,
    created: '2026-10-04 13:29:09', cast: ['Alice Halsey', 'Luke Bracey'],
  });
  addShow(env, 'christine', 'Little House on the Prairie (2026)', {
    list: 'waiting', tmdb: 283304, year: 2026, genres: 'Drama, Western, Family', seasons: 2,
    network: 'Netflix', rating: '6.7', mine: 6, created: '2026-10-04T08:00:00Z', cast: ['Alice Halsey'],
  });
  addShow(env, 'eric', 'Little House on the Prairie (1974)', {
    list: 'recommending', archived: true, tmdb: 1234, year: 1974, genres: 'Drama, Family', seasons: 9,
    network: 'Peacock', rating: '7.9',
  });
  addShow(env, 'christine', 'Frances Ha', {
    list: 'next', movie: true, tmdb: 999, year: 2012, genres: 'Comedy, Drama',
    notes: 'secret memo text', network: 'Max',
  });
  addShow(env, 'christine', '100% Wolf', { list: 'next', movie: true, tmdb: 555, year: 2020, genres: 'Animation' });
  addShow(env, 'christine', 'Unmatched Show', { list: 'watching' });
  addShow(env, 'patrick', 'unmatched show ', { list: 'watching' });
  addShow(env, 'demo', 'Demo Show', { tmdb: 4242, year: 2021, genres: 'Drama' });
  addShow(env, 'banned', 'Banned Show', { tmdb: 4343, year: 2022, genres: 'Drama' });
  return env;
}

const post = (env, body, cookie) => queryApi.onRequestPost({
  env,
  request: new Request(`${ORIGIN}/api/admin-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `session=${cookie}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
});

const delegated = (env, slug, body, adminScope) => queryApi.onRequestPost({
  env,
  request: actingAs(new Request(`${ORIGIN}/api/admin-query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { member_slug: slug, email: `${slug}@example.com`, expires_at: null }, { adminScope }),
});

async function q(env, cookie, body) {
  const res = await post(env, body, cookie);
  return { status: res.status, data: await res.json() };
}

const toolCtx = (env, slug, scopes) => ({
  env, origin: ORIGIN, scopes,
  session: { member_slug: slug, email: `${slug}@example.com`, expires_at: null },
  waitUntil: (p) => p,
});

// ---- who ----

console.log('\n== only an admin, or an admin connection with members:admin');
{
  const env = seed();
  const adminCookie = addSession(env, 'patrick');
  const memberCookie = addSession(env, 'eric');

  check('no session is 403', (await q(env, null, {})).status === 403);
  check('a logged-in non-admin is 403', (await q(env, memberCookie, {})).status === 403);
  check('an admin session is 200', (await q(env, adminCookie, {})).status === 200);

  const plain = await delegated(env, 'patrick', {}, false);
  check("an admin's connection without the admin flag is 403", plain.status === 403, `got ${plain.status}`);
  const scoped = await delegated(env, 'patrick', {}, true);
  check("an admin's connection with the admin flag is 200", scoped.status === 200, `got ${scoped.status}`);
  const nonAdmin = await delegated(env, 'eric', {}, true);
  check("a non-admin's connection is 403 even with the flag", nonAdmin.status === 403, `got ${nonAdmin.status}`);

  // The flag opens this endpoint and nothing else.
  const roster = await emailsApi.onRequestGet({
    env,
    request: actingAs(new Request(`${ORIGIN}/api/admin-member-emails`),
      { member_slug: 'patrick', email: 'patrick@example.com', expires_at: null }, { adminScope: true }),
  });
  check('the flag does not open any other admin endpoint', roster.status === 403, `admin-member-emails got ${roster.status}`);
}

console.log('\n== the MCP tool');
{
  const env = seed();
  check('a read/write grant is not shown admin_query',
    !toolsFor(['shows:read', 'shows:write']).some((t) => t.name === 'admin_query'));
  check('a members:admin grant is', toolsFor(['shows:read', 'members:admin']).some((t) => t.name === 'admin_query'));

  const tool = toolNamed('admin_query');
  const out = await tool.run(toolCtx(env, 'patrick', ['shows:read', 'members:admin']), { measures: ['titles'] });
  check('an admin with the scope gets an answer', out.totals && out.totals.titles === 5, JSON.stringify(out));

  let refused = null;
  try { await tool.run(toolCtx(env, 'patrick', ['shows:read']), { measures: ['titles'] }); } catch (e) { refused = e; }
  check('called without the scope, the endpoint refuses (no flag is set)', refused && /access/i.test(refused.message), String(refused && refused.message));

  env._db.prepare('UPDATE members SET is_admin = 0 WHERE slug = ?').run('patrick');
  refused = null;
  try { await tool.run(toolCtx(env, 'patrick', ['shows:read', 'members:admin']), {}); } catch (e) { refused = e; }
  check('a demoted admin is refused even if the token still lists the scope', !!refused);
  env._db.prepare('UPDATE members SET is_admin = 1, disabled = 1 WHERE slug = ?').run('patrick');
  refused = null;
  try { await tool.run(toolCtx(env, 'patrick', ['shows:read', 'members:admin']), {}); } catch (e) { refused = e; }
  check('so is a disabled one', !!refused);

  env._db.prepare('UPDATE members SET disabled = 0 WHERE slug = ?').run('patrick');
  refused = null;
  try { await tool.run(toolCtx(env, 'patrick', ['shows:read', 'members:admin']), { measures: ['avg:title'] }); } catch (e) { refused = e; }
  check('a bad spec comes back as a readable error', refused && /isn't numeric/.test(refused.message), String(refused && refused.message));
}

// ---- what ----

console.log('\n== a spec, never SQL');
{
  const env = seed();
  const c = addSession(env, 'patrick');

  const inj = await q(env, c, { measures: ['rows'], filters: [{ field: 'title', value: "x' OR 1=1 --" }] });
  check('a quote in a value is data', inj.status === 200 && inj.data.totals.rows === 0, JSON.stringify(inj.data));
  check('an unknown field is 400', (await q(env, c, { filters: [{ field: 's.notes', op: 'not_empty' }] })).status === 400);
  check('so is a table-shaped one', (await q(env, c, { filters: [{ field: 'sessions', op: 'not_empty' }] })).status === 400);
  check('an unknown op is 400', (await q(env, c, { filters: [{ field: 'title', op: 'raw', value: '1' }] })).status === 400);
  check('an unknown measure is 400', (await q(env, c, { measures: ['count(*)'] })).status === 400);
  check('a non-numeric measure is 400', (await q(env, c, { measures: ['avg:title'] })).status === 400);
  check('a non-groupable group_by is 400', (await q(env, c, { group_by: ['overview'] })).status === 400);
  check('a non-numeric value for a number is 400', (await q(env, c, { filters: [{ field: 'release_year', op: 'gte', value: '2020 OR 1' }] })).status === 400);
  check('a body that is not JSON is 400', (await post(env, 'not json', c)).status === 400);

  const pct = await q(env, c, { measures: ['rows'], filters: [{ field: 'title', op: 'contains', value: '%' }] });
  check('% in contains is a literal percent, not a wildcard', pct.data.totals.rows === 1, JSON.stringify(pct.data));
}

console.log('\n== private memos are countable, never readable');
{
  const env = seed();
  const c = addSession(env, 'patrick');
  const counted = await q(env, c, { measures: ['rows'], filters: [{ field: 'notes', op: 'not_empty' }] });
  check('shows with a note can be counted', counted.data.totals.rows === 1, JSON.stringify(counted.data));
  check('notes as a column is 400', (await q(env, c, { mode: 'rows', columns: ['title', 'notes'] })).status === 400);
  check('notes as a group is 400', (await q(env, c, { group_by: ['notes'] })).status === 400);
  check('notes can\'t be matched by content', (await q(env, c, { filters: [{ field: 'notes', op: 'contains', value: 'secret' }] })).status === 400);
  check('sort_by notes is 400', (await q(env, c, { mode: 'rows', sort_by: 'notes' })).status === 400);
  check('added_by (a login email) is not a field', (await q(env, c, { mode: 'rows', columns: ['added_by'] })).status === 400);

  const res = await post(env, { mode: 'rows', limit: 500 }, c);
  const text = await res.text();
  check('rows mode never carries the memo text', !text.includes('secret memo text'));
  check('or a login email', !text.includes('@example.com'));
}

// ---- the numbers ----

console.log('\n== counts');
{
  const env = seed();
  const c = addSession(env, 'patrick');

  const all = await q(env, c, {});
  check('defaults to rows and titles', all.data.totals.rows === 7 && all.data.totals.titles === 5, JSON.stringify(all.data.totals));
  const members = await q(env, c, { measures: ['members'] });
  check('members counts people with a matching show', members.data.totals.members === 3, JSON.stringify(members.data.totals));

  const demo = await q(env, c, { include_demo: true });
  check('include_demo adds the demo account back', demo.data.totals.rows === 8 && demo.data.totals.titles === 6, JSON.stringify(demo.data.totals));
  check('a disabled member never counts', demo.data.totals.rows === 8);

  const recent = await q(env, c, { measures: ['rows', 'titles'], filters: [{ field: 'release_year', op: 'gte', value: 2020 }] });
  check('2020 or later: two copies of the remake plus 100% Wolf are 3 rows, 2 titles',
    recent.data.totals.rows === 3 && recent.data.totals.titles === 2, JSON.stringify(recent.data.totals));

  const noGenre = await q(env, c, {
    filters: [{ field: 'type', value: 'tv' }, { field: 'genres', op: 'empty' }],
    group_by: ['member'], sort: 'key',
  });
  // Eric's Little House carries no genres of its own, but it is the same
  // entry as Christine's, and a show's facts are the show's (INVARIANTS §29):
  // only the two copies no entry backs are missing genres.
  check('TV missing genres, per member', JSON.stringify(noGenre.data.groups.map((g) => [g.member, g.rows]))
    === JSON.stringify([['christine', 1], ['patrick', 1]]), JSON.stringify(noGenre.data.groups));

  const awaiting = await q(env, c, { measures: ['rows'], filters: [{ field: 'list', value: 'awaiting' }] });
  check('list speaks the member vocabulary (awaiting = waiting)', awaiting.data.totals.rows === 2);
  const byList = await q(env, c, { measures: ['rows'], group_by: ['list'], sort: 'key' });
  check('and answers in it', byList.data.groups.map((g) => g.list).join(',') === 'awaiting,loved,next_up,watching', JSON.stringify(byList.data.groups));

  const archived = await q(env, c, { measures: ['rows'], filters: [{ field: 'archived', value: true }] });
  check('archived rows are in by default and filterable', archived.data.totals.rows === 1);

  const notNetflix = await q(env, c, { measures: ['rows'], filters: [{ field: 'network', op: 'ne', value: 'netflix' }] });
  check('ne keeps rows with no value, and ignores case', notNetflix.data.totals.rows === 5, JSON.stringify(notNetflix.data.totals));
}

console.log('\n== breakdowns over several values per show');
{
  const env = seed();
  const c = addSession(env, 'patrick');
  const byGenre = await q(env, c, { measures: ['rows', 'titles'], group_by: ['genre'], sort: 'key', limit: 50 });
  const g = Object.fromEntries(byGenre.data.groups.map((x) => [x.genre, x.rows]));
  // Both copies of the 2026 entry read its genres (Eric's included).
  check('a show counts once in each of its genres', g.Drama === 4 && g.Family === 3 && g.Western === 2 && g.Comedy === 1, JSON.stringify(g));
  check('a show with no genres groups under null', g.null === 2, JSON.stringify(g));
  check('but totals count every show once', byGenre.data.totals.rows === 7, JSON.stringify(byGenre.data.totals));

  const drama = await q(env, c, { measures: ['rows'], filters: [{ field: 'genre', value: 'drama' }] });
  check('genre eq matches a whole entry, any case', drama.data.totals.rows === 4);
  const partial = await q(env, c, { measures: ['rows'], filters: [{ field: 'genre', value: 'dram' }] });
  check('and not part of one', partial.data.totals.rows === 0);

  const actor = await q(env, c, { measures: ['rows', 'titles'], filters: [{ field: 'actor', value: 'Alice Halsey' }] });
  check('actor filter finds both copies of one title', actor.data.totals.rows === 2 && actor.data.totals.titles === 1, JSON.stringify(actor.data.totals));
  const byActor = await q(env, c, { measures: ['titles'], group_by: ['actor'], filters: [{ field: 'actor', op: 'not_empty' }] });
  check('group by actor', byActor.data.groups[0].actor === 'Alice Halsey' && byActor.data.groups[0].titles === 1, JSON.stringify(byActor.data.groups));

  check('two multi-valued group_bys at once are 400', (await q(env, c, { group_by: ['genre', 'actor'] })).status === 400);
}

console.log('\n== measures, dates, paging');
{
  const env = seed();
  const c = addSession(env, 'patrick');

  const avg = await q(env, c, { measures: ['avg:member_rating', 'max:release_year', 'avg:club_rating'] });
  check("avg:member_rating reads each owner's own rating", avg.data.totals['avg:member_rating'] === 7, JSON.stringify(avg.data.totals));
  check('max:release_year', avg.data.totals['max:release_year'] === 2026);
  check('club_rating is numeric', Math.abs(avg.data.totals['avg:club_rating'] - 7.1) < 0.01, JSON.stringify(avg.data.totals));

  // One stored as datetime('now') writes it, one as ISO. A string comparison
  // would drop the first: "2026-10-04 13:29:09" sorts before "2026-10-04T10…".
  const window = await q(env, c, {
    measures: ['rows'],
    filters: [{ field: 'added_at', op: 'between', value: ['2026-10-04T10:00:00Z', '2026-10-05'] }],
  });
  check('a date filter reads both stored timestamp shapes', window.data.totals.rows === 1, JSON.stringify(window.data.totals));
  const since = await q(env, c, { measures: ['rows'], filters: [{ field: 'added_at', op: 'gte', value: '2026-10' }] });
  check('a bare month means its first day', since.data.totals.rows === 2, JSON.stringify(since.data.totals));

  const page1 = await q(env, c, { mode: 'rows', columns: ['show_id', 'title'], sort_by: 'title', limit: 3 });
  const page2 = await q(env, c, { mode: 'rows', columns: ['show_id', 'title'], sort_by: 'title', limit: 3, offset: 3 });
  check('rows mode reports the full total', page1.data.total === 7 && page1.data.returned === 3, JSON.stringify(page1.data));
  check('and pages without overlap', !page2.data.rows.some((r) => page1.data.rows.some((p) => p.show_id === r.show_id)));
  const capped = await q(env, c, { mode: 'rows', limit: 99999 });
  check('limit is capped at 500', capped.data.query.limit === 500);
  const grouped = await q(env, c, { group_by: ['title'], limit: 2 });
  // Five titles, not seven: Christine's "(2026)" copy reads TMDB's name, the
  // same as Eric's, and the two "unmatched show" copies are one entry now
  // (every copy is a TMDB entry; names are the entry's).
  check('a truncated breakdown says so', grouped.data.truncated === true && grouped.data.total_groups === 5, JSON.stringify(grouped.data));
  check('the spec is echoed back as read', grouped.data.query.group_by[0] === 'title' && grouped.data.query.measures.length === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

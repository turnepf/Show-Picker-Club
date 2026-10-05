// Tests for `?q=` on /api/shows/all — server-side cross-library search.
//
//   node scripts/shows-all-search-test.mjs
//
// The parameter exists for Roku, which runs on hardware going back about
// eight years. That channel used to fetch this endpoint in full, parse it and
// hold it in memory to filter locally; on a 512MB 2017 box that is the heaviest
// thing it did and the first thing that would fall over as the club grows.
// Filtering here means the device receives matches instead of everything.
//
// The properties worth pinning are the ones that make it safe to add a filter
// to an endpoint that already had a privacy rule:
//
//   1. It is additive. With no `q`, the response is byte-for-byte the shape it
//      has always been — the web and Apple clients filter locally and must not
//      notice this parameter exists.
//   2. Group scoping survives the filter. A filter is a WHERE clause bolted
//      onto a query whose other WHERE clause is the privacy boundary, and the
//      failure mode is a filter that widens what it was meant to narrow. A
//      stranger's matching show stays invisible.
//   3. The query text is text, not a pattern. LIKE reads % and _ as wildcards,
//      so a bare "%" would return the whole library — exactly the request the
//      parameter exists to prevent — and "Mr_Robot" would match "Mr.Robot".
//   4. A filtered response is bounded. An unbounded `q` is the old problem
//      with extra steps.
//   5. Blank reads as "no filter", not "match nothing". An empty search box
//      should not look like an empty library.
//
// Same harness as scripts/watching-with-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json so Node loads the .js
// files as the ES modules they are, and schema.sql is loaded into node:sqlite
// behind a thin D1 shim, so the SQL under test is really executed.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'shows-all-search-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const allApi = await import(join(sandbox, 'functions', 'api/shows/all.js'));

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

function addMember(env, slug, name) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial) VALUES (?, ?, ?, ?, ?)'
  ).run(slug, name, first, last || null, last ? last.charAt(0) : null);
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

function addShow(env, { slug, title, list = 'watching', network = null, genres = null, archived = 0, cast = [] }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, network, genres, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, network, genres, archived, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
  cast.forEach((name, i) => {
    env._db.prepare('INSERT INTO actors (show_id, name, ord) VALUES (?, ?, ?)').run(id, name, i);
  });
  // Facts seeded on the copy reach the shared row members read from.
  liftCopiesIntoTitles(env._db, { pinUnmatched: true });
  return id;
}

function req(path, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { method: 'GET', headers });
}

const ctx = (env, request) => ({ env, request, waitUntil: () => {} });

async function getAll(env, cookie, query = '') {
  const res = await allApi.onRequestGet(ctx(env, req(`/api/shows/all${query}`, { cookie })));
  return { status: res.status, body: await res.json() };
}

const titles = (body) => (body.shows || []).map((s) => s.title).sort();

// ---- world ----
// Patrick and Quinn share a group. Stacy is a club member in no group with
// either — the stranger that open signup makes possible.
function world() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'quinn', 'Rosa Quinn');
  addMember(env, 'stacy', 'Stacy Nelson');
  addGroup(env, 'Household', ['patrick', 'quinn']);

  addShow(env, { slug: 'patrick', title: 'Severance', network: 'Apple TV+', genres: 'Drama, Thriller',
                 cast: ['Adam Scott', 'Britt Lower'] });
  addShow(env, { slug: 'patrick', title: 'The Bear', network: 'Hulu', genres: 'Comedy, Drama',
                 cast: ['Jeremy Allen White'] });
  addShow(env, { slug: 'quinn', title: 'Slow Horses', network: 'Apple TV+', genres: 'Drama',
                 cast: ['Gary Oldman'] });
  addShow(env, { slug: 'patrick', title: 'Archived Show', network: 'Netflix', archived: 1 });
  // Stacy shares no group with Patrick. Her copies must never surface.
  addShow(env, { slug: 'stacy', title: 'Severance', network: 'Apple TV+', genres: 'Drama',
                 cast: ['Adam Scott'] });
  addShow(env, { slug: 'stacy', title: 'Stacy Only Show', network: 'Hulu' });

  return { env, patrick: addSession(env, 'patrick') };
}

console.log('\n/api/shows/all — server-side search (?q=)\n');

// ---- 1. the gate is unchanged ----
{
  const { env } = world();
  const { status } = await getAll(env, null, '?q=severance');
  check('no session is still 401, with or without q', status === 401);
}

// ---- 2. additive: no q behaves exactly as before ----
{
  const { env, patrick } = world();
  const { body } = await getAll(env, patrick);
  check('no q returns the whole group-scoped library',
    JSON.stringify(titles(body)) === JSON.stringify(['Severance', 'Slow Horses', 'The Bear']),
    JSON.stringify(titles(body)));
  check('no q still excludes archived rows', !titles(body).includes('Archived Show'));
  check('no q still excludes a non-group member',
    !(body.shows || []).some((s) => s.member_slug === 'stacy'));
  check('no q still resolves member display names',
    (body.shows || []).every((s) => typeof s.member_name === 'string' && s.member_name.length > 0));
}

// ---- 3. the filter itself ----
{
  const { env, patrick } = world();

  const byTitle = await getAll(env, patrick, '?q=bear');
  check('q matches a title, case-insensitively',
    JSON.stringify(titles(byTitle.body)) === JSON.stringify(['The Bear']), JSON.stringify(titles(byTitle.body)));

  const upper = await getAll(env, patrick, '?q=BEAR');
  check('q is case-insensitive in the other direction',
    JSON.stringify(titles(upper.body)) === JSON.stringify(['The Bear']));

  const byNetwork = await getAll(env, patrick, '?q=apple');
  check('q matches a network',
    JSON.stringify(titles(byNetwork.body)) === JSON.stringify(['Severance', 'Slow Horses']),
    JSON.stringify(titles(byNetwork.body)));

  const byGenre = await getAll(env, patrick, '?q=comedy');
  check('q matches a genre',
    JSON.stringify(titles(byGenre.body)) === JSON.stringify(['The Bear']), JSON.stringify(titles(byGenre.body)));

  const byActor = await getAll(env, patrick, '?q=oldman');
  check('q matches a cast member',
    JSON.stringify(titles(byActor.body)) === JSON.stringify(['Slow Horses']), JSON.stringify(titles(byActor.body)));

  const none = await getAll(env, patrick, '?q=nothingmatchesthis');
  check('a query that matches nothing returns an empty list, not an error',
    none.status === 200 && titles(none.body).length === 0);

  const archived = await getAll(env, patrick, '?q=archived');
  check('the filter does not resurrect archived rows', titles(archived.body).length === 0);
}

// ---- 4. group scoping survives the filter (the one that matters) ----
{
  const { env, patrick } = world();
  const { body } = await getAll(env, patrick, '?q=severance');
  const slugs = (body.shows || []).map((s) => s.member_slug);
  check('a filtered search returns my group-mate\'s copy', slugs.includes('patrick'));
  check('a filtered search never returns a non-group member\'s copy',
    !slugs.includes('stacy'), JSON.stringify(slugs));

  const direct = await getAll(env, patrick, '?q=stacy only');
  check('a title only a stranger owns is invisible even when named exactly',
    titles(direct.body).length === 0, JSON.stringify(titles(direct.body)));
}

// ---- 5. the query is text, not a pattern ----
{
  const { env, patrick } = world();

  const pct = await getAll(env, patrick, '?q=%25');            // a literal "%"
  check('a bare % matches literally and returns nothing, not everything',
    titles(pct.body).length === 0, JSON.stringify(titles(pct.body)));

  const underscore = await getAll(env, patrick, '?q=the_bear'); // "_" is not "any char"
  check('_ is a literal underscore, not a single-character wildcard',
    titles(underscore.body).length === 0, JSON.stringify(titles(underscore.body)));

  // And the escaping does not break ordinary text that happens to contain them.
  addShow(env, { slug: 'patrick', title: 'Saving 50% Today', network: 'Hulu' });
  const literal = await getAll(env, patrick, '?q=50%25');
  check('a real % in a title is still findable by typing it',
    JSON.stringify(titles(literal.body)) === JSON.stringify(['Saving 50% Today']),
    JSON.stringify(titles(literal.body)));
}

// ---- 6. blank reads as "no filter" ----
{
  const { env, patrick } = world();
  const blank = await getAll(env, patrick, '?q=');
  const spaces = await getAll(env, patrick, '?q=%20%20');
  check('an empty q returns the full library rather than nothing',
    JSON.stringify(titles(blank.body)) === JSON.stringify(['Severance', 'Slow Horses', 'The Bear']));
  check('a whitespace-only q reads the same as no q',
    JSON.stringify(titles(spaces.body)) === JSON.stringify(titles(blank.body)));
}

// ---- 7. a filtered response is bounded ----
{
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  const cookie = addSession(env, 'patrick');
  for (let i = 0; i < 260; i++) {
    addShow(env, { slug: 'patrick', title: `Test Show ${String(i).padStart(3, '0')}`, network: 'Hulu' });
  }

  const dflt = await getAll(env, cookie, '?q=test');
  check('a filtered response caps at the default of 100', (dflt.body.shows || []).length === 100,
    String((dflt.body.shows || []).length));

  const asked = await getAll(env, cookie, '?q=test&limit=25');
  check('limit narrows below the default', (asked.body.shows || []).length === 25);

  const over = await getAll(env, cookie, '?q=test&limit=5000');
  check('limit cannot be raised past the 200 ceiling', (over.body.shows || []).length === 200,
    String((over.body.shows || []).length));

  const junk = await getAll(env, cookie, '?q=test&limit=banana');
  check('a junk limit falls back to the default rather than erroring',
    junk.status === 200 && (junk.body.shows || []).length === 100);

  const unfiltered = await getAll(env, cookie, '');
  check('no q is still unbounded — the limit belongs to the filter, not the endpoint',
    (unfiltered.body.shows || []).length === 260, String((unfiltered.body.shows || []).length));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

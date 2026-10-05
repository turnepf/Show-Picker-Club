// Tests for "is this the same show?" — _shared/same-show.js and the paths
// that used to answer it by title alone.
//
//   node scripts/same-show-test.mjs
//
// A TMDB entry is a show's identity. Three 2026 films are called "The
// Odyssey", and a member who owns one of them used to be unable to add the
// other two (the duplicate check matched by title), saw group-mates' copies
// of the wrong film under "Also watching", found a different film's
// recommendation folded into the card already on the board, and saw all
// three merged into one Trending card wearing whichever poster came first.
//
// The rule pinned here: two rows are the same show when both are pinned to
// the same entry; a title decides only when one side was never pinned. And a
// write fanning out from an unpinned row (a guess made from its title) stops
// at copies that are pinned, since those already know which show they are.
//
// Same harness as scripts/watching-with-test.mjs: functions/ copied to a temp
// directory as ES modules, schema.sql in node:sqlite behind a D1 shim. No
// network: TMDB is a stand-in (scripts/lib/fake-tmdb.mjs) that knows every
// title except the ones a case marks unknown or takes down.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { fakeTmdb } from './lib/fake-tmdb.mjs';

const tmdb = fakeTmdb({ unknown: ['Not A Real Show Anywhere'] });
globalThis.fetch = async (url) => tmdb.respond(url)
  ?? new Response('{}', { headers: { 'Content-Type': 'application/json' } });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'same-show-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const { sameShow, showKey, sameShowWhere, sameShowJoin, showKeySql } = await load('_shared/same-show.js');
const showsApi = await load('api/shows.js');
const showApi = await load('api/shows/[id].js');
const checkApi = await load('api/shows/check.js');
const groupTrendingApi = await load('api/groups/[id]/trending.js');
const { copyForMember } = await load('_shared/watchers.js');
const { createSuggestion, suggestionForViewer } = await load('_shared/group-suggestions.js');
const vibeApi = await load('api/vibe.js');
const urlCleanupApi = await load('api/admin-url-cleanup.js');
const vibeFillApi = await load('api/admin-vibe-fill.js');
const { TRAIT_NAMES } = await load('_shared/vibe-traits.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addMember(env, slug) {
  env._db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run(slug, slug, slug);
  env._db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run(`${slug}@example.com`, slug);
  const id = `session-${slug}`;
  env._db.prepare('INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addGroup(env, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run('Friends', slugs[0]);
  const { id } = env._db.prepare('SELECT MAX(id) AS id FROM groups').get();
  for (const s of slugs) env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  return Number(id);
}

// A, B and C: three different films that share one title.
const A = 1368337, B = 1698863, C = 1756234;

function addShow(env, { slug, title = 'The Odyssey', tmdbId = null, movie = 1, list = 'watching', archived = 0, poster = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, movie, tmdb_id, tmdb_type, poster_url, added_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(title, list, slug, archived, movie, tmdbId, tmdbId ? (movie ? 'movie' : 'tv') : null, poster, `${slug}@example.com`);
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

function req(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });

// ---- the rule, in JS ----

console.log('sameShow / showKey');
{
  const a = { title: 'The Odyssey', tmdb_id: A, tmdb_type: 'movie' };
  const b = { title: 'The Odyssey', tmdb_id: B, tmdb_type: 'movie' };
  const bare = { title: 'the odyssey' };
  check('two entries sharing a title are different shows', !sameShow(a, b));
  check('the same entry is the same show whatever its title says', sameShow(a, { title: 'Odyssey', tmdb_id: String(A), movie: 1 }));
  check('an unpinned side falls back to the title', sameShow(a, bare) && sameShow(bare, b));
  check('a series and a film with one id are different shows', !sameShow(a, { title: 'x', tmdb_id: A, tmdb_type: 'tv' }));
  check('keys separate entries and fold an unpinned title', showKey(a) !== showKey(b) && showKey(bare) === 'title:the odyssey');
}

// ---- the rule, in SQL ----

console.log('sameShowWhere / sameShowJoin / showKeySql');
{
  // On a table that carries a title (shows_v, a recommendation card), an
  // unpinned row falls back to its title. A bare table shaped like those.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, title TEXT, tmdb_id INTEGER, tmdb_type TEXT, movie INTEGER)');
  const put = (tmdbId) => Number(db.prepare("INSERT INTO c (title, tmdb_id, tmdb_type, movie) VALUES ('The Odyssey', ?, ?, 1)")
    .run(tmdbId, tmdbId ? 'movie' : null).lastInsertRowid);
  const a = put(A), b = put(B), u = put(null);
  const ids = (w) => db.prepare(`SELECT id FROM c s WHERE ${w.sql} ORDER BY id`).all(...w.binds).map((r) => Number(r.id));

  check('a pinned show matches its own entry and unpinned copies of its title',
    JSON.stringify(ids(sameShowWhere('s', { title: 'The Odyssey', tmdb_id: A, tmdb_type: 'movie' }))) === JSON.stringify([a, u]));
  check('an unpinned show matches every copy of its title',
    ids(sameShowWhere('s', { title: 'THE ODYSSEY' })).length === 3);
  check('forWrite: an unpinned show reaches only unpinned copies',
    JSON.stringify(ids(sameShowWhere('s', { title: 'The Odyssey' }, { forWrite: true }))) === JSON.stringify([u]));
  check('the wrong type never matches an entry',
    !ids(sameShowWhere('s', { title: 'The Odyssey', tmdb_id: A, tmdb_type: 'tv' })).includes(a));
  const pairs = db.prepare(
    `SELECT x.id AS x, y.id AS y FROM c x JOIN c y ON y.id > x.id AND ${sameShowJoin('x', 'y')} ORDER BY x.id, y.id`
  ).all().map((r) => `${r.x}-${r.y}`);
  check('join: A~unpinned and B~unpinned, never A~B', JSON.stringify(pairs) === JSON.stringify([`${a}-${u}`, `${b}-${u}`]));
  check('three grouping keys for A, B and the unpinned copy',
    Number(db.prepare(`SELECT COUNT(DISTINCT ${showKeySql('s')}) AS n FROM c s`).get().n) === 3);

  // The raw `shows` table has no title of its own (every copy is a TMDB
  // entry), so there the helpers match by entry alone and never name a title.
  const raw = (w) => w.sql.includes('title');
  check('hasTitle: false matches by entry alone',
    !raw(sameShowWhere('s', { title: 'The Odyssey', tmdb_id: A, tmdb_type: 'movie' }, { hasTitle: false }))
    && !sameShowJoin('x', 'y', { hasTitle: false }).includes('title')
    && !showKeySql('s', { hasTitle: false }).includes('title'));
  check('and a show with no entry matches nothing there', sameShowWhere('s', { title: 'The Odyssey' }, { hasTitle: false }).sql === '0');
}

// ---- adding a show ----

console.log('POST /api/shows and /api/shows/check');
{
  const env = makeEnv();
  const pat = addMember(env, 'pat');
  addShow(env, { slug: 'pat', tmdbId: A });
  const post = (body) => showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: pat, method: 'POST', body })));

  const chk = async (q) => (await checkApi.onRequestGet(ctx(env, req(`/api/shows/check?member=pat&title=The%20Odyssey${q}`, { cookie: pat })))).json();
  check('check: a different entry is not on your list', (await chk(`&tmdb_id=${C}&tmdb_type=movie`)).exists === false);
  check('check: your own entry is', (await chk(`&tmdb_id=${A}&tmdb_type=movie`)).exists === true);
  check('check: no id answers by title, as before', (await chk('')).exists === true);

  const rb = await post({ title: 'The Odyssey', list: 'next', movie: 1, tmdb_id: B, tmdb_type: 'movie' });
  check('owning one Odyssey doesn\'t block adding another', rb.status === 201 || rb.status === 200, `status ${rb.status}`);
  const ra = await post({ title: 'The Odyssey', list: 'next', movie: 1, tmdb_id: A, tmdb_type: 'movie' });
  check('adding the entry you already own is still a duplicate', ra.status === 409);
  const rbare = await post({ title: 'the odyssey', list: 'next', movie: 1 });
  check('a bare title (no pick) still dupes by title', rbare.status === 409);

}

// ---- cross-member: your copy, the board, also watching, trending ----

console.log('copyForMember, recommendations, also watching, group trending');
{
  const env = makeEnv();
  const pat = addMember(env, 'pat');
  addMember(env, 'amy');
  addMember(env, 'jo');
  const gid = addGroup(env, ['pat', 'amy', 'jo']);
  const patA = addShow(env, { slug: 'pat', tmdbId: A, poster: 'https://image.tmdb.org/t/p/w500/a.jpg' });
  const amyA = addShow(env, { slug: 'amy', tmdbId: A });
  const joB = addShow(env, { slug: 'jo', tmdbId: B, list: 'watching' });
  const patB = addShow(env, { slug: 'pat', tmdbId: B, list: 'next' });
  liftCopiesIntoTitles(env._db);

  const joRow = env._db.prepare('SELECT * FROM shows WHERE id = ?').get(joB);
  const mine = await copyForMember(env, 'amy', { ...joRow });
  check('amy\'s copy of A is not her copy of B', mine === null, mine ? `got ${mine.id}` : '');
  const mineA = await copyForMember(env, 'amy', { title: 'The Odyssey', tmdb_id: A, tmdb_type: 'movie' });
  check('amy\'s copy of A is her copy of A', mineA && Number(mineA.id) === amyA);

  const patRowA = env._db.prepare('SELECT * FROM shows WHERE id = ?').get(patA);
  const first = await createSuggestion(env, { groupId: gid, memberSlug: 'pat', show: { ...patRowA } });
  const second = await createSuggestion(env, { groupId: gid, memberSlug: 'jo', show: { ...joRow } });
  check('recommending A makes a card', first.status === 201);
  check('recommending B gets its own card, not folded into A\'s', second.status === 201 && second.suggestion.id !== first.suggestion.id);
  const amyB = await suggestionForViewer(env, gid, second.suggestion.id, 'amy');
  const amyA2 = await suggestionForViewer(env, gid, first.suggestion.id, 'amy');
  check('the board knows amy has A but not B', amyB.on_your_list === null && amyA2.on_your_list === 'watching',
    `${amyB.on_your_list} / ${amyA2.on_your_list}`);

  const detail = async (id) => (await showApi.onRequestGet(ctx(env, req(`/api/shows/${id}`, { cookie: pat }), { id: String(id) }))).json();
  const onB = (await detail(patB)).group_watchers || [];
  check('also watching on B names jo, not amy (who watches A)',
    onB.map((m) => m.slug).join() === 'jo', JSON.stringify(onB));
  const onA = (await detail(patA)).group_watchers || [];
  check('also watching on A names amy, not jo', onA.map((m) => m.slug).join() === 'amy', JSON.stringify(onA));

  const tr = await (await groupTrendingApi.onRequestGet(ctx(env, req(`/api/groups/${gid}/trending`, { cookie: pat }), { id: String(gid) }))).json();
  const cards = (tr.shows || []).filter((s) => s.title === 'The Odyssey');
  check('trending keeps A and B as two cards', cards.length === 2, JSON.stringify(cards.map((c) => c.member_count)));
  const cardB = cards.find((c) => Number(c.tmdb_id) === B);
  check('B\'s card doesn\'t borrow A\'s poster', cardB && !cardB.poster_url, cardB ? cardB.poster_url : 'no B card');
}

// ---- vibe: a fingerprint per show ----

console.log('vibe fingerprints by show (title_traits)');
{
  const env = makeEnv();
  env.CRON_SECRET = 'cron';
  const pat = addMember(env, 'pat');
  addMember(env, 'amy');
  const gid = addGroup(env, ['pat', 'amy']);
  addShow(env, { slug: 'pat', tmdbId: A });
  addShow(env, { slug: 'amy', tmdbId: B });
  addShow(env, { slug: 'amy', tmdbId: C });
  liftCopiesIntoTitles(env._db);
  const traits = (key, v) => {
    const cols = ['show_key', 'title', ...TRAIT_NAMES, 'scored_at'];
    env._db.prepare(`INSERT INTO title_traits (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(key, 'The Odyssey', ...TRAIT_NAMES.map(() => v), '2026-10-04 00:00:00');
  };
  traits(`movie:${A}`, 0.9);
  traits(`movie:${B}`, 0.1);

  const fill = await (await vibeFillApi.onRequestGet(ctx(env, new Request(ORIGIN + '/api/admin-vibe-fill', { headers: { 'X-Cron-Secret': 'cron' } })))).json();
  check('the fill queue holds C, unscored though A and B share its title', fill.fill_remaining === 1, JSON.stringify(fill));

  const v = await (await vibeApi.onRequestGet(ctx(env, req('/api/vibe?member=pat', { cookie: pat })))).json();
  const m = v.member || {};
  check('pat\'s fingerprint reads A\'s scores only', m.scored_count === 1 && m.display_traits && m.display_traits.Empathy === 90,
    JSON.stringify(m.display_traits));
  const picks = m.aligned_picks || [];
  check('an aligned pick names its TMDB entry, so adding it adds that film',
    picks.length === 1 && picks[0].tmdb_id === B && picks[0].tmdb_type === 'movie', JSON.stringify(picks));
  check('owning A doesn\'t hide B from pat\'s picks', picks.some((p) => p.show_key === `movie:${B}`));
  void gid;
}

// ---- the URL-cleanup queue: one row per show, and a save stays on it ----

console.log('URL cleanup by show');
{
  const env = makeEnv();
  const pat = addMember(env, 'pat');
  addMember(env, 'amy');
  env._db.prepare("UPDATE members SET is_admin = 1 WHERE slug = 'pat'").run();
  const a = addShow(env, { slug: 'pat', tmdbId: A });
  const b = addShow(env, { slug: 'amy', tmdbId: B });
  env._db.prepare("UPDATE shows SET network = 'Peacock', network_url = NULL").run();
  const cleanup = async (body) => (await urlCleanupApi.onRequestPost(ctx(env,
    req('/api/admin-url-cleanup', { cookie: pat, method: 'POST', body })))).json();

  const list = await cleanup({ action: 'list' });
  const odysseys = (list.shows || []).filter((r) => r.title === 'The Odyssey');
  check('two films sharing a title are two rows to fix', odysseys.length === 2, JSON.stringify(list.shows));

  const saved = await cleanup({ action: 'save', id: a, network: 'Peacock', network_url: 'https://www.peacocktv.com/watch/asset/movies/the-odyssey/a' });
  const urlOf = (id) => env._db.prepare('SELECT network_url FROM shows WHERE id = ?').get(id).network_url;
  check('saving A\'s link reaches A\'s copies only', saved.updated === 1 && urlOf(a) && !urlOf(b), JSON.stringify(saved));
}

// ---- adding inherits a link only from the same show ----

console.log('link inheritance on add');
{
  const env = makeEnv();
  addMember(env, 'amy');
  const pat = addMember(env, 'pat');
  const a = addShow(env, { slug: 'amy', tmdbId: A });
  env._db.prepare("UPDATE shows SET network = 'Peacock', network_url = 'https://www.peacocktv.com/watch/asset/movies/a' WHERE id = ?").run(a);
  const res = await showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: pat, method: 'POST',
    body: { title: 'The Odyssey', list: 'next', movie: 1, tmdb_id: B, tmdb_type: 'movie' } })));
  const added = env._db.prepare("SELECT network_url FROM shows WHERE member_slug = 'pat'").get();
  check('a new copy of B doesn\'t inherit A\'s watch link', (res.status === 201 || res.status === 200) && !(added?.network_url || '').includes('/movies/a'),
    JSON.stringify(added));
}


// ---- every show is a TMDB entry: nothing is added without one ----

console.log('a show TMDB can\'t identify is never added');
{
  const env = makeEnv();
  const pat = addMember(env, 'pat');
  const count = () => env._db.prepare("SELECT COUNT(*) AS n FROM shows WHERE member_slug = 'pat'").get().n;
  const post = async (body) => showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: pat, method: 'POST', body })));

  const none = await post({ title: 'Not A Real Show Anywhere', list: 'next' });
  const noneBody = await none.json();
  check('no match is a 422 that names the title', none.status === 422 && noneBody.error === 'no_match'
    && noneBody.message.includes('Not A Real Show Anywhere'), JSON.stringify(noneBody));
  check('and adds nothing', count() === 0);

  tmdb.down = true;
  const down = await post({ title: 'Severance', list: 'watching' });
  const downBody = await down.json();
  tmdb.down = false;
  check('TMDB unreachable is a 503 that says to try again later', down.status === 503 && downBody.error === 'tmdb_unavailable'
    && /try again/i.test(downBody.message), JSON.stringify(downBody));
  check('and adds nothing', count() === 0);

  const ok = await post({ title: 'Severance', list: 'watching' });
  const row = env._db.prepare("SELECT id, tmdb_id FROM shows WHERE member_slug = 'pat'").get();
  check('a title TMDB knows is added, pinned to its entry', (ok.status === 201 || ok.status === 200) && row && row.tmdb_id);

  // Editing what the show is (a new title) has to land on an entry too.
  const put = (body) => showApi.onRequestPut(ctx(env, req(`/api/shows/${row.id}`, { cookie: pat, method: 'PUT', body }), { id: String(row.id) }));
  const renamed = await put({ title: 'Not A Real Show Anywhere', list: 'watching' });
  check('renaming to a title TMDB doesn\'t know is refused', renamed.status === 422);
  const after = env._db.prepare('SELECT tmdb_id FROM shows WHERE id = ?').get(row.id);
  check('and leaves the show as it was', after.tmdb_id === row.tmdb_id);

  // An edit that keeps the show saves even while TMDB is down.
  tmdb.down = true;
  const noted = await put({ title: 'Severance', list: 'watching', notes: 'season 2!' });
  tmdb.down = false;
  const notes = env._db.prepare('SELECT notes FROM shows WHERE id = ?').get(row.id).notes;
  check('a notes edit saves while TMDB is down', noted.status === 200 && notes === 'season 2!', `status ${noted.status}, notes ${notes}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

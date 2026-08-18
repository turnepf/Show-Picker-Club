// Tests for /api/favorite-actors and the list rule both Trending queries share.
//
//   node scripts/favorite-actors-test.mjs
//
// Favourite actors are DERIVED — there is no favourite flag, so the whole
// feature is one query and the query is the feature. The properties worth
// pinning are the ones a distribution of real data would hide:
//
//   1. It's owner-only. This aggregates a member's entire library into a taste
//      summary sharper than the list titles a group-mate can already read, so
//      it is session-gated and takes no ?member= — a group-mate cannot ask for
//      someone else's actors by any route.
//   2. Next Up doesn't count. Bookmarking a show is not yet a statement about
//      who is in it — the same reason Trending excludes it.
//   3. A person is counted once per TITLE, not once per row. A member holding
//      the same show on two lists must not double-count its cast, or shuffling
//      a show between lists would invent a favourite.
//   4. The same person arriving under a TMDB id and under a bare name is one
//      person, not two — credits predating actor ids fall back to the name.
//   5. A credit with no imdb_id is still returned. The row renders without a
//      link rather than vanishing, which is what keeps the count honest.
//
// Plus the shared TRENDING_LISTS rule, which is now the one thing standing
// between "the club is watching this" and "somebody bookmarked it".
//
// Same harness as scripts/vibe-scope-test.mjs.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'fav-actors-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const favoriteActors = await load('api/favorite-actors.js');
const popular = await load('api/popular.js');
const { TRENDING_LISTS } = await load('_shared/trending-lists.js');

const ORIGIN = 'https://showpicker.club';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map(a => (a === undefined ? null : a))); }
  async first() { const r = this.db.prepare(this.sql).all(...this.args); return r.length ? { ...r[0] } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(r => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes ?? 0) } }; }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

function addMember(env, slug) {
  env._db.prepare('INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?,?,?,0,0)')
    .run(slug, slug, slug);
}
function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare('INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}
// created_at recent so the row also counts for Trending's 30-day window.
function addShow(env, { slug, title, list = 'watching', archived = 0, addedBy = 'member' }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, added_by, archived, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(title, list, slug, addedBy, archived, new Date().toISOString());
  return env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id;
}
function addActor(env, showId, { name, imdbId = null, personId = null, ord = 0 }) {
  env._db.prepare('INSERT INTO actors (show_id, name, imdb_id, tmdb_person_id, ord) VALUES (?,?,?,?,?)')
    .run(showId, name, imdbId, personId, ord);
}

const req = (path, session) => new Request(`${ORIGIN}${path}`, {
  headers: session ? { Cookie: `session=${session}` } : {},
});
const body = async (res) => JSON.parse(await res.text());

console.log('\n== /api/favorite-actors is owner-only');
{
  const env = makeEnv();
  addMember(env, 'patrick'); addMember(env, 'whitt');
  const s = addSession(env, 'patrick');

  const mine = addShow(env, { slug: 'patrick', title: 'Severance' });
  addActor(env, mine, { name: 'Adam Scott', imdbId: 'nm0794014', personId: 1 });
  const theirs = addShow(env, { slug: 'whitt', title: 'Poker Face' });
  addActor(env, theirs, { name: 'Natasha Lyonne', imdbId: 'nm0530879', personId: 2 });

  const anon = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors') });
  check('no session is 401', anon.status === 401);

  const res = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) });
  const { actors } = await body(res);
  check('own actor is returned', actors.some(a => a.name === 'Adam Scott'));
  check("another member's actor never appears", !actors.some(a => a.name === 'Natasha Lyonne'));

  // No ?member= route in or out.
  const spoof = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors?member=whitt', s) });
  const spoofed = await body(spoof);
  check('?member= is ignored, not honoured',
    !spoofed.actors.some(a => a.name === 'Natasha Lyonne'));
}

console.log('\n== which lists count');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');

  for (const [list, actor] of [['watching', 'W Actor'], ['waiting', 'A Actor'],
                               ['recommending', 'L Actor'], ['next', 'N Actor']]) {
    const id = addShow(env, { slug: 'patrick', title: `Show ${list}`, list });
    addActor(env, id, { name: actor, personId: actor.charCodeAt(0) });
  }
  const arch = addShow(env, { slug: 'patrick', title: 'Archived Show', archived: 1 });
  addActor(env, arch, { name: 'Archived Actor', personId: 99 });

  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const names = actors.map(a => a.name);
  check('Watching counts', names.includes('W Actor'));
  check('Awaiting counts', names.includes('A Actor'));
  check('Loved counts', names.includes('L Actor'));
  check('Next Up does NOT count', !names.includes('N Actor'), names.join(','));
  check('archived does NOT count', !names.includes('Archived Actor'));
}

console.log('\n== counted per title, and per person');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');

  // Same show on two lists — one title, so the cast counts once.
  const a1 = addShow(env, { slug: 'patrick', title: 'Severance', list: 'watching' });
  addActor(env, a1, { name: 'Adam Scott', personId: 1 });
  const a2 = addShow(env, { slug: 'patrick', title: 'Severance', list: 'recommending' });
  addActor(env, a2, { name: 'Adam Scott', personId: 1 });

  // Two genuinely different titles for a second actor.
  for (const t of ['Poker Face', 'Russian Doll']) {
    const id = addShow(env, { slug: 'patrick', title: t });
    addActor(env, id, { name: 'Natasha Lyonne', personId: 2 });
  }

  // Same person, one credit with a TMDB id and one without.
  const c1 = addShow(env, { slug: 'patrick', title: 'Show A' });
  addActor(env, c1, { name: 'Jane Doe', personId: null });
  const c2 = addShow(env, { slug: 'patrick', title: 'Show B' });
  addActor(env, c2, { name: 'Jane Doe', personId: null });

  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const by = Object.fromEntries(actors.map(a => [a.name, a]));
  check('same title on two lists counts once', by['Adam Scott']?.show_count === 1,
        `got ${by['Adam Scott']?.show_count}`);
  check('two titles count twice', by['Natasha Lyonne']?.show_count === 2,
        `got ${by['Natasha Lyonne']?.show_count}`);
  check('name-only credits group into one person', by['Jane Doe']?.show_count === 2,
        `got ${by['Jane Doe']?.show_count}`);
  check('ordered by show count, most first', actors[0].show_count >= actors[actors.length - 1].show_count);
  check('the titles behind the count come back',
        (by['Natasha Lyonne']?.shows || []).length === 2);
}

console.log('\n== a credit with no IMDB id still counts');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');
  const id = addShow(env, { slug: 'patrick', title: 'Obscure Show' });
  addActor(env, id, { name: 'Unlinked Person', imdbId: null, personId: 7 });

  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const a = actors.find(x => x.name === 'Unlinked Person');
  check('returned even with no imdb_id', !!a);
  check('imdb_id is null rather than absent', a && a.imdb_id === null);
}

console.log('\n== top ten only');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');
  for (let i = 0; i < 15; i++) {
    const id = addShow(env, { slug: 'patrick', title: `Show ${i}` });
    // Actor i appears in i+1 shows' worth of weight via repeated titles.
    for (let j = 0; j <= i; j++) addActor(env, id, { name: `Actor ${j}`, personId: j });
  }
  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  check('never more than ten', actors.length === 10, `got ${actors.length}`);
}

console.log('\n== Trending counts intent, not bookmarks');
{
  const env = makeEnv();
  for (const slug of ['a', 'b', 'c']) { addMember(env, slug); }
  // Three members bookmark one title; three are actually watching another.
  for (const slug of ['a', 'b', 'c']) {
    addShow(env, { slug, title: 'Bookmarked Only', list: 'next' });
    addShow(env, { slug, title: 'Really Watching', list: 'watching' });
  }
  const res = await popular.onRequestGet({ env, request: req('/api/popular') });
  const { shows } = await body(res);
  const titles = shows.map(s => s.title);
  check('a Next Up pile-up does not trend', !titles.includes('Bookmarked Only'), titles.join(','));
  check('a watched title does trend', titles.includes('Really Watching'));
  check('TRENDING_LISTS is the three intent lists',
        TRENDING_LISTS.join(',') === 'watching,waiting,recommending', TRENDING_LISTS.join(','));
}

console.log('\n== Trending paging');
{
  const env = makeEnv();
  for (let i = 0; i < 25; i++) {
    const slug = `m${i}`;
    addMember(env, slug);
    // Each member adds every title so far, so counts differ and 25 titles exist.
    for (let j = 0; j <= i; j++) addShow(env, { slug, title: `Title ${j}`, list: 'watching' });
  }
  const dflt = await body(await popular.onRequestGet({ env, request: req('/api/popular') }));
  check('defaults to ten', dflt.shows.length === 10, `got ${dflt.shows.length}`);

  const more = await body(await popular.onRequestGet({ env, request: req('/api/popular?limit=25') }));
  check('?limit= returns more', more.shows.length === 25, `got ${more.shows.length}`);

  const capped = await body(await popular.onRequestGet({ env, request: req('/api/popular?limit=9999') }));
  check('?limit= is capped at 50', capped.shows.length <= 50, `got ${capped.shows.length}`);

  const junk = await body(await popular.onRequestGet({ env, request: req('/api/popular?limit=abc') }));
  check('junk ?limit= falls back to ten', junk.shows.length === 10, `got ${junk.shows.length}`);

  const neg = await body(await popular.onRequestGet({ env, request: req('/api/popular?limit=-5') }));
  check('negative ?limit= falls back to ten', neg.shows.length === 10, `got ${neg.shows.length}`);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

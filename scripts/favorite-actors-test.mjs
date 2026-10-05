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
//   2a. Ratings weigh. The member's overall rating decides what a title is
//      worth: 10 → 4, 9 → 3, 8 → 2, Loved → at least 2 whatever it was rated,
//      unrated Watching/Awaiting → 1, and anything rated 7 or below off Loved
//      is left out. An archived show counts only when rated 8 or higher, and
//      a season rating never stands in for the overall one.
//   2b. The payload says how many titles are rated and whether that's short
//      of the goal, so the client can offer Rate my backlog.
//   3. A person is counted once per TITLE, not once per row. A member holding
//      the same show on two lists must not double-count its cast, or shuffling
//      a show between lists would invent a favourite.
//   4. The same person arriving under a TMDB id and under a bare name is one
//      person, not two — credits predating migration 060 carry no
//      tmdb_person_id, so a name-only credit resolves to the id the member's
//      own library knows for that name, then to the club's `people` bank.
//      Grouping on the raw row split every such person into two half-counted
//      strangers, which is how a real library rendered as a wall of "2 shows".
//   5. A credit with no imdb_id is still returned. The row renders without a
//      link rather than vanishing, which is what keeps the count honest.
//   6. Each actor carries `show_cards` — the member's own copies with id,
//      network, rating and poster, so the client can draw its standard show
//      row and push the show card. One card per distinct title, and the legacy
//      `shows` title array stays byte-compatible for older clients.
//
// Plus Rate my backlog, which Favorite Actors sends members to: it lists
// archived shows now (they count once rated 8+), one row per title, and its
// badge count agrees with the page.
//
// Plus the shared TRENDING_LISTS rule, which is now the one thing standing
// between "the club is watching this" and "somebody bookmarked it".
//
// Same harness as scripts/vibe-scope-test.mjs.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
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
const rateBacklog = await load('api/rate-backlog.js');
const rateBacklogCount = await load('api/rate-backlog-count.js');
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
  withLegacyShowColumns(db);
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
function addShow(env, { slug, title, list = 'watching', archived = 0, addedBy = 'member',
                        network = null, rating = null, posterUrl = null, tmdbId = null, unmatched = false }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, added_by, archived, created_at, network, rating, poster_url,
                        tmdb_id, tmdb_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(title, list, slug, addedBy, archived, new Date().toISOString(), network, rating, posterUrl,
        tmdbId, tmdbId == null ? null : 'tv');
  const id = env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id;
  // Facts seeded on the copy reach the shared row members read from. A row
  // the test leaves unmatched on purpose stays unmatched.
  liftCopiesIntoTitles(env._db, { pinRow: unmatched ? null : id });
  return id;
}
// The member's own overall (season 0) rating, keyed by title identity the way
// show_ratings is.
function addRating(env, { slug, tmdbId, rating, season = 0 }) {
  env._db.prepare(
    'INSERT INTO show_ratings (tmdb_id, tmdb_type, season_number, member_slug, rating) VALUES (?,?,?,?,?)'
  ).run(tmdbId, 'tv', season, slug, rating);
}
// A credit on the show's shared cast, which is the cast members read
// (title_cast, docs/INVARIANTS.md §29). Billing order is the key there, so a
// second credit at an order already taken goes after the last one.
function addActor(env, showId, { name, imdbId = null, personId = null, ord = 0 }) {
  const pin = env._db.prepare('SELECT tmdb_id, tmdb_type FROM shows WHERE id = ?').get(showId);
  const taken = env._db.prepare('SELECT 1 FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ? AND ord = ?').get(pin.tmdb_type, pin.tmdb_id, ord);
  const at = taken
    ? env._db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ?').get(pin.tmdb_type, pin.tmdb_id).n
    : ord;
  env._db.prepare('INSERT INTO title_cast (tmdb_type, tmdb_id, ord, name, imdb_id, tmdb_person_id) VALUES (?,?,?,?,?,?)')
    .run(pin.tmdb_type, pin.tmdb_id, at, name, imdbId, personId);
}
// The club-wide bank of people enrichment has resolved (migration 060).
function addPerson(env, { personId, name, imdbId = null }) {
  env._db.prepare('INSERT INTO people (tmdb_person_id, name, name_lower, imdb_id) VALUES (?,?,?,?)')
    .run(personId, name, name.toLowerCase(), imdbId);
}

const req = (path, session) => new Request(`${ORIGIN}${path}`, {
  headers: session ? { Cookie: `session=${session}` } : {},
});
const body = async (res) => JSON.parse(await res.text());

console.log('\n== /api/favorite-actors is owner-only');
{
  const env = makeEnv();
  addMember(env, 'patrick'); addMember(env, 'quinn');
  const s = addSession(env, 'patrick');

  const mine = addShow(env, { slug: 'patrick', title: 'Severance' });
  addActor(env, mine, { name: 'Adam Scott', imdbId: 'nm0794014', personId: 1 });
  const theirs = addShow(env, { slug: 'quinn', title: 'Poker Face' });
  addActor(env, theirs, { name: 'Natasha Lyonne', imdbId: 'nm0530879', personId: 2 });

  const anon = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors') });
  check('no session is 401', anon.status === 401);

  const res = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) });
  const { actors } = await body(res);
  check('own actor is returned', actors.some(a => a.name === 'Adam Scott'));
  check("another member's actor never appears", !actors.some(a => a.name === 'Natasha Lyonne'));

  // No ?member= route in or out.
  const spoof = await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors?member=quinn', s) });
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
  check('archived and unrated does NOT count', !names.includes('Archived Actor'));
}

console.log('\n== ratings weigh');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');
  let tmdb = 1000;
  // One actor per case, so each case's weight is its actor's whole score.
  const show = (actor, { list = 'watching', archived = 0, rating = null, season = 0 } = {}) => {
    const tmdbId = ++tmdb;
    const id = addShow(env, { slug: 'patrick', title: `${actor} Show`, list, archived, tmdbId });
    addActor(env, id, { name: actor, personId: tmdbId });
    if (rating != null) addRating(env, { slug: 'patrick', tmdbId, rating, season });
    return id;
  };
  show('Rated Ten', { rating: 10 });
  show('Rated Nine', { rating: 9 });
  show('Archived Eight', { archived: 1, rating: 8 });
  show('Archived Seven', { archived: 1, rating: 7 });
  show('Loved Unrated', { list: 'recommending' });
  show('Loved Rated Three', { list: 'recommending', rating: 3 });
  show('Watching Unrated');
  show('Watching Rated Seven', { rating: 7 });
  show('Season Only Ten', { season: 1, rating: 10 });
  show('Next Up Ten', { list: 'next', rating: 10 });

  const res = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const names = res.actors.map(a => a.name);
  check('a 10 outranks a 9', names.indexOf('Rated Ten') === 0 && names.indexOf('Rated Nine') === 1,
        names.join(','));
  check('an archived show rated 8 counts', names.includes('Archived Eight'));
  check('an archived show rated 7 does not', !names.includes('Archived Seven'));
  check('Loved counts unrated, above an unrated Watching show',
        names.indexOf('Loved Unrated') >= 0 && names.indexOf('Loved Unrated') < names.indexOf('Watching Unrated'),
        names.join(','));
  check('Loved trumps a low rating', names.includes('Loved Rated Three'));
  check('an unrated Watching show still counts', names.includes('Watching Unrated'));
  check('a 7 on Watching knocks the show out', !names.includes('Watching Rated Seven'));
  check('a season rating is not the overall rating',
        names.indexOf('Season Only Ten') > names.indexOf('Loved Unrated'), names.join(','));
  check('Next Up never counts, even rated 10', !names.includes('Next Up Ten'));

  const eight = res.actors.find(a => a.name === 'Archived Eight');
  const card = eight?.show_cards?.[0];
  check('the card says it is archived and carries my rating',
        card && card.archived === 1 && card.my_rating === 8, JSON.stringify(card));
  const unrated = res.actors.find(a => a.name === 'Watching Unrated')?.show_cards?.[0];
  check('an unrated card has my_rating null', unrated && unrated.my_rating === null);

  // Rated (overall, off Next Up): Ten, Nine, Archived Eight, Archived Seven,
  // Loved Rated Three, Watching Rated Seven = 6. Season-only and Next Up don't.
  check('rated_count counts overall ratings off Next Up', res.rated_count === 6, `got ${res.rated_count}`);
  check('six rated is short of the goal of eight',
        res.rating_goal === 8 && res.needs_ratings === true);
}

console.log('\n== a high rating outweighs a pile of unrated shows');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');
  // Three unrated Watching shows = 3; two rated 10 = 8.
  for (let i = 0; i < 3; i++) {
    const id = addShow(env, { slug: 'patrick', title: `Plain ${i}`, tmdbId: 2000 + i });
    addActor(env, id, { name: 'Busy Actor', personId: 1 });
  }
  for (let i = 0; i < 2; i++) {
    const id = addShow(env, { slug: 'patrick', title: `Great ${i}`, tmdbId: 3000 + i });
    addActor(env, id, { name: 'Great Actor', personId: 2 });
    addRating(env, { slug: 'patrick', tmdbId: 3000 + i, rating: 10 });
  }
  // Eight more rated titles clear the goal.
  for (let i = 0; i < 6; i++) {
    addShow(env, { slug: 'patrick', title: `Filler ${i}`, tmdbId: 4000 + i });
    addRating(env, { slug: 'patrick', tmdbId: 4000 + i, rating: 5 });
  }
  const res = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  check('two 10s beat three unrated shows', res.actors[0]?.name === 'Great Actor',
        res.actors.map(a => `${a.name}:${a.show_count}`).join(','));
  check('show_count is still titles, not weight', res.actors[0]?.show_count === 2);
  check('eight rated titles meet the goal', res.rated_count === 8 && res.needs_ratings === false,
        `got ${res.rated_count}`);
}

console.log('\n== an archived copy beside a live one is one title');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');
  const live = addShow(env, { slug: 'patrick', title: 'Severance', tmdbId: 5000 });
  addActor(env, live, { name: 'Adam Scott', personId: 1 });
  const old = addShow(env, { slug: 'patrick', title: 'Severance', archived: 1, tmdbId: 5000 });
  addActor(env, old, { name: 'Adam Scott', personId: 1 });
  addRating(env, { slug: 'patrick', tmdbId: 5000, rating: 9 });

  const res = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const adam = res.actors.find(a => a.name === 'Adam Scott');
  check('counted once', adam?.show_count === 1, `got ${adam?.show_count}`);
  check('the live copy is the card', adam?.show_cards?.length === 1 && adam.show_cards[0].id === live,
        JSON.stringify(adam?.show_cards));
  check('rated_count counts the title once', res.rated_count === 1, `got ${res.rated_count}`);
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

  // Same person split across a post-060 credit (with id) and a legacy
  // name-only credit — nothing in `people`, so only the member's own library
  // can make the link. This is the split that halved real counts.
  const d1 = addShow(env, { slug: 'patrick', title: 'Show C' });
  addActor(env, d1, { name: 'John Smith', personId: 77 });
  const d2 = addShow(env, { slug: 'patrick', title: 'Show D' });
  addActor(env, d2, { name: 'John Smith', personId: null });

  // All-legacy credits whose name the club's people bank has since resolved:
  // one person, and the banked id comes back on the row.
  addPerson(env, { personId: 88, name: 'Maya Chen' });
  for (const t of ['Show E', 'Show F']) {
    const id = addShow(env, { slug: 'patrick', title: t });
    addActor(env, id, { name: 'Maya Chen', personId: null });
  }

  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const by = Object.fromEntries(actors.map(a => [a.name, a]));
  check('same title on two lists counts once', by['Adam Scott']?.show_count === 1,
        `got ${by['Adam Scott']?.show_count}`);
  check('two titles count twice', by['Natasha Lyonne']?.show_count === 2,
        `got ${by['Natasha Lyonne']?.show_count}`);
  check('name-only credits group into one person', by['Jane Doe']?.show_count === 2,
        `got ${by['Jane Doe']?.show_count}`);
  check('an id credit and a legacy name credit are one person',
        by['John Smith']?.show_count === 2, `got ${by['John Smith']?.show_count}`);
  check('the merged person keeps the TMDB id', by['John Smith']?.tmdb_person_id === 77,
        `got ${by['John Smith']?.tmdb_person_id}`);
  check('legacy credits link through the people bank',
        by['Maya Chen']?.show_count === 2 && by['Maya Chen']?.tmdb_person_id === 88,
        `got ${by['Maya Chen']?.show_count} / ${by['Maya Chen']?.tmdb_person_id}`);
  check('ordered by show count, most first', actors[0].show_count >= actors[actors.length - 1].show_count);
  check('the titles behind the count come back',
        (by['Natasha Lyonne']?.shows || []).length === 2);
  check('a merged person lists titles from both credit shapes',
        (by['John Smith']?.shows || []).sort().join(',') === 'Show C,Show D',
        (by['John Smith']?.shows || []).join(','));
}

console.log('\n== show_cards: the rows behind the titles');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const s = addSession(env, 'patrick');

  const a1 = addShow(env, { slug: 'patrick', title: 'Severance', list: 'watching',
                            network: 'Apple TV+', rating: '8.7', posterUrl: 'https://image.tmdb.org/t/p/w342/sev.jpg' });
  addActor(env, a1, { name: 'Adam Scott', personId: 1 });
  // The same title on a second list must not become a second card. Same
  // weight as the first copy, so the older row wins the tie.
  const a2 = addShow(env, { slug: 'patrick', title: 'Severance', list: 'waiting' });
  addActor(env, a2, { name: 'Adam Scott', personId: 1 });
  const b1 = addShow(env, { slug: 'patrick', title: 'Party Down' });
  addActor(env, b1, { name: 'Adam Scott', personId: 1 });

  const { actors } = await body(await favoriteActors.onRequestGet({ env, request: req('/api/favorite-actors', s) }));
  const adam = actors.find(a => a.name === 'Adam Scott');
  check('one card per distinct title', adam?.show_cards?.length === 2,
        `got ${adam?.show_cards?.length}`);
  const sev = (adam?.show_cards || []).find(c => c.title === 'Severance');
  check('a card carries the member\'s own show id', sev && sev.id === a1);
  check('a card carries network, rating and poster',
        sev && sev.network === 'Apple TV+' && sev.rating === '8.7' && sev.poster_url?.includes('sev.jpg'));
  check('a card with no artwork still comes back with nulls',
        (adam?.show_cards || []).some(c => c.title === 'Party Down' && c.poster_url === null && c.network === null));
  check('legacy `shows` titles mirror the cards',
        adam && adam.shows.join(',') === adam.show_cards.map(c => c.title).join(','));
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

console.log('\n== Rate my backlog includes archived shows');
{
  const env = makeEnv();
  addMember(env, 'patrick'); addMember(env, 'quinn');
  const s = addSession(env, 'patrick');
  const live = addShow(env, { slug: 'patrick', title: 'Live', tmdbId: 1 });
  const arch = addShow(env, { slug: 'patrick', title: 'Old Favourite', archived: 1, tmdbId: 2 });
  // Same title live and archived: one row, the live one.
  const dupLive = addShow(env, { slug: 'patrick', title: 'Twice', tmdbId: 3 });
  addShow(env, { slug: 'patrick', title: 'Twice', archived: 1, tmdbId: 3 });
  // Two archived copies of one title: one row, the older.
  const dupOld = addShow(env, { slug: 'patrick', title: 'Gone Twice', archived: 1, tmdbId: 4 });
  addShow(env, { slug: 'patrick', title: 'Gone Twice', archived: 1, tmdbId: 4 });
  // Excluded: Next Up (live or archived), already rated, no tmdb id, someone else's.
  addShow(env, { slug: 'patrick', title: 'Bookmarked', list: 'next', tmdbId: 5 });
  addShow(env, { slug: 'patrick', title: 'Bookmarked Gone', list: 'next', archived: 1, tmdbId: 6 });
  addShow(env, { slug: 'patrick', title: 'Rated Archived', archived: 1, tmdbId: 7 });
  addRating(env, { slug: 'patrick', tmdbId: 7, rating: 9 });
  addShow(env, { slug: 'patrick', title: 'Unknown To TMDB', archived: 1, unmatched: true });
  addShow(env, { slug: 'quinn', title: 'Not Mine', archived: 1, tmdbId: 8 });

  const page = await body(await rateBacklog.onRequestGet({ env, request: req('/api/rate-backlog', s) }));
  const ids = page.shows.map(x => x.id).sort((a, b) => a - b);
  const want = [live, arch, dupLive, dupOld].sort((a, b) => a - b);
  check('live and archived unrated shows, one row per title', ids.join(',') === want.join(','),
        `got ${page.shows.map(x => x.title).join(',')}`);
  check('an archived row says so', page.shows.find(x => x.id === arch)?.archived === 1);
  check('a live row says so', page.shows.find(x => x.id === live)?.archived === 0);

  const badge = await body(await rateBacklogCount.onRequestGet({ env, request: req('/api/rate-backlog-count', s) }));
  check('the badge counts what the page lists', badge.count === page.shows.length,
        `badge ${badge.count} vs page ${page.shows.length}`);
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

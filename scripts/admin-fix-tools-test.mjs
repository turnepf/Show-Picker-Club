// Tests for the admin "fix it for a member" MCP tools: admin_restore_show,
// admin_delete_show, admin_move_show, admin_update_show (re-point at the right
// TMDB entry, rename, service, Watch link, flip TV/movie) and
// admin_refresh_show — plus the change under them, that an add or an edit now
// stores genres and the season count from the detail payload it already
// fetched.
//
//   node scripts/admin-fix-tools-test.mjs
//
// The properties pinned are the ones a successful-looking call could quietly
// get wrong:
//
//   - **Identity.** Every edit re-enriches, and an edit with no TMDB id
//     re-guesses the entry from the title. On a remade title that swaps the
//     1974 original for the 2026 remake. Every admin edit carries the row's
//     own pin unless it is the thing being changed, and a re-point that TMDB
//     can't serve says so rather than reporting success.
//   - **The member's rows only.** A show_id belonging to somebody else is
//     refused with the row intact, whoever the admin named.
//   - **Memos untouched.** No admin tool writes notes, recommended-by or
//     watching-with, even when handed one.
//   - **A refresh isn't an edit.** admin_refresh_show writes enriched_at and
//     never updated_at, which is how the app tells member intent from
//     background work, and it reaches an archived row the nightly rotation
//     skips.
//   - **Every change is in admin_actions.**
//
// Same harness as scripts/enrich-identity-test.mjs: the functions tree copied
// to a temp directory, schema.sql in node:sqlite behind a D1 shim, and a fake
// TMDB on globalThis.fetch.

import { liftCopiesIntoTitles, withLegacyShowColumns } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'admin-fix-tools-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const { toolNamed, toolsFor } = await import(join(sandbox, 'functions', '_shared/mcp-tools.js'));

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fake TMDB ----

const TITLE = 'Little House on the Prairie';
const ORIGINAL = 1234;
const REMAKE = 283304;
const FILM = 999;

const tvDetail = (id, year, genres, seasons, cast) => ({
  id, name: TITLE, first_air_date: `${year}-01-01`, overview: `${TITLE} (${year})`,
  poster_path: `/p${id}.jpg`, vote_average: 7.5, vote_count: 100, status: year === 2026 ? 'Returning Series' : 'Ended',
  genres: genres.map((name) => ({ name })), number_of_seasons: seasons, number_of_episodes: seasons * 10,
  networks: [{ name: year === 2026 ? 'Netflix' : 'NBC', logo_path: `/n${id}.png` }],
  credits: { cast: cast.map((name, i) => ({ id: id * 10 + i, name, order: i })) },
  external_ids: { imdb_id: `tt${id}` }, next_episode_to_air: null,
});
const TV = {
  [ORIGINAL]: tvDetail(ORIGINAL, 1974, ['Drama', 'Family'], 9, ['Michael Landon']),
  [REMAKE]: tvDetail(REMAKE, 2026, ['Drama', 'Western', 'Family'], 2, ['Alice Halsey', 'Luke Bracey']),
};
const MOVIES = {
  [FILM]: {
    id: FILM, title: 'Frances Ha', release_date: '2013-05-17', overview: 'Frances.', poster_path: '/fh.jpg',
    vote_average: 7.1, vote_count: 50, genres: [{ name: 'Comedy' }, { name: 'Drama' }], runtime: 86,
    credits: { cast: [{ id: 501, name: 'Greta Gerwig', order: 0 }], crew: [] }, status: 'Released',
  },
};

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.themoviedb.org') throw new Error(`unexpected fetch: ${url}`);
  const q = (u.searchParams.get('query') || '').toLowerCase();
  if (u.pathname === '/3/search/tv') {
    // Popularity order, the original first — the order that makes a title
    // guess land on the wrong entry.
    const hit = (id) => ({ id, name: TITLE, first_air_date: TV[id].first_air_date, poster_path: TV[id].poster_path });
    return jsonRes({ results: q === TITLE.toLowerCase() ? [hit(ORIGINAL), hit(REMAKE)] : [] });
  }
  if (u.pathname === '/3/search/movie') {
    return jsonRes({ results: q === 'frances ha' ? [{ id: FILM, title: 'Frances Ha', release_date: '2013-05-17', poster_path: '/fh.jpg' }] : [] });
  }
  let m = u.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (m) return TV[m[1]] ? jsonRes(TV[m[1]]) : jsonRes({ status_message: 'not found' }, 404);
  m = u.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (m) return MOVIES[m[1]] ? jsonRes(MOVIES[m[1]]) : jsonRes({ status_message: 'not found' }, 404);
  m = u.pathname.match(/^\/3\/person\/(\d+)\/external_ids$/);
  if (m) return jsonRes({ imdb_id: `nm${m[1]}` });
  throw new Error(`unexpected fetch: ${url}`);
};

// ---- D1 shim over node:sqlite ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); return []; } },
    TMDB_TOKEN: 'test-token',
    _db: db,
  };
}

function addMember(env, slug, admin = 0) {
  env._db.prepare(`INSERT INTO members (slug, name, first_name, last_name, is_admin, enrolled_via) VALUES (?, ?, ?, 'M', ?, 'email')`)
    .run(slug, `${slug}'s Shows`, slug, admin);
}

function addShow(env, slug, o = {}) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, archived, tmdb_id, tmdb_type, release_year, genres,
       seasons_released, network, network_url, notes, recommended_by, watching_with, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`
  ).run(o.title ?? TITLE, o.list ?? 'waiting', slug, o.movie ? 1 : 0, o.archived ? 1 : 0,
    o.tmdb ?? null, o.tmdb ? (o.movie ? 'movie' : 'tv') : null, o.year ?? null, o.genres ?? null,
    o.seasons ?? null, o.network ?? null, o.url ?? null, o.notes ?? null, o.rec ?? null, o.ww ?? null);
  // Facts seeded on the copy reach the shared row members read from.
  liftCopiesIntoTitles(env._db);
  return Number(r.lastInsertRowid);
}

const row = (env, id) => env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id);
// The shared one-row-per-show table (migration 076), kept in sync by every write.
const titleRow = (env, type, id) => env._db.prepare('SELECT * FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').get(type, id);
const actions = (env) => env._db.prepare('SELECT * FROM admin_actions ORDER BY id').all().map((a) => ({ ...a, detail: JSON.parse(a.detail || '{}') }));

const ctxFor = (env, slug = 'patrick', scopes = ['shows:read', 'shows:write', 'members:admin']) => ({
  env, origin: ORIGIN, scopes,
  session: { member_slug: slug, email: `${slug}@example.com`, expires_at: null },
  waitUntil: (p) => p,
});

async function run(env, name, args, ctx = ctxFor(env)) {
  try { return { out: await toolNamed(name).run(ctx, args) }; }
  catch (e) { return { err: e }; }
}

function seed() {
  const env = makeEnv();
  addMember(env, 'patrick', 1);
  addMember(env, 'eric');
  addMember(env, 'christine');
  addMember(env, 'stacy');
  return env;
}

// ---- scenarios ----

console.log('\n== only a members:admin grant sees the tools');
{
  const names = ['admin_restore_show', 'admin_delete_show', 'admin_move_show', 'admin_update_show', 'admin_refresh_show'];
  const plain = toolsFor(['shows:read', 'shows:write']).map((t) => t.name);
  const admin = toolsFor(['shows:read', 'members:admin']).map((t) => t.name);
  check('a read/write grant sees none of them', names.every((n) => !plain.includes(n)), plain.join(','));
  check('a members:admin grant sees all of them', names.every((n) => admin.includes(n)), admin.join(','));
  check('admin_update_show offers no memo fields',
    !['notes', 'recommended_by', 'watching_with'].some((k) => k in toolNamed('admin_update_show').inputSchema.properties));
}

console.log('\n== re-pointing a show at the right TMDB entry');
{
  const env = seed();
  const id = addShow(env, 'eric', { tmdb: ORIGINAL, year: 1974, genres: 'Drama, Family', seasons: 9, network: 'Peacock', notes: 'grandma loved it', rec: 'Mom', ww: 'Sam' });
  const { out, err } = await run(env, 'admin_update_show', { member_slug: 'eric', show_id: id, tmdb_id: REMAKE, notes: 'overwritten?' });
  check('the call succeeds', !err, err && err.message);
  const r = row(env, id);
  check('the row is pinned to the remake', r.tmdb_id === REMAKE && r.tmdb_type === 'tv', `${r.tmdb_id}/${r.tmdb_type}`);
  check('its year comes from the new entry', r.release_year === 2026, String(r.release_year));
  check('genres are replaced, not left from the original', r.genres === 'Drama, Western, Family', r.genres);
  check('so is the season count', r.seasons_released === 2, String(r.seasons_released));
  check('cast is the remake\'s', env._db.prepare('SELECT name FROM actors_v WHERE show_id = ? ORDER BY ord').all(id).map((a) => a.name).join(',') === 'Alice Halsey,Luke Bracey');
  check('memos are untouched, even when the call carries one', r.notes === 'grandma loved it' && r.recommended_by === 'Mom' && r.watching_with === 'Sam', JSON.stringify([r.notes, r.recommended_by, r.watching_with]));
  check('no warning on a re-point that landed', out && !out.warning, out && out.warning);
  const shared = titleRow(env, 'tv', REMAKE);
  check('the edit syncs the shared row for the new entry', shared && shared.release_year === 2026 && shared.genres === 'Drama, Western, Family', JSON.stringify(shared));
  check('with no member memo in it', !JSON.stringify(shared).includes('grandma'));
  const a = actions(env).at(-1);
  check('admin_actions records before and after', a && a.action === 'update_show' && a.admin_slug === 'patrick' && a.member_slug === 'eric'
    && a.detail.before.tmdb_id === ORIGINAL && a.detail.after.tmdb_id === REMAKE, JSON.stringify(a));

  const bad = await run(env, 'admin_update_show', { member_slug: 'eric', show_id: id, tmdb_id: 424242 });
  check('an id TMDB can\'t serve warns instead of claiming success', bad.out && /didn't return entry 424242/.test(bad.out.warning || ''), JSON.stringify(bad.out || bad.err?.message));
}

console.log('\n== edits that aren\'t about identity keep the pin');
{
  const env = seed();
  // A title search would land on the 1974 entry (popularity order) — or, for
  // a row pinned to the remake, swap it away. The pin has to ride along.
  const id = addShow(env, 'christine', { tmdb: REMAKE, year: 2026, network: 'Peacock' });
  const net = await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, network: 'netflix' });
  check('changing the service succeeds', !net.err, net.err && net.err.message);
  let r = row(env, id);
  check('the service is canonicalized', r.network === 'Netflix', r.network);
  check('and the row is still the remake', r.tmdb_id === REMAKE && r.release_year === 2026, `${r.tmdb_id} ${r.release_year}`);

  const url = await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, watch_url: 'https://www.hulu.com/series/little-house' });
  r = row(env, id);
  check('a Watch link sets the link', !url.err && r.network_url === 'https://www.hulu.com/series/little-house', url.err?.message || r.network_url);
  check('and its site decides the service', r.network === 'Hulu', r.network);
  check('still the remake', r.tmdb_id === REMAKE);

  const named = await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, title: 'Little House on the Prairie (2026)' });
  r = row(env, id);
  // The copy keeps the title it was given, but members see TMDB's name: a
  // show is its entry (docs/INVARIANTS.md §29).
  const raw = env._db.prepare('SELECT title FROM shows WHERE id = ?').get(id);
  check('a rename is stored on this copy', !named.err && raw.title === 'Little House on the Prairie (2026)', named.err?.message || raw.title);
  check('but members still see TMDB\'s name', r.title === TITLE, r.title);
  check('and keeps the pin', r.tmdb_id === REMAKE);

  check('a bad Watch link is refused', !!(await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, watch_url: 'javascript:alert(1)' })).err);
  check('a call that changes nothing is refused', !!(await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id })).err);
}

console.log('\n== flipping TV ↔ movie');
{
  const env = seed();
  // Saved as TV, so it carries a season count a film can't have.
  const id = addShow(env, 'christine', { title: 'Frances Ha', list: 'next', seasons: 3 });
  const { out, err } = await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, media_type: 'movie' });
  const r = row(env, id);
  check('a film saved as TV becomes a movie', !err && r.movie === 1, err?.message || String(r.movie));
  check('and is matched in the movie index', r.tmdb_id === FILM && r.tmdb_type === 'movie', `${r.tmdb_id}/${r.tmdb_type}`);
  check('with its genres', r.genres === 'Comedy, Drama', r.genres);
  check('and without the season count it had as TV', r.seasons_released === null, String(r.seasons_released));
  check('no warning', out && !out.warning, out && out.warning);
  check('media_type equal to the current type changes nothing, so it\'s refused',
    !!(await run(env, 'admin_update_show', { member_slug: 'christine', show_id: id, media_type: 'movie' })).err);
}

console.log('\n== restore, move, delete');
{
  const env = seed();
  const arch = addShow(env, 'eric', { tmdb: ORIGINAL, year: 1974, archived: true, list: 'recommending', notes: 'keep me' });
  const res = await run(env, 'admin_restore_show', { member_slug: 'eric', show_id: arch, list: 'loved' });
  let r = row(env, arch);
  check('restore brings an archived show back', !res.err && r.archived === 0 && r.list === 'recommending', res.err?.message || JSON.stringify(r));
  check('without re-guessing which Little House it is', r.tmdb_id === ORIGINAL && r.release_year === 1974, `${r.tmdb_id} ${r.release_year}`);
  check('memo intact', r.notes === 'keep me');

  const mv = await run(env, 'admin_move_show', { member_slug: 'eric', show_id: arch, list: 'watching' });
  r = row(env, arch);
  check('move puts it on the named list', !mv.err && r.list === 'watching', mv.err?.message || r.list);
  check('and logs from/to', actions(env).at(-1).action === 'move_show' && actions(env).at(-1).detail.to === 'watching');

  const theirs = addShow(env, 'christine', { tmdb: REMAKE, year: 2026 });
  const wrong = await run(env, 'admin_delete_show', { member_slug: 'eric', show_id: theirs });
  check('a show_id that isn\'t that member\'s is refused', wrong.err && /isn't on eric's lists/.test(wrong.err.message), wrong.err?.message);
  check('and the row survives', !!row(env, theirs));
  const wrongMove = await run(env, 'admin_move_show', { member_slug: 'eric', show_id: theirs, list: 'loved' });
  check('the same for move', !!wrongMove.err && row(env, theirs).list === 'waiting');

  const del = await run(env, 'admin_delete_show', { member_slug: 'eric', show_id: arch });
  check('delete removes the member\'s row', !del.err && !row(env, arch), del.err?.message);
  check('another member\'s copy of the title is untouched', !!row(env, theirs));
  const last = actions(env).at(-1);
  check('the delete is logged with what was deleted', last.action === 'delete_show' && last.detail.title === TITLE && last.detail.tmdb_id === ORIGINAL, JSON.stringify(last));
}

console.log('\n== refresh is background work, not an edit');
{
  const env = seed();
  // Archived, with cast and an episode count but no genres or seasons — the
  // shape the nightly rotation never selects.
  const id = addShow(env, 'eric', { tmdb: REMAKE, year: 2026, archived: true, list: 'recommending' });
  env._db.prepare('UPDATE shows SET episodes_released = 8 WHERE id = ?').run(id);
  env._db.prepare("INSERT INTO actors (show_id, name, ord) VALUES (?, 'Someone', 0)").run(id);
  const twin = addShow(env, 'christine', { tmdb: REMAKE, year: 2026 });
  const original = addShow(env, 'stacy', { tmdb: ORIGINAL, year: 1974, genres: 'Drama, Family', seasons: 9 });

  const { out, err } = await run(env, 'admin_refresh_show', { member_slug: 'eric', show_id: id });
  const r = row(env, id);
  check('the call reports a refresh', !err && out.refreshed === true, err?.message || JSON.stringify(out));
  check('an archived row gets genres and seasons', r.genres === 'Drama, Western, Family' && r.seasons_released === 2, `${r.genres} / ${r.seasons_released}`);
  check('updated_at is untouched', r.updated_at === '2026-09-01 00:00:00', r.updated_at);
  check('enriched_at is stamped', !!r.enriched_at);
  check('identity unchanged', r.tmdb_id === REMAKE);
  check("another member's copy of the same entry gets the catalog fields too", row(env, twin).genres === 'Drama, Western, Family', row(env, twin).genres);
  check('the original\'s copies are left alone', row(env, original).genres === 'Drama, Family' && row(env, original).seasons_released === 9);
  check('logged', actions(env).at(-1).action === 'refresh_show');
  const sharedR = titleRow(env, 'tv', REMAKE);
  check('the background refresh syncs the shared row, named by TMDB', sharedR && sharedR.name === TITLE && sharedR.seasons_released === 2, JSON.stringify(sharedR));
  check('with the fullest cast', env._db.prepare("SELECT COUNT(*) AS n FROM title_cast WHERE tmdb_type = 'tv' AND tmdb_id = ?").get(REMAKE).n === 2);
  // A copy of the same entry saved under another title never received the
  // title-scoped propagation. Through the view it reads the shared row.
  const renamed = addShow(env, 'stacy', { title: 'Little House on the Prairie (2026)', tmdb: REMAKE, year: 2026 });
  const seen = env._db.prepare('SELECT title, genres, seasons_released FROM shows_v WHERE id = ?').get(renamed);
  check('a differently-titled copy reads the refreshed shared row', seen.title === TITLE && seen.genres === 'Drama, Western, Family' && seen.seasons_released === 2, JSON.stringify(seen));

  const film = addShow(env, 'christine', { title: 'Frances Ha', movie: true, tmdb: FILM, list: 'next' });
  const fr = await run(env, 'admin_refresh_show', { member_slug: 'christine', show_id: film });
  check('a movie refreshes through the movie pass', !fr.err && fr.out.refreshed && row(env, film).genres === 'Comedy, Drama', fr.err?.message || row(env, film).genres);
}

console.log('\n== adds store genres and seasons');
{
  const env = seed();
  const { out, err } = await run(env, 'add_show', { title: TITLE, list: 'awaiting', tmdb_id: REMAKE, media_type: 'tv' }, ctxFor(env, 'stacy', ['shows:read', 'shows:write']));
  const r = err ? null : row(env, out.added.id);
  const sharedA = titleRow(env, 'tv', REMAKE);
  check('an add creates the shared row', sharedA && sharedA.name === TITLE && sharedA.genres === 'Drama, Western, Family', JSON.stringify(sharedA));
  check('a new TV row carries genres and seasons from the first fetch', r && r.genres === 'Drama, Western, Family' && r.seasons_released === 2, err?.message || JSON.stringify(r && [r.genres, r.seasons_released]));
}

console.log('\n== an admin fix is not the member\'s activity');
{
  // updated_at drives the member-activity reports. A batch of admin fixes on
  // 2026-10-04/05 moved it on ~140 rows and had to be restored from backup.
  const env = seed();
  const STAMP = '2026-09-01 00:00:00';
  const id = addShow(env, 'eric', { tmdb: REMAKE, year: 2026, network: 'Peacock' });
  const stamp = () => row(env, id).updated_at;

  const ed = await run(env, 'admin_update_show', { member_slug: 'eric', show_id: id, network: 'netflix' });
  check('an admin edit lands', !ed.err && row(env, id).network === 'Netflix', ed.err?.message);
  check('and leaves updated_at alone', stamp() === STAMP, stamp());
  await run(env, 'admin_move_show', { member_slug: 'eric', show_id: id, list: 'loved' });
  check('so does an admin move', row(env, id).list === 'recommending' && stamp() === STAMP, `${row(env, id).list} ${stamp()}`);
  await run(env, 'admin_archive_show', { member_slug: 'eric', show_id: id });
  check('and an admin archive', row(env, id).archived === 1 && stamp() === STAMP, stamp());
  await run(env, 'admin_restore_show', { member_slug: 'eric', show_id: id, list: 'watching' });
  check('and an admin restore', row(env, id).archived === 0 && stamp() === STAMP, stamp());

  const member = ctxFor(env, 'eric', ['shows:read', 'shows:write']);
  await run(env, 'move_show', { show_id: id, list: 'awaiting' }, member);
  check('the member\'s own move still bumps it', stamp() !== STAMP, stamp());

  // Adds and ratings an admin makes for a member carry what the member told
  // them, so they count as the member's.
  const add = await run(env, 'admin_add_show', { member_slug: 'stacy', title: 'Frances Ha', tmdb_id: FILM, media_type: 'movie', list: 'loved', rating: 9 });
  const added = add.err ? null : env._db.prepare('SELECT created_at, updated_at FROM shows WHERE id = ?').get(add.out.added.id);
  check('an admin add stamps created_at', added && added.created_at && added.created_at !== STAMP, add.err?.message || JSON.stringify(added));
  const rated = env._db.prepare("SELECT updated_at FROM show_ratings WHERE member_slug = 'stacy' AND tmdb_id = ?").get(FILM);
  check('and its rating stamps the rating\'s updated_at', rated && !!rated.updated_at, JSON.stringify(rated));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

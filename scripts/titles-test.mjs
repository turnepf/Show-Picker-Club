// Tests for the shared one-row-per-show tables (`titles`, `title_cast`) and
// the views members read through (`shows_v`, `actors_v`): normalizing the
// library, docs/ARCHITECTURE.md#titles, docs/INVARIANTS.md §29.
//
//   node scripts/titles-test.mjs
//
// What has to hold:
//   - a show's facts and cast live once per TMDB entry, and arrive only from
//     TMDB's payload (writeTitle): a member's copy never writes them;
//   - every entry a copy points at has a row, named by TMDB once TMDB has
//     spoken, and an entry nothing points at is dropped;
//   - the views return exactly the shape the apps have always had, with the
//     show's facts from the shared row and everything personal from the
//     member's row, including the four per-member fields;
//   - no member field and no memo reaches the shared tables;
//   - the migrations that built this did what they say;
//   - none of the bookkeeping ever throws into a member's save.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'titles-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
const T = await import(join(sandbox, 'functions', '_shared/titles.js'));
const { syncTitle, writeTitle, titleFieldsFromEnrichment, rebuildTitles, TITLE_FIELDS, SHOWS_COLUMNS, SHOWS_TABLE_COLUMNS,
  SHARED_FIELDS, PER_COPY_FIELDS, viewSql, ACTORS_COLUMNS, actorsViewSql } = T;
const { fillActorIdsFromKnownPeople } = await import(join(sandbox, 'functions', '_shared/people.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('a','A','A','X','email'),('b','B','B','X','email'),('c','C','C','X','email')`).run();
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

// A member's copy: only member fields and the pin.
function show(env, o) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, notes, network, full_series, enriched_at, updated_at)
     VALUES (?, 'watching', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.title, o.member || 'a', o.movie ? 1 : 0, o.tmdb ?? null,
    o.type === undefined ? (o.tmdb ? (o.movie ? 'movie' : 'tv') : null) : o.type,
    o.notes ?? null, o.network ?? null, o.full ?? 0, o.enriched ?? null, o.updated ?? null);
  return Number(r.lastInsertRowid);
}
const title = (env, type, id) => env._db.prepare('SELECT * FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').get(type, id);
const cast = (env, type, id) => env._db.prepare('SELECT name FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ? ORDER BY ord').all(type, id).map((r) => r.name).join(',');
const v = (env, id) => env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id);
const norm = (x) => x.replace(/\s+/g, ' ').trim();

console.log('\n== every entry a copy points at has a row');
{
  const env = makeEnv();
  show(env, { title: 'Severance', member: 'a', tmdb: 95396, enriched: '2026-09-01 00:00:00', notes: 'SECRET' });
  show(env, { title: 'severance', member: 'b', tmdb: 95396, enriched: '2026-10-01 00:00:00' });
  show(env, { title: 'Frances Ha', member: 'c', movie: true, tmdb: 121986, type: null });
  show(env, { title: 'Unmatched', member: 'c' });
  const counts = await rebuildTitles(env);
  check('one row per entry', counts.titles === 2, JSON.stringify(counts));
  check('named from the freshest copy until TMDB names it', title(env, 'tv', 95396).name === 'severance');
  check('carrying no facts of its own (those arrive from TMDB)', title(env, 'tv', 95396).overview === null);
  check('a row with no stored type is keyed by its movie flag', !!title(env, 'movie', 121986) && !title(env, 'tv', 121986));
  const cols = env._db.prepare("SELECT name FROM pragma_table_info('titles')").all().map((r) => r.name);
  check('no member field is a column', !['notes', 'list', 'network', 'network_url', 'watching_with', 'recommended_by', 'added_by', 'member_slug', 'archived'].some((c) => cols.includes(c)), cols.join(','));
  check('every catalog field is a column', TITLE_FIELDS.every((f) => cols.includes(f)));
  check('memo text never lands in the shared tables', !JSON.stringify(env._db.prepare('SELECT * FROM titles').all()).includes('SECRET'));

  env._db.prepare("INSERT INTO title_cast (tmdb_type, tmdb_id, ord, name) VALUES ('movie', 121986, 0, 'Greta Gerwig')").run();
  env._db.prepare("UPDATE shows SET tmdb_id = 999, tmdb_type = 'movie' WHERE title = 'Frances Ha'").run();
  await rebuildTitles(env);
  check('an entry nothing points at is dropped', !title(env, 'movie', 121986) && !!title(env, 'movie', 999));
  check('with its cast', cast(env, 'movie', 121986) === '');
}

console.log('\n== the sync never overwrites');
{
  const env = makeEnv();
  show(env, { title: 'little house on the prairie (2026)', tmdb: 283304 });
  check('creates a missing row', await syncTitle(env, 'tv', 283304) === true && !!title(env, 'tv', 283304));
  await writeTitle(env, 'tv', 283304, { name: 'Little House on the Prairie', fields: { overview: 'TMDB text' } });
  await syncTitle(env, 'tv', 283304, 'something a copy says');
  check('keeps TMDB\'s name and facts', title(env, 'tv', 283304).name === 'Little House on the Prairie' && title(env, 'tv', 283304).overview === 'TMDB text');
  await rebuildTitles(env);
  check('so does the rebuild', title(env, 'tv', 283304).name === 'Little House on the Prairie' && title(env, 'tv', 283304).overview === 'TMDB text');
  check('an entry no copy points at isn\'t created', (await syncTitle(env, 'tv', 1, 'Ghost')) === true && !title(env, 'tv', 1));
  check('bad input is refused quietly', (await syncTitle(env, 'film', 5)) === false && (await syncTitle(env, 'tv', 'x')) === false);
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  check('a database error never throws', (await syncTitle(broken, 'tv', 283304)) === false);
}

console.log('\n== writers write TMDB\'s payload directly');
{
  const env = makeEnv();
  show(env, { title: 'MobLand', tmdb: 247718 });
  const payload = {
    overview: 'Two mob families clash.', genres: 'Crime, Drama', seasonsReleased: 2, posterUrl: 'https://image.tmdb.org/m.jpg',
    tmdbRating: '8.5', tmdbStatus: 'Returning Series', flatrateNetworks: [], freeNetworks: null, tagline: null,
    actors: [{ name: 'Tom Hardy', imdb_id: 'nm0362766', ord: 0, tmdb_person_id: 2524, character: 'Harry' }, { name: 'Helen Mirren', ord: 1 }],
  };
  check('writes', await writeTitle(env, 'tv', 247718, { name: 'MobLand', fields: titleFieldsFromEnrichment(payload), cast: payload.actors }) === true);
  const t = title(env, 'tv', 247718);
  check('TMDB\'s values land', t.overview === 'Two mob families clash.' && t.genres === 'Crime, Drama' && t.seasons_released === 2 && t.poster_url === 'https://image.tmdb.org/m.jpg', JSON.stringify(t));
  check('rating and status follow', t.rating === '8.5' && t.tmdb_rating === '8.5' && t.tmdb_status === 'Returning Series' && t.full_series === 0);
  check('"streams nowhere" is a value, not a gap', t.streaming_on === '');
  check('a field the payload lacks keeps what\'s stored', t.free_on === null && t.name === 'MobLand');
  check('the cast is TMDB\'s', cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren', cast(env, 'tv', 247718));
  check('with characters', env._db.prepare("SELECT character_name AS c FROM title_cast WHERE name = 'Tom Hardy'").get().c === 'Harry');
  await rebuildTitles(env);
  check('the nightly rebuild doesn\'t undo it', title(env, 'tv', 247718).overview === 'Two mob families clash.' && cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren');
  await writeTitle(env, 'tv', 247718, { fields: { overview: null, vote_count: 900 } });
  check('a write without a name keeps the name', title(env, 'tv', 247718).name === 'MobLand' && title(env, 'tv', 247718).vote_count === 900);
  check('and null never blanks a field', title(env, 'tv', 247718).overview === 'Two mob families clash.');
  await writeTitle(env, 'tv', 247718, { cast: [] });
  check('an empty cast list keeps the cast', cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren');
  await writeTitle(env, 'tv', 247718, { name: 'MobLand: A New Name' });
  check('a new name from TMDB replaces it', title(env, 'tv', 247718).name === 'MobLand: A New Name');
  const ended = titleFieldsFromEnrichment({ tmdbStatus: 'Ended' });
  check('an ended series is full_series', ended.full_series === 1 && !('overview' in ended));
  show(env, { title: 'Severance', tmdb: 95396 });
  check('a new entry without TMDB\'s name starts from the copies\' title', await writeTitle(env, 'tv', 95396, { fields: { vote_count: 5 } }) === true
    && title(env, 'tv', 95396).name === 'Severance' && title(env, 'tv', 95396).vote_count === 5);
  check('an entry no copy points at, with no name, is refused', await writeTitle(env, 'tv', 4242, { fields: { vote_count: 1 } }) === false && !title(env, 'tv', 4242));
  check('bad input is refused', await writeTitle(env, 'film', 1, {}) === false);
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  check('a database error never throws', (await writeTitle(broken, 'tv', 1, { name: 'x' })) === false);
}

console.log('\n== the views');
{
  const env = makeEnv();
  const viewCols = env._db.prepare("SELECT name FROM pragma_table_info('shows_v')").all().map((r) => r.name);
  check('shows_v returns exactly the shape the apps have always had', JSON.stringify(viewCols) === JSON.stringify(SHOWS_COLUMNS), `${viewCols.length}`);
  // schema.sql's `shows` is production's since the 2026-10-05 cleanup: the
  // member's own columns and nothing the shared row holds.
  const tableCols = env._db.prepare("SELECT name FROM pragma_table_info('shows')").all().map((r) => r.name);
  check('shows holds exactly the member\'s columns', JSON.stringify([...tableCols].sort()) === JSON.stringify([...SHOWS_TABLE_COLUMNS].sort()),
    tableCols.filter((c) => !SHOWS_TABLE_COLUMNS.includes(c)).concat(SHOWS_TABLE_COLUMNS.filter((c) => !tableCols.includes(c))).join(','));
  const actorCols = env._db.prepare("SELECT name FROM pragma_table_info('actors_v')").all().map((r) => r.name);
  check('actors_v keeps the cast shape', JSON.stringify(actorCols) === JSON.stringify(ACTORS_COLUMNS), actorCols.join(','));
  const mig = readFileSync(join(repoRoot, 'migrations/080_views_shared_only.sql'), 'utf8');
  check('migration 080 is viewSql() and actorsViewSql()', norm(mig).includes(norm(viewSql())) && norm(mig).includes(norm(actorsViewSql())));
  check('the per-member fields stay off the shared set', PER_COPY_FIELDS.every((f) => !SHARED_FIELDS.includes(f)) && PER_COPY_FIELDS.includes('full_series'));

  const a = show(env, { title: 'Sopranos', member: 'a', tmdb: 1398, notes: 'MINE', network: 'HBO Max', full: 1 });
  const b = show(env, { title: 'The Sopranos', member: 'b', tmdb: 1398, network: 'Max' });
  env._db.prepare("UPDATE shows SET next_season_date = '2026-12-01', network_logo_url = 'https://image.tmdb.org/hbo.png' WHERE id = ?").run(a);
  const lone = show(env, { title: 'Unmatched Thing', member: 'c' });
  await writeTitle(env, 'tv', 1398, { name: 'The Sopranos', fields: { overview: 'Tony.' },
    cast: [{ name: 'James Gandolfini', ord: 0 }, { name: 'Edie Falco', ord: 1 }] });
  check('every copy shows TMDB\'s name', v(env, a).title === 'The Sopranos' && v(env, b).title === 'The Sopranos');
  check('and only the shared facts, never a copy\'s leftovers', v(env, a).overview === 'Tony.' && v(env, b).overview === 'Tony.', v(env, a).overview);
  check('member fields stay the member\'s', v(env, a).notes === 'MINE' && v(env, a).network === 'HBO Max' && v(env, b).network === 'Max' && v(env, a).member_slug === 'a');
  check('so do the per-member fields, the "Series complete" toggle included', v(env, a).next_season_date === '2026-12-01' && v(env, b).next_season_date === null
    && v(env, a).network_logo_url === 'https://image.tmdb.org/hbo.png' && v(env, a).full_series === 1 && v(env, b).full_series === 0);
  check('a copy no entry backs reads its own title and no facts', v(env, lone).title === 'Unmatched Thing' && v(env, lone).overview === null);
  const castOf = (id) => env._db.prepare('SELECT name FROM actors_v WHERE show_id = ? ORDER BY ord').all(id).map((r) => r.name).join(',');
  check('every copy reads the shared cast', castOf(a) === 'James Gandolfini,Edie Falco' && castOf(b) === castOf(a), castOf(a));
  env._db.prepare("INSERT INTO actors (show_id, name, ord) VALUES (?, 'Old Copy Cast', 0)").run(lone);
  check('a copy\'s own leftover cast rows are never shown', castOf(lone) === '');

  env._db.prepare("INSERT INTO people (tmdb_person_id, name, name_lower, imdb_id) VALUES (77, 'Edie Falco', 'edie falco', 'nm0004908')").run();
  await fillActorIdsFromKnownPeople(env);
  const linked = env._db.prepare("SELECT imdb_id FROM actors_v WHERE show_id = ? AND name = 'Edie Falco'").get(a);
  check('the people bank links the shared cast', linked && linked.imdb_id === 'nm0004908', JSON.stringify(linked));
}

console.log('\n== the migrations that built this');
{
  // Each run the way deploy did: on an existing database that has `shows`
  // (with the facts still on the copies, as production had) but not yet the
  // new tables.
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(join(repoRoot, 'schema.sql'), 'utf8')
    .replace(/CREATE TABLE IF NOT EXISTS titles \([\s\S]*?\n\);\n/, '')
    .replace(/CREATE TABLE IF NOT EXISTS title_cast \([\s\S]*?\n\);\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_title_cast_person[^\n]*\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_shows_tmdb[^\n]*\n/, '')
    .replace(/CREATE VIEW shows_v AS[\s\S]*?;\n/, '')
    .replace(/CREATE VIEW actors_v AS[\s\S]*?;\n/, '');
  db.exec(schema);
  withLegacyShowColumns(db);
  check('the fixture database starts without the tables', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'titles'").get());
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('a','A','A','X','email')`).run();
  db.prepare(`INSERT INTO shows (title, list, member_slug, tmdb_id, tmdb_type, overview, streaming_on, free_on) VALUES ('BEEF','loved','a',154385,'tv','Road rage.','', '')`).run();
  db.prepare(`INSERT INTO actors (show_id, name, ord) VALUES (1, 'Ali Wong', 0)`).run();
  const m = (n) => readFileSync(join(repoRoot, `migrations/${n}`), 'utf8');
  db.exec(m('076_titles.sql'));
  const row = db.prepare('SELECT * FROM titles').get();
  check('076 creates and backfills', row && row.name === 'BEEF' && row.overview === 'Road rage.', JSON.stringify(row));
  check('including cast', db.prepare('SELECT COUNT(*) AS n FROM title_cast').get().n === 1);
  db.exec(m('076_titles.sql'));
  check('and is safe to run twice', db.prepare('SELECT COUNT(*) AS n FROM titles').get().n === 1);
  check('076 read \'\' as missing (the bug 079 repairs)', row.streaming_on === null);
  db.exec(m('079_titles_empty_answers.sql'));
  const r = db.prepare('SELECT streaming_on, free_on FROM titles').get();
  check('079 restores "asked, none" from the copies', r.streaming_on === '' && r.free_on === '', JSON.stringify(r));
  db.prepare("UPDATE titles SET streaming_on = 'Netflix'").run();
  db.exec(m('079_titles_empty_answers.sql'));
  check('and never overwrites a value', db.prepare('SELECT streaming_on FROM titles').get().streaming_on === 'Netflix');
  db.exec(m('077_shows_view.sql'));
  db.exec(m('078_actors_view.sql'));
  db.exec(m('080_views_shared_only.sql'));
  check('080 leaves the views in their final shape', db.prepare('SELECT title, overview FROM shows_v').get().overview === 'Road rage.'
    && db.prepare('SELECT COUNT(*) AS n FROM actors_v').get().n === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

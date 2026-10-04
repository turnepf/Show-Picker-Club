// Tests for the shared one-row-per-show tables (`titles`, `title_cast`,
// migration 076, functions/_shared/titles.js), step 1 of normalizing the
// library.
//
//   node scripts/titles-test.mjs
//
// Nothing reads these tables yet, so what has to hold is that they're a
// faithful summary of the copies in `shows`, built the same way by the
// migration, the nightly rebuild and the per-write sync:
//
//   - one row per (tmdb_type, tmdb_id), keyed by the movie flag when an old
//     row never stored its type;
//   - each field from the freshest copy that has a value, so a half-filled
//     copy doesn't blank what another copy knows;
//   - TMDB's own name when the writer has it;
//   - the fullest cast any copy holds;
//   - no member field (notes, list, network…) reaches the shared row;
//   - an entry nothing points at any more is dropped by the rebuild;
//   - the migration's backfill is the same SQL as rebuildTitles();
//   - syncTitle never throws, because it runs beside a member's save.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'titles-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
const { syncTitle, writeTitle, titleFieldsFromEnrichment, rebuildTitles, rebuildSql, TITLE_FIELDS, SHOWS_COLUMNS, SHARED_FIELDS, PER_COPY_FIELDS, viewSql, ACTORS_COLUMNS, actorsViewSql } = await import(join(sandbox, 'functions', '_shared/titles.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() { const r = this.db.prepare(this.sql).all(...this.args); return r.length ? { ...r[0] } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes ?? 0) } }; }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('a','A','A','X','email'),('b','B','B','X','email'),('c','C','C','X','email')`).run();
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

function show(env, o) {
  const r = env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, overview, poster_url, genres,
       seasons_released, notes, network, enriched_at, updated_at, release_year)
     VALUES (?, 'watching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.title, o.member || 'a', o.movie ? 1 : 0, o.tmdb ?? null, o.type === undefined ? (o.tmdb ? (o.movie ? 'movie' : 'tv') : null) : o.type,
    o.overview ?? null, o.poster ?? null, o.genres ?? null, o.seasons ?? null, o.notes ?? null, o.network ?? null,
    o.enriched ?? null, o.updated ?? null, o.year ?? null);
  const id = Number(r.lastInsertRowid);
  (o.cast || []).forEach((n, i) => env._db.prepare('INSERT INTO actors (show_id, name, ord) VALUES (?, ?, ?)').run(id, n, i));
  return id;
}
const title = (env, type, id) => env._db.prepare('SELECT * FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').get(type, id);
const cast = (env, type, id) => env._db.prepare('SELECT name FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ? ORDER BY ord').all(type, id).map((r) => r.name).join(',');

console.log('\n== the rebuild summarizes the copies');
{
  const env = makeEnv();
  // Two copies of one entry: the older has the overview, the newer the poster.
  show(env, { title: 'Severance', member: 'a', tmdb: 95396, overview: 'Work-life balance.', genres: 'Drama', enriched: '2026-09-01 00:00:00', notes: 'SECRET', network: 'Apple TV+', cast: ['Adam Scott'] });
  show(env, { title: 'Severance', member: 'b', tmdb: 95396, poster: 'https://image.tmdb.org/p.jpg', genres: 'Drama, Mystery', seasons: 2, enriched: '2026-10-01 00:00:00', cast: ['Adam Scott', 'Britt Lower', 'Zach Cherry'] });
  // A film whose row never stored tmdb_type.
  show(env, { title: 'Frances Ha', member: 'c', movie: true, tmdb: 121986, type: null, overview: 'Frances.' });
  // A row with no TMDB match isn't an entry.
  show(env, { title: 'Unmatched', member: 'c' });

  const counts = await rebuildTitles(env);
  check('one row per entry', counts.titles === 2, JSON.stringify(counts));
  const sev = title(env, 'tv', 95396);
  check('each field comes from the freshest copy that has it',
    sev.overview === 'Work-life balance.' && sev.poster_url === 'https://image.tmdb.org/p.jpg' && sev.genres === 'Drama, Mystery' && sev.seasons_released === 2,
    JSON.stringify(sev));
  check('the name comes from the copies', sev.name === 'Severance');
  check('the fullest cast wins', cast(env, 'tv', 95396) === 'Adam Scott,Britt Lower,Zach Cherry', cast(env, 'tv', 95396));
  check('a row with no stored type is keyed by its movie flag', !!title(env, 'movie', 121986) && !title(env, 'tv', 121986));
  const cols = env._db.prepare("SELECT name FROM pragma_table_info('titles')").all().map((r) => r.name);
  check('no member field is a column', !['notes', 'list', 'network', 'network_url', 'watching_with', 'recommended_by', 'added_by', 'member_slug', 'archived'].some((c) => cols.includes(c)), cols.join(','));
  check('every catalog field is a column', TITLE_FIELDS.every((f) => cols.includes(f)));
  check('member memo text never lands in the shared tables',
    !JSON.stringify(env._db.prepare('SELECT * FROM titles').all()).includes('SECRET'));

  // Re-point the only Frances Ha copy elsewhere: its entry has nothing left.
  env._db.prepare("UPDATE shows SET tmdb_id = 999, tmdb_type = 'movie' WHERE title = 'Frances Ha'").run();
  await rebuildTitles(env);
  check('an entry nothing points at is dropped', !title(env, 'movie', 121986) && !!title(env, 'movie', 999));
}

console.log('\n== the per-write sync');
{
  const env = makeEnv();
  show(env, { title: 'little house on the prairie (2026)', tmdb: 283304, overview: 'Old text', enriched: '2026-09-01 00:00:00' });
  check('syncs one entry', await syncTitle(env, 'tv', 283304, 'Little House on the Prairie') === true);
  check('with TMDB\'s own name when the writer has it', title(env, 'tv', 283304).name === 'Little House on the Prairie');
  env._db.prepare("UPDATE shows SET overview = 'New text', enriched_at = '2026-10-04 00:00:00' WHERE tmdb_id = 283304").run();
  await syncTitle(env, 'tv', 283304);
  check('a sync from the copies fills gaps but never overwrites (step 3b)', title(env, 'tv', 283304).overview === 'Old text', title(env, 'tv', 283304).overview);
  env._db.prepare("UPDATE titles SET genres = NULL WHERE tmdb_id = 283304").run();
  env._db.prepare("UPDATE shows SET genres = 'Drama' WHERE tmdb_id = 283304").run();
  await syncTitle(env, 'tv', 283304);
  check('and does fill a missing field', title(env, 'tv', 283304).genres === 'Drama');
  check('a sync without a name keeps TMDB\'s name rather than a member\'s title', title(env, 'tv', 283304).name === 'Little House on the Prairie', title(env, 'tv', 283304).name);
  await rebuildTitles(env);
  check('so does the rebuild', title(env, 'tv', 283304).name === 'Little House on the Prairie');
  await writeTitle(env, 'tv', 283304, { name: 'Little House on the Prairie: A New Beginning' });
  check('a new name from TMDB replaces it', title(env, 'tv', 283304).name === 'Little House on the Prairie: A New Beginning');
  check('an entry no copy points at isn\'t created', (await syncTitle(env, 'tv', 1, 'Ghost')) === true && !title(env, 'tv', 1));
  check('bad input is refused quietly', (await syncTitle(env, 'film', 5)) === false && (await syncTitle(env, 'tv', 'x')) === false);
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  check('a database error never throws', (await syncTitle(broken, 'tv', 283304)) === false);
}

console.log('\n== step 3b: writers write TMDB\'s payload directly');
{
  const env = makeEnv();
  // A member copy holding stale data, and a shared row built from it.
  show(env, { title: 'MobLand', tmdb: 247718, overview: 'stale', genres: 'Crime', seasons: 1, cast: ['Old Name'] });
  await rebuildTitles(env);
  const payload = {
    overview: 'Two mob families clash.', genres: 'Crime, Drama', seasonsReleased: 2, posterUrl: 'https://image.tmdb.org/m.jpg',
    tmdbRating: '8.5', tmdbStatus: 'Returning Series', flatrateNetworks: [], freeNetworks: null, tagline: null,
    actors: [{ name: 'Tom Hardy', imdb_id: 'nm0362766', ord: 0, tmdb_person_id: 2524, character: 'Harry' }, { name: 'Helen Mirren', ord: 1 }],
  };
  check('writes', await writeTitle(env, 'tv', 247718, { name: 'MobLand', fields: titleFieldsFromEnrichment(payload), cast: payload.actors }) === true);
  const t = title(env, 'tv', 247718);
  check('TMDB\'s values replace the stale ones', t.overview === 'Two mob families clash.' && t.genres === 'Crime, Drama' && t.seasons_released === 2 && t.poster_url === 'https://image.tmdb.org/m.jpg', JSON.stringify(t));
  check('rating and status follow', t.rating === '8.5' && t.tmdb_rating === '8.5' && t.tmdb_status === 'Returning Series' && t.full_series === 0);
  check('"streams nowhere" is a value, not a gap', t.streaming_on === '');
  check('a field the payload lacks keeps what\'s stored', t.free_on === null && t.name === 'MobLand');
  check('the cast is replaced by TMDB\'s', cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren', cast(env, 'tv', 247718));
  check('with characters and links', env._db.prepare("SELECT character_name AS c, imdb_id AS i FROM title_cast WHERE name = 'Tom Hardy'").get().c === 'Harry');

  await rebuildTitles(env);
  check('the nightly rebuild doesn\'t undo it', title(env, 'tv', 247718).overview === 'Two mob families clash.' && cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren');

  await writeTitle(env, 'tv', 247718, { fields: { overview: null, vote_count: 900 } });
  check('a write without a name keeps the name', title(env, 'tv', 247718).name === 'MobLand' && title(env, 'tv', 247718).vote_count === 900);
  check('and null never blanks a field', title(env, 'tv', 247718).overview === 'Two mob families clash.');
  await writeTitle(env, 'tv', 247718, { cast: [] });
  check('an empty cast list keeps the cast', cast(env, 'tv', 247718) === 'Tom Hardy,Helen Mirren');

  const ended = titleFieldsFromEnrichment({ tmdbStatus: 'Ended' });
  check('an ended series is full_series', ended.full_series === 1 && !('overview' in ended));

  show(env, { title: 'Severance', tmdb: 95396, overview: 'Lumon.' });
  check('a new entry without TMDB\'s name starts from the copies', await writeTitle(env, 'tv', 95396, { fields: { vote_count: 5 } }) === true
    && title(env, 'tv', 95396).name === 'Severance' && title(env, 'tv', 95396).overview === 'Lumon.' && title(env, 'tv', 95396).vote_count === 5);
  check('an entry no copy points at and no name is refused', await writeTitle(env, 'tv', 4242, { fields: { vote_count: 1 } }) === false && !title(env, 'tv', 4242));
  check('bad input is refused', await writeTitle(env, 'film', 1, {}) === false);
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  check('a database error never throws', (await writeTitle(broken, 'tv', 1, { name: 'x' })) === false);
}

console.log('\n== the migration');
{
  const mig = readFileSync(join(repoRoot, 'migrations/076_titles.sql'), 'utf8');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  // 076 ran once, into an empty table, and is history. Its text no longer
  // matches the rebuild (which since learned that '' is an answer for
  // streaming_on), so what's pinned is what it does, below.
  check('the migration backfills titles and cast', /INSERT INTO titles/.test(mig) && /INSERT INTO title_cast/.test(mig));

  // Run it the way deploy does: on an existing database that has shows but
  // not yet the new tables.
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(join(repoRoot, 'schema.sql'), 'utf8')
    .replace(/CREATE TABLE IF NOT EXISTS titles \([\s\S]*?\n\);\n/, '')
    .replace(/CREATE TABLE IF NOT EXISTS title_cast \([\s\S]*?\n\);\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_title_cast_person[^\n]*\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_shows_tmdb[^\n]*\n/, '');
  db.exec(schema);
  check('the fixture database starts without the tables', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'titles'").get());
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, enrolled_via) VALUES ('a','A','A','X','email')`).run();
  db.prepare(`INSERT INTO shows (title, list, member_slug, tmdb_id, tmdb_type, overview) VALUES ('BEEF','loved','a',154385,'tv','Road rage.')`).run();
  db.prepare(`INSERT INTO actors (show_id, name, ord) VALUES (1, 'Ali Wong', 0)`).run();
  db.exec(mig);
  const row = db.prepare('SELECT * FROM titles').get();
  check('the migration creates and backfills', row && row.name === 'BEEF' && row.overview === 'Road rage.', JSON.stringify(row));
  check('including cast', db.prepare('SELECT COUNT(*) AS n FROM title_cast').get().n === 1);
  db.exec(mig);
  check('and is safe to run twice', db.prepare('SELECT COUNT(*) AS n FROM titles').get().n === 1);
}

console.log('\n== step 2: the view members read through');
{
  const env = makeEnv();
  const schemaCols = env._db.prepare("SELECT name FROM pragma_table_info('shows')").all().map((r) => r.name);
  const viewCols = env._db.prepare("SELECT name FROM pragma_table_info('shows_v')").all().map((r) => r.name);
  check('the view has exactly the columns of shows, in order', JSON.stringify(viewCols) === JSON.stringify(schemaCols), `${viewCols.length} vs ${schemaCols.length}`);
  check('and the module\'s column list matches schema.sql', JSON.stringify(SHOWS_COLUMNS) === JSON.stringify(schemaCols),
    schemaCols.filter((c) => !SHOWS_COLUMNS.includes(c)).join(',') || 'order differs');
  const mig = readFileSync(join(repoRoot, 'migrations/077_shows_view.sql'), 'utf8');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  check('migration 077 is viewSql()', norm(mig).includes(norm(viewSql())));
  check('the three per-member fields are kept out of the shared set', PER_COPY_FIELDS.every((f) => !SHARED_FIELDS.includes(f)));

  // Two members' copies of one entry, one with a stale member-typed title.
  const a = show(env, { title: 'Sopranos', member: 'a', tmdb: 1398, overview: 'old', notes: 'MINE', network: 'HBO Max', enriched: '2026-01-01 00:00:00' });
  const b = show(env, { title: 'The Sopranos', member: 'b', tmdb: 1398, overview: 'Tony.', network: 'Max', enriched: '2026-10-01 00:00:00' });
  env._db.prepare("UPDATE shows SET next_season_date = '2026-12-01', network_logo_url = 'https://image.tmdb.org/hbo.png' WHERE id = ?").run(a);
  const lone = show(env, { title: 'Unmatched Thing', member: 'c', overview: 'own text' });
  await syncTitle(env, 'tv', 1398, 'The Sopranos');
  const v = (id) => env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(id);
  check('every copy shows TMDB\'s name', v(a).title === 'The Sopranos' && v(b).title === 'The Sopranos', v(a).title);
  check('and the shared details', v(a).overview === 'Tony.');
  check('member fields stay the member\'s', v(a).notes === 'MINE' && v(a).network === 'HBO Max' && v(b).network === 'Max' && v(a).member_slug === 'a');
  check('so do the per-member fields', v(a).next_season_date === '2026-12-01' && v(b).next_season_date === null && v(a).network_logo_url === 'https://image.tmdb.org/hbo.png' && v(b).network_logo_url === null);
  check('a row with no shared entry reads as itself', v(lone).title === 'Unmatched Thing' && v(lone).overview === 'own text');
  check('the raw table is untouched', env._db.prepare('SELECT title FROM shows WHERE id = ?').get(a).title === 'Sopranos');
}

console.log('\n== step 3a: the cast view');
{
  const env = makeEnv();
  const actorCols = env._db.prepare("SELECT name FROM pragma_table_info('actors')").all().map((r) => r.name);
  const viewCols = env._db.prepare("SELECT name FROM pragma_table_info('actors_v')").all().map((r) => r.name);
  check('actors_v has exactly the columns of actors', JSON.stringify(viewCols) === JSON.stringify(actorCols) && JSON.stringify(ACTORS_COLUMNS) === JSON.stringify(actorCols), viewCols.join(','));
  const mig = readFileSync(join(repoRoot, 'migrations/078_actors_view.sql'), 'utf8');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  check('migration 078 is actorsViewSql()', norm(mig).includes(norm(actorsViewSql())));

  // Two copies of one entry: one has a short cast, the other the full one.
  const a = show(env, { title: 'BEEF', member: 'a', tmdb: 154385, cast: ['Ali Wong'] });
  const b = show(env, { title: 'BEEF', member: 'b', tmdb: 154385, cast: ['Ali Wong', 'Steven Yeun', 'Joseph Lee'] });
  const lone = show(env, { title: 'Unmatched', member: 'c', cast: ['Someone Local'] });
  await syncTitle(env, 'tv', 154385, 'BEEF');
  const castOf = (id) => env._db.prepare('SELECT name FROM actors_v WHERE show_id = ? ORDER BY ord').all(id).map((r) => r.name).join(',');
  check('every copy reads the shared, fullest cast', castOf(a) === 'Ali Wong,Steven Yeun,Joseph Lee' && castOf(b) === castOf(a), castOf(a));
  check('a copy whose entry has no shared cast reads its own', castOf(lone) === 'Someone Local');
  check('a copy is never shown both lists', env._db.prepare('SELECT COUNT(*) AS n FROM actors_v WHERE show_id = ?').get(a).n === 3);

  // A name the people bank can link is linked on the shared cast too.
  env._db.prepare("INSERT INTO people (tmdb_person_id, name, name_lower, imdb_id) VALUES (77, 'Steven Yeun', 'steven yeun', 'nm1890784')").run();
  const { fillActorIdsFromKnownPeople } = await import(join(sandbox, 'functions', '_shared/people.js'));
  await fillActorIdsFromKnownPeople(env);
  const linked = env._db.prepare("SELECT imdb_id FROM actors_v WHERE show_id = ? AND name = 'Steven Yeun'").get(a);
  check('the people bank links the shared cast as well', linked && linked.imdb_id === 'nm1890784', JSON.stringify(linked));
}

console.log('\n== \'\' is an answer, not a gap');
{
  const env = makeEnv();
  show(env, { title: 'A Film', movie: true, tmdb: 5001 });
  env._db.prepare("UPDATE shows SET streaming_on = '', free_on = '', tmdb_status = '' WHERE tmdb_id = 5001").run();
  await rebuildTitles(env);
  const t = title(env, 'movie', 5001);
  check('the rebuild keeps "asked, none" for streaming, free services and status', t.streaming_on === '' && t.free_on === '' && t.tmdb_status === '', JSON.stringify(t));
  // Migration 079 repairs rows built before that rule.
  env._db.prepare('UPDATE titles SET streaming_on = NULL, free_on = NULL, tmdb_status = NULL').run();
  env._db.exec(readFileSync(join(repoRoot, 'migrations/079_titles_empty_answers.sql'), 'utf8'));
  const r = title(env, 'movie', 5001);
  check('migration 079 fills them from the copies', r.streaming_on === '' && r.free_on === '' && r.tmdb_status === '', JSON.stringify(r));
  env._db.prepare("UPDATE titles SET streaming_on = 'Netflix'").run();
  env._db.exec(readFileSync(join(repoRoot, 'migrations/079_titles_empty_answers.sql'), 'utf8'));
  check('and never overwrites a value', title(env, 'movie', 5001).streaming_on === 'Netflix');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
const { syncTitle, rebuildTitles, rebuildSql, TITLE_FIELDS } = await import(join(sandbox, 'functions', '_shared/titles.js'));

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
  check('a later sync picks up new data', title(env, 'tv', 283304).overview === 'New text');
  check('a sync without a name keeps TMDB\'s name rather than a member\'s title', title(env, 'tv', 283304).name === 'Little House on the Prairie', title(env, 'tv', 283304).name);
  await rebuildTitles(env);
  check('so does the rebuild', title(env, 'tv', 283304).name === 'Little House on the Prairie');
  await syncTitle(env, 'tv', 283304, 'Little House on the Prairie: A New Beginning');
  check('a new name from TMDB replaces it', title(env, 'tv', 283304).name === 'Little House on the Prairie: A New Beginning');
  check('an entry no copy points at isn\'t created', (await syncTitle(env, 'tv', 1, 'Ghost')) === true && !title(env, 'tv', 1));
  check('bad input is refused quietly', (await syncTitle(env, 'film', 5)) === false && (await syncTitle(env, 'tv', 'x')) === false);
  const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
  check('a database error never throws', (await syncTitle(broken, 'tv', 283304)) === false);
}

console.log('\n== the migration');
{
  const mig = readFileSync(join(repoRoot, 'migrations/076_titles.sql'), 'utf8');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const [upsert, castStmt] = rebuildSql();
  check('the backfill is rebuildTitles()\'s upsert', norm(mig).includes(norm(upsert)));
  check('and its cast fill', norm(mig).includes(norm(castStmt)));

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

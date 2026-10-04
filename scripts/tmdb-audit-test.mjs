// Tests for scripts/tmdb-audit.mjs, the read-only "how far is the library
// from one TMDB entry per show" report.
//
//   node scripts/tmdb-audit-test.mjs
//
// Runs the real script against a SQLite file built from schema.sql (--db) and
// a fake TMDB on a local port (TMDB_BASE), and checks what it decides:
//
//   - a row with no id is "copyable" only when exactly one entry is pinned
//     under its name, "ambiguous" when a remake and its original both are,
//     and a "(YYYY)" suffix picks between them;
//   - copies of one entry with different titles, a movie flag that disagrees
//     with the pin, titles that differ from TMDB's official name, and pins
//     TMDB no longer serves are all reported;
//   - it never reads memos or emails, and it refuses anything but a SELECT.

import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'tmdb-audit-'));
const dbFile = join(dir, 'shows.sqlite');
const jsonFile = join(dir, 'report.json');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fixture ----

const db = new DatabaseSync(dbFile);
db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
for (const [slug, disabled] of [['amy', 0], ['eric', 0], ['christine', 0], ['banned', 1]]) {
  db.prepare(`INSERT INTO members (slug, name, first_name, last_name, disabled, enrolled_via) VALUES (?, ?, ?, 'X', ?, 'email')`)
    .run(slug, `${slug}'s Shows`, slug, disabled);
}
let nextId = 1;
const ids = {};
function show(key, member, title, o = {}) {
  db.prepare(`INSERT INTO shows (id, title, list, member_slug, movie, archived, tmdb_id, tmdb_type, release_year, overview, poster_url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nextId, title, o.list || 'watching', member, o.movie ? 1 : 0,
    o.archived ? 1 : 0, o.tmdb ?? null, o.tmdb ? (o.type || (o.movie ? 'movie' : 'tv')) : null, o.year ?? null,
    o.overview ?? null, o.poster ?? null, o.notes ?? null);
  ids[key] = nextId++;
}
// Two entries share "Little House on the Prairie".
show('lh1974', 'amy', 'Little House on the Prairie', { tmdb: 1234, year: 1974, overview: 'Old.', poster: 'https://image.tmdb.org/t/p/w500/a.jpg' });
show('lh2026', 'eric', 'Little House on the Prairie', { tmdb: 283304, year: 2026, overview: 'New one, longer overview.', poster: 'https://image.tmdb.org/t/p/w500/b.jpg' });
show('lh2026b', 'christine', 'Little House on the Prairie (2026)', { tmdb: 283304, year: 2026, overview: 'New one, longer overview.', poster: 'https://image.tmdb.org/t/p/w500/b.jpg' });
show('lhBare', 'christine', 'little house on the prairie ', { archived: true });       // ambiguous
show('lhYear', 'amy', 'Little House on the Prairie (1974)', {});                         // year picks 1974
// One entry, so a copy is unambiguous.
show('sev1', 'amy', 'Severance', { tmdb: 95396, year: 2022 });
show('sevCopy', 'eric', 'severance', { notes: 'SECRET MEMO' });                           // copyable
// Nothing to copy.
show('special', 'christine', 'RuneScape: Back in Action', { list: 'recommending' });     // none
// Film saved as TV but pinned to a movie entry.
show('fh', 'christine', 'Frances Ha', { tmdb: 999, type: 'movie', year: 2012 });         // type mismatch
// Dead pin, and a disabled member who must not count.
show('dead', 'amy', 'Gone Show', { tmdb: 4040, year: 2001 });
show('banned', 'banned', 'Banned Show', {});
db.close();

// ---- fake TMDB ----

const NAMES = { 'tv:1234': 'Little House on the Prairie', 'tv:283304': 'Little House on the Prairie',
  'tv:95396': 'Severance', 'movie:999': 'Frances Ha' };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer test-token') return send(401, {});
  let m = u.pathname.match(/^\/(tv|movie)\/(\d+)$/);
  if (m) {
    const name = NAMES[`${m[1]}:${m[2]}`];
    return name ? send(200, m[1] === 'movie' ? { id: +m[2], title: name } : { id: +m[2], name }) : send(404, {});
  }
  m = u.pathname.match(/^\/search\/(tv|movie)$/);
  if (m) {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    if (m[1] === 'tv' && q.startsWith('runescape')) return send(200, { results: [{ id: 7777, name: 'RuneScape: Back in Action', first_air_date: '2023-01-01' }] });
    return send(200, { results: [] });
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function runAudit(extraArgs, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(repoRoot, 'scripts/tmdb-audit.mjs'), '--db', dbFile, '--all', ...extraArgs],
      { env: { ...process.env, TMDB_TOKEN: '', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// ---- scenarios ----

console.log('\n== database-only audit');
{
  const { code, out, err } = await runAudit(['--json', jsonFile]);
  check('runs cleanly', code === 0, err);
  const r = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const st = (key) => r.unpinned.find((u) => u.id === ids[key]);
  check('counts only active members', r.summary.rows === 10 && r.summary.unpinned === 4, JSON.stringify(r.summary));
  check('a title pinned to one entry elsewhere is copyable', st('sevCopy')?.status === 'copyable' && st('sevCopy').candidates[0].tmdb_id === 95396, JSON.stringify(st('sevCopy')));
  check('a title pinned to two entries is ambiguous', st('lhBare')?.status === 'ambiguous' && st('lhBare').candidates.length === 2, JSON.stringify(st('lhBare')));
  check('a "(YYYY)" suffix picks its own entry', st('lhYear')?.status === 'copyable' && st('lhYear').candidates[0].tmdb_id === 1234, JSON.stringify(st('lhYear')));
  check('a title no copy vouches for is "none"', st('special')?.status === 'none');
  check('the disabled member\'s row is left out', !r.unpinned.some((u) => u.member === 'banned'));
  check('copies of one entry under different titles are reported',
    r.title_splits.length === 1 && r.title_splits[0].tmdb_id === 283304 && r.title_splits[0].titles === 2, JSON.stringify(r.title_splits));
  check('a movie flag that disagrees with the pin is reported',
    r.type_mismatch.length === 1 && r.type_mismatch[0].id === ids.fh, JSON.stringify(r.type_mismatch));
  check('reports copies whose show has no shared row yet', r.normalization.rows === 6 && r.normalization.rows_without_entry === 6, JSON.stringify(r.normalization));
  check('and that the leftover per-copy columns are still there', r.normalization.leftover_columns === 3);
  check('no memo text anywhere in the output', !out.includes('SECRET MEMO') && !readFileSync(jsonFile, 'utf8').includes('SECRET MEMO'));
  check('without a token it says what TMDB would add', /Set TMDB_TOKEN/.test(out));
}

console.log('\n== with TMDB');
{
  const { code, out, err } = await runAudit(['--json', jsonFile], { TMDB_TOKEN: 'test-token', TMDB_BASE: base });
  check('runs cleanly', code === 0, err);
  const r = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const mm = r.name_mismatch.map((m) => m.id).sort((a, b) => a - b);
  check('titles that differ from TMDB\'s name are listed', JSON.stringify(mm) === JSON.stringify([ids.lh2026b]), JSON.stringify(r.name_mismatch));
  check('with the official name beside them', r.name_mismatch[0]?.tmdb_name === 'Little House on the Prairie');
  check('a pin TMDB no longer serves is reported', r.dead_pins.length === 1 && r.dead_pins[0].tmdb_id === 4040, JSON.stringify(r.dead_pins));
  const special = r.unpinned.find((u) => u.id === ids.special);
  check('an unmatched row gets a suggestion, labelled as one', special.suggestion?.tmdb_id === 7777 && /TMDB suggests/.test(out), JSON.stringify(special));
}

console.log('\n== read-only');
{
  const src = readFileSync(join(repoRoot, 'scripts/tmdb-audit.mjs'), 'utf8');
  check('the query helper refuses anything but SELECT', /SELECT only/.test(src) && /\^\\s\*\(SELECT\|WITH\)/.test(src));
  check('it never selects memos or emails', !/s\.notes|watching_with|recommended_by|added_by|member_emails/.test(src));
}

server.close();
try { unlinkSync(dbFile); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

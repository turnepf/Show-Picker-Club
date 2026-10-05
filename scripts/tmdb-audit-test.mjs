// Tests for scripts/tmdb-audit.mjs, the read-only "how far is the library
// from one TMDB entry per show" report.
//
//   node scripts/tmdb-audit-test.mjs
//
// Runs the real script against a SQLite file built from schema.sql (--db) and
// a fake TMDB on a local port (TMDB_BASE). The database is production's shape
// since 2026-10: a copy has no title of its own, so every name comes from the
// shared `titles` row. It checks that the audit reports:
//
//   - a copy with no TMDB id (there should be none);
//   - a copy that would show nameless: no shared row, or one with no name;
//   - a movie flag that disagrees with the pin;
//   - with TMDB: a shared name that differs from TMDB's official one, and a
//     pin TMDB no longer serves;
//   - and that it never reads memos or emails, and refuses anything but a
//     SELECT.

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
const entry = (type, id, name) =>
  db.prepare('INSERT INTO titles (tmdb_type, tmdb_id, name) VALUES (?, ?, ?)').run(type, id, name);
let nextId = 1;
const ids = {};
function copy(key, member, o = {}) {
  db.prepare(`INSERT INTO shows (id, list, member_slug, movie, archived, tmdb_id, tmdb_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(nextId, o.list || 'watching', member, o.movie ? 1 : 0,
    o.archived ? 1 : 0, o.tmdb ?? null, o.tmdb ? (o.type || (o.movie ? 'movie' : 'tv')) : null, o.notes ?? null);
  ids[key] = nextId++;
}
entry('tv', 95396, 'Severance');
entry('tv', 283304, 'Little House on the Prairie (2026)');   // TMDB's name is the bare one
entry('movie', 999, 'Frances Ha');
entry('tv', 4040, 'Gone Show');
entry('tv', 5050, '');                                         // a row with no name
copy('sev1', 'amy', { tmdb: 95396 });
copy('sev2', 'eric', { tmdb: 95396, notes: 'SECRET MEMO' });
copy('lh', 'christine', { tmdb: 283304 });
copy('fh', 'christine', { tmdb: 999, type: 'movie' });        // saved as TV, pinned to a film
copy('dead', 'amy', { tmdb: 4040 });                           // TMDB no longer serves it
copy('noRow', 'eric', { tmdb: 6060 });                         // no shared row at all
copy('noName', 'amy', { tmdb: 5050 });                         // a shared row with no name
copy('legacy', 'christine', {});                               // no TMDB id
copy('banned', 'banned', {});                                  // disabled member: not counted
db.close();

// ---- fake TMDB ----

const NAMES = { 'tv:283304': 'Little House on the Prairie', 'tv:95396': 'Severance', 'movie:999': 'Frances Ha',
  'tv:5050': 'Something' };
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
  check('counts only active members', r.summary.rows === 8 && r.summary.unpinned === 1, JSON.stringify(r.summary));
  check('a copy with no TMDB id is listed', r.unpinned.length === 1 && r.unpinned[0].id === ids.legacy, JSON.stringify(r.unpinned));
  check('the disabled member\'s copy is left out', !r.unpinned.some((u) => u.member === 'banned'));
  const nameless = Object.fromEntries(r.nameless.map((n) => [n.id, n.problem]));
  check('a copy whose entry has no shared row would show nameless', nameless[ids.noRow] === 'no shared row', JSON.stringify(r.nameless));
  check('and so would one whose shared row has no name', nameless[ids.noName] === 'no name');
  check('named copies are fine', r.nameless.length === 2);
  check('a movie flag that disagrees with the pin is reported, with the shared name',
    r.type_mismatch.length === 1 && r.type_mismatch[0].id === ids.fh && r.type_mismatch[0].title === 'Frances Ha', JSON.stringify(r.type_mismatch));
  check('no leftover columns on production\'s shape, the copy title included',
    r.normalization.leftover_columns === 0 && r.normalization.copy_title_column === 0 && /No leftover per-copy columns/.test(out),
    JSON.stringify(r.normalization));
  check('no memo text anywhere in the output', !out.includes('SECRET MEMO') && !readFileSync(jsonFile, 'utf8').includes('SECRET MEMO'));
  check('without a token it says what TMDB would add', /Set TMDB_TOKEN/.test(out));
}

console.log('\n== with TMDB');
{
  const { code, err } = await runAudit(['--json', jsonFile], { TMDB_TOKEN: 'test-token', TMDB_BASE: base });
  check('runs cleanly', code === 0, err);
  const r = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const mm = r.name_mismatch.map((m) => `${m.tmdb_type}:${m.tmdb_id}`).sort();
  check('a shared name that differs from TMDB\'s is listed', JSON.stringify(mm) === JSON.stringify(['tv:283304', 'tv:5050']), JSON.stringify(r.name_mismatch));
  check('with the official name beside it', r.name_mismatch.find((m) => m.tmdb_id === 283304)?.tmdb_name === 'Little House on the Prairie');
  check('a pin TMDB no longer serves is reported', r.dead_pins.length === 1 && r.dead_pins[0].tmdb_id === 4040, JSON.stringify(r.dead_pins));
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

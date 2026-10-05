// How far the library is from "every show is a TMDB entry, named the way TMDB
// names it". Read-only: it runs SELECTs and TMDB GETs, and writes nothing
// anywhere except an optional local JSON report.
//
//   node scripts/tmdb-audit.mjs
//   node scripts/tmdb-audit.mjs --json tmdb-audit.json
//   TMDB_TOKEN=… node scripts/tmdb-audit.mjs
//   node scripts/tmdb-audit.mjs --db path/to/copy.sqlite
//
// Without --db it reads production D1 through `npx wrangler d1 execute
// shows-db --remote`, so it needs whatever wrangler already uses on this
// machine (`wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).
// --db reads a local SQLite file instead: a restored backup, or the test
// fixture.
//
// Since 2026-10 every copy is a TMDB entry with no title of its own: an add
// TMDB can't identify is refused, and a show's name is TMDB's, on its shared
// row. So the audit checks that this holds:
//
//   1. Copies with no tmdb_id. There should be none; any listed predates the
//      rule or slipped past it.
//   2. Copies whose entry has no shared row, or a row with no name: with no
//      title of its own, such a copy would show nameless.
//   3. Copies whose movie flag disagrees with the type of their entry.
//   4. With TMDB_TOKEN set: shared rows whose name differs from TMDB's
//      official one, and pins TMDB no longer serves (404).
//   5. Leftovers the cleanups remove: per-copy fact columns, a per-copy
//      title, old per-copy cast rows.
//
// Member memos (notes, watching-with, recommended-by) and login emails are
// never selected.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const DB_FILE = opt('--db');
const JSON_OUT = opt('--json');
const TMDB_TOKEN = flag('--no-tmdb') ? null : (process.env.TMDB_TOKEN || null);
const TMDB_BASE = process.env.TMDB_BASE || 'https://api.themoviedb.org/3';
const SHOW_ALL = flag('--all');
const LIMIT = SHOW_ALL ? Infinity : 40;

// ---- reading the database ----

let sqlite = null;
if (DB_FILE) {
  const { DatabaseSync } = await import('node:sqlite');
  sqlite = new DatabaseSync(DB_FILE, { readOnly: true });
}

function query(sql) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('read-only: SELECT only');
  if (sqlite) return sqlite.prepare(sql).all().map((r) => ({ ...r }));
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'shows-db', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`wrangler failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').trim()}`);
  }
  // wrangler can print a banner before the JSON.
  const start = r.stdout.indexOf('[');
  const parsed = JSON.parse(r.stdout.slice(start));
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  if (block && block.success === false) throw new Error(`D1 error: ${JSON.stringify(block)}`);
  return (block && block.results) || [];
}

// ---- TMDB (optional) ----

async function tmdb(path, attempt = 0) {
  const res = await fetch(`${TMDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
  });
  if (res.status === 429 && attempt < 5) {
    const wait = (Number(res.headers.get('Retry-After')) || 1 + attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return tmdb(path, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  return res.json();
}

// A few at a time, so a thousand entries don't trip TMDB's rate limit.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- the audit ----

const ACTIVE_MEMBER = `JOIN members m ON m.slug = s.member_slug AND COALESCE(m.disabled, 0) = 0`;
const TYPE_OF = `COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;
const ENTRY = `LEFT JOIN titles t ON t.tmdb_id = s.tmdb_id AND t.tmdb_type = ${TYPE_OF}`;
const report = { generated_at: new Date().toISOString(), source: DB_FILE ? `file:${DB_FILE}` : 'production D1' };

const [summary] = query(`SELECT COUNT(*) AS rows,
    COUNT(DISTINCT s.member_slug) AS members,
    SUM(s.tmdb_id IS NOT NULL) AS pinned,
    SUM(s.tmdb_id IS NULL) AS unpinned,
    COUNT(DISTINCT CASE WHEN s.tmdb_id IS NOT NULL THEN ${TYPE_OF} || ':' || s.tmdb_id END) AS entries
  FROM shows s ${ACTIVE_MEMBER}`);
report.summary = summary;

report.unpinned = query(`SELECT s.id, s.member_slug AS member, s.movie, COALESCE(s.archived, 0) AS archived, s.list
  FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NULL ORDER BY s.member_slug, s.id`);

report.nameless = query(`SELECT s.id, s.member_slug AS member, ${TYPE_OF} AS tmdb_type, s.tmdb_id,
    CASE WHEN t.tmdb_id IS NULL THEN 'no shared row' ELSE 'no name' END AS problem
  FROM shows s ${ACTIVE_MEMBER} ${ENTRY}
  WHERE s.tmdb_id IS NOT NULL AND (t.tmdb_id IS NULL OR COALESCE(TRIM(t.name), '') = '')
  ORDER BY s.member_slug, s.id`);

report.type_mismatch = query(`SELECT s.id, s.member_slug AS member, t.name AS title, s.movie, s.tmdb_type, s.tmdb_id
  FROM shows s ${ACTIVE_MEMBER} ${ENTRY}
  WHERE s.tmdb_id IS NOT NULL AND ((s.tmdb_type = 'movie' AND COALESCE(s.movie, 0) = 0) OR (s.tmdb_type = 'tv' AND s.movie = 1))
  ORDER BY LOWER(t.name)`);

const [norm] = query(`SELECT
    (SELECT COUNT(*) FROM titles) AS entries,
    (SELECT COUNT(*) FROM title_cast) AS cast_rows,
    (SELECT COUNT(*) FROM actors) AS leftover_actor_rows,
    (SELECT COUNT(*) FROM pragma_table_info('shows') WHERE name IN ('overview', 'poster_url', 'genres')) AS leftover_columns,
    (SELECT COUNT(*) FROM pragma_table_info('shows') WHERE name = 'title') AS copy_title_column`);
report.normalization = norm;

// Official names (optional).
if (TMDB_TOKEN) {
  const entries = query(`SELECT tmdb_type, tmdb_id, name FROM titles WHERE tmdb_type IN ('tv', 'movie')`);
  process.stderr.write(`Looking up ${entries.length} TMDB entries…\n`);
  const names = new Map();
  let done = 0;
  await pool(entries, 5, async (e) => {
    const d = await tmdb(`/${e.tmdb_type}/${e.tmdb_id}?language=en-US`);
    names.set(`${e.tmdb_type}:${e.tmdb_id}`, d ? (e.tmdb_type === 'movie' ? d.title : d.name) : null);
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${entries.length}\n`);
  });
  report.dead_pins = entries.filter((e) => names.get(`${e.tmdb_type}:${e.tmdb_id}`) === null);
  report.name_mismatch = entries
    .map((e) => ({ ...e, tmdb_name: names.get(`${e.tmdb_type}:${e.tmdb_id}`) }))
    .filter((e) => e.tmdb_name && e.tmdb_name !== e.name);
}

// ---- printing ----

const line = (s = '') => console.log(s);
const flagOf = (r) => [r.archived ? 'archived' : r.list, r.movie ? 'movie' : 'tv'].join(', ');
function section(title, rows, fmt) {
  line(`\n== ${title} (${rows.length})`);
  for (const r of rows.slice(0, LIMIT)) line(`  ${fmt(r)}`);
  if (rows.length > LIMIT) line(`  … ${rows.length - LIMIT} more (--all to list them, or --json for everything)`);
}

const s = report.summary;
line(`TMDB audit — ${report.source}`);
line(`${s.rows} shows across ${s.members} members: ${s.pinned} have a TMDB id, ${s.unpinned} don't.`);
line(`${s.entries} distinct TMDB entries.`);

section('Copies with no TMDB id (should be none)', report.unpinned, (r) =>
  `#${r.id} ${r.member} (${flagOf(r)})`);
section('Copies that would show nameless: no shared row, or one with no name', report.nameless, (r) =>
  `#${r.id} ${r.member} · ${r.tmdb_type}:${r.tmdb_id} · ${r.problem}`);
section('Movie flag disagrees with the pinned entry\'s type', report.type_mismatch, (r) =>
  `#${r.id} ${r.member} · "${r.title}" saved as ${r.movie ? 'movie' : 'tv'}, pinned to ${r.tmdb_type}:${r.tmdb_id}`);

if (TMDB_TOKEN) {
  section('Shared name differs from TMDB\'s official name', report.name_mismatch, (r) =>
    `${r.tmdb_type}:${r.tmdb_id} "${r.name}" → "${r.tmdb_name}"`);
  section('Pinned to an entry TMDB no longer serves', report.dead_pins, (r) =>
    `${r.tmdb_type}:${r.tmdb_id} "${r.name}"`);
} else {
  line('\n(Set TMDB_TOKEN to also compare every name with TMDB\'s official one and find dead pins.)');
}

const n = report.normalization;
line('\n== Shared show rows');
line(`  ${s.pinned} pinned copies → ${n.entries} shows; ${n.cast_rows} shared cast rows.`);
const leftovers = [
  n.leftover_columns ? 'per-copy fact columns' : null,
  n.copy_title_column ? 'a per-copy title column' : null,
  n.leftover_actor_rows ? `${n.leftover_actor_rows} old per-copy cast rows` : null,
].filter(Boolean);
line(leftovers.length
  ? `  Still on \`shows\`: ${leftovers.join(', ')}. Nothing reads them; the cleanup script drops them.`
  : '  No leftover per-copy columns.');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  line(`\nFull report written to ${JSON_OUT}`);
}

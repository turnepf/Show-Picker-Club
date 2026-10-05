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
// What it reports:
//
//   1. Rows with no tmdb_id, and for each one whether another member's copy
//      of the same title is pinned: "copyable" (exactly one entry, so the id
//      could simply be copied over), "ambiguous" (two entries share the title,
//      a remake next to its original, so a person has to pick), or "none".
//      A trailing "(YYYY)" in the title is used to pick between same-named
//      entries, and with TMDB_TOKEN set, a "none" row gets TMDB's best search
//      hit as a suggestion, never an answer.
//   2. Entries whose copies carry different titles ("Little House on the
//      Prairie" next to "Little House on the Prairie (2026)").
//   3. Rows whose movie flag disagrees with the type of entry they're pinned to.
//   4. With TMDB_TOKEN set: every pinned entry's official TMDB name, the copies
//      whose title differs from it, and pins TMDB no longer serves (404).
//   5. The shared rows (normalizing): shows, cast rows, copies whose show has
//      no shared row yet, and whether the leftover per-copy columns are gone.
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

// ---- title matching (mirrors the app's matcher: case and spaces ignored,
// a trailing "(YYYY)" is a year hint rather than part of the name) ----

function terms(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*\S)\s*\((\d{4})\)$/);
  return m ? { name: m[1].toLowerCase(), year: Number(m[2]) } : { name: t.toLowerCase(), year: null };
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
const report = { generated_at: new Date().toISOString(), source: DB_FILE ? `file:${DB_FILE}` : 'production D1' };

const [summary] = query(`SELECT COUNT(*) AS rows,
    COUNT(DISTINCT s.member_slug) AS members,
    SUM(s.tmdb_id IS NOT NULL) AS pinned,
    SUM(s.tmdb_id IS NULL) AS unpinned,
    SUM(s.tmdb_id IS NULL AND COALESCE(s.archived, 0) = 0) AS unpinned_active,
    COUNT(DISTINCT CASE WHEN s.tmdb_id IS NOT NULL THEN s.tmdb_type || ':' || s.tmdb_id END) AS entries
  FROM shows s ${ACTIVE_MEMBER}`);
report.summary = summary;

const unpinned = query(`SELECT s.id, s.member_slug AS member, s.title, s.movie, COALESCE(s.archived, 0) AS archived,
    s.list, NULL AS release_year, s.network, 0 AS has_poster
  FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NULL ORDER BY LOWER(s.title), s.member_slug`);
// (An unmatched copy has no shared row, so no year or poster: since the
// 2026-10-05 cleanup the copy can't hold them either.)

const pinnedTitles = query(`SELECT LOWER(TRIM(s.title)) AS ltitle, s.title, s.tmdb_id, s.tmdb_type,
    MIN(t.release_year) AS release_year, COUNT(*) AS copies
  FROM shows s ${ACTIVE_MEMBER}
  LEFT JOIN titles t ON t.tmdb_id = s.tmdb_id
    AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)
  WHERE s.tmdb_id IS NOT NULL
  GROUP BY LOWER(TRIM(s.title)), s.tmdb_id, s.tmdb_type`);

// name → the distinct entries pinned under that name
const byName = new Map();
for (const p of pinnedTitles) {
  const { name } = terms(p.title);
  const key = name;
  const list = byName.get(key) || [];
  if (!list.some((e) => e.tmdb_id === p.tmdb_id && e.tmdb_type === p.tmdb_type)) {
    list.push({ tmdb_id: p.tmdb_id, tmdb_type: p.tmdb_type, release_year: p.release_year, example_title: p.title });
  }
  byName.set(key, list);
}

const classified = unpinned.map((r) => {
  const { name, year } = terms(r.title);
  let candidates = byName.get(name) || [];
  const wantType = r.movie ? 'movie' : 'tv';
  // A "(YYYY)" suffix picks among same-named entries.
  if (candidates.length > 1 && year) {
    const hinted = candidates.filter((c) => c.release_year === year);
    if (hinted.length) candidates = hinted;
  }
  // Prefer entries of the row's own type when both exist.
  if (candidates.length > 1) {
    const sameType = candidates.filter((c) => c.tmdb_type === wantType);
    if (sameType.length) candidates = sameType;
  }
  const status = !candidates.length ? 'none' : candidates.length === 1 ? 'copyable' : 'ambiguous';
  const out = { ...r, archived: !!r.archived, has_poster: !!r.has_poster, status, candidates };
  if (status === 'copyable' && candidates[0].tmdb_type !== wantType) out.type_differs = true;
  return out;
});
report.unpinned = classified;

const titleSplits = query(`SELECT s.tmdb_type, s.tmdb_id, COUNT(*) AS copies,
    COUNT(DISTINCT s.title) AS titles, GROUP_CONCAT(DISTINCT s.title) AS title_list
  FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NOT NULL
  GROUP BY s.tmdb_type, s.tmdb_id HAVING COUNT(DISTINCT s.title) > 1
  ORDER BY copies DESC`);
report.title_splits = titleSplits;

const typeMismatch = query(`SELECT s.id, s.member_slug AS member, s.title, s.movie, s.tmdb_type, s.tmdb_id
  FROM shows s ${ACTIVE_MEMBER}
  WHERE s.tmdb_id IS NOT NULL AND ((s.tmdb_type = 'movie' AND COALESCE(s.movie, 0) = 0) OR (s.tmdb_type = 'tv' AND s.movie = 1))
  ORDER BY LOWER(s.title)`);
report.type_mismatch = typeMismatch;

// Normalizing (docs/ARCHITECTURE.md#titles): the show's facts live once per
// entry in `titles`, its cast in `title_cast`. The leftover per-copy columns
// were dropped 2026-10-05; the check stays so a database restored from an
// older backup says so.
const [norm] = query(`SELECT
    (SELECT COUNT(*) FROM titles) AS entries,
    (SELECT COUNT(*) FROM title_cast) AS cast_rows,
    (SELECT COUNT(*) FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NOT NULL) AS rows,
    (SELECT COUNT(*) FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM titles t WHERE t.tmdb_id = s.tmdb_id
         AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END))) AS rows_without_entry,
    (SELECT COUNT(*) FROM actors) AS leftover_actor_rows,
    (SELECT COUNT(*) FROM pragma_table_info('shows') WHERE name IN ('overview', 'poster_url', 'genres')) AS leftover_columns`);
report.normalization = norm;

// Official names (optional).
if (TMDB_TOKEN) {
  const pinned = query(`SELECT s.id, s.member_slug AS member, s.title, s.tmdb_type, s.tmdb_id, COALESCE(s.archived, 0) AS archived
    FROM shows s ${ACTIVE_MEMBER} WHERE s.tmdb_id IS NOT NULL AND s.tmdb_type IN ('tv', 'movie')`);
  const entries = [...new Map(pinned.map((p) => [`${p.tmdb_type}:${p.tmdb_id}`, p])).values()];
  process.stderr.write(`Looking up ${entries.length} TMDB entries…\n`);
  const names = new Map();
  let done = 0;
  await pool(entries, 5, async (e) => {
    const d = await tmdb(`/${e.tmdb_type}/${e.tmdb_id}?language=en-US`);
    names.set(`${e.tmdb_type}:${e.tmdb_id}`, d ? (e.tmdb_type === 'movie' ? d.title : d.name) : null);
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${entries.length}\n`);
  });
  report.dead_pins = entries.filter((e) => names.get(`${e.tmdb_type}:${e.tmdb_id}`) === null)
    .map((e) => ({ tmdb_type: e.tmdb_type, tmdb_id: e.tmdb_id, example_title: e.title }));
  report.name_mismatch = pinned
    .map((p) => ({ ...p, archived: !!p.archived, tmdb_name: names.get(`${p.tmdb_type}:${p.tmdb_id}`) }))
    .filter((p) => p.tmdb_name && p.tmdb_name !== p.title);

  // Suggestions for rows nothing in the club can vouch for.
  const none = classified.filter((r) => r.status === 'none');
  await pool(none, 5, async (r) => {
    const type = r.movie ? 'movie' : 'tv';
    const { name } = terms(r.title);
    const hit = async (t) => {
      const d = await tmdb(`/search/${t}?query=${encodeURIComponent(name)}&language=en-US`);
      const top = d && d.results && d.results[0];
      return top ? { tmdb_type: t, tmdb_id: top.id, tmdb_name: t === 'movie' ? top.title : top.name,
        date: (t === 'movie' ? top.release_date : top.first_air_date) || null } : null;
    };
    r.suggestion = (await hit(type)) || (await hit(type === 'movie' ? 'tv' : 'movie'));
  });
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
line(`${s.rows} shows across ${s.members} members: ${s.pinned} have a TMDB id, ${s.unpinned} don't (${s.unpinned_active} of those active).`);
line(`${s.entries} distinct TMDB entries.`);

const byStatus = (st) => classified.filter((r) => r.status === st);
section('No TMDB id, another copy has one: copyable', byStatus('copyable'), (r) =>
  `#${r.id} ${r.member} · "${r.title}" (${flagOf(r)}) → ${r.candidates[0].tmdb_type}:${r.candidates[0].tmdb_id}`
  + ` "${r.candidates[0].example_title}"${r.type_differs ? ' [entry is the other type]' : ''}`);
section('No TMDB id, same title pinned to more than one entry: needs a person', byStatus('ambiguous'), (r) =>
  `#${r.id} ${r.member} · "${r.title}" (${flagOf(r)}) → ${r.candidates.map((c) => `${c.tmdb_type}:${c.tmdb_id} (${c.release_year ?? '?'})`).join(' or ')}`);
section('No TMDB id, nothing in the club to copy', byStatus('none'), (r) =>
  `#${r.id} ${r.member} · "${r.title}" (${flagOf(r)})`
  + (r.suggestion ? ` → TMDB suggests ${r.suggestion.tmdb_type}:${r.suggestion.tmdb_id} "${r.suggestion.tmdb_name}" (${r.suggestion.date || 'no date'})`
    : TMDB_TOKEN ? ' → TMDB has no match' : ''));
section('One entry, different titles across copies', titleSplits, (r) =>
  `${r.tmdb_type}:${r.tmdb_id} · ${r.copies} copies · ${r.title_list.split(',').map((t) => `"${t}"`).join(' / ')}`);
section('Movie flag disagrees with the pinned entry\'s type', typeMismatch, (r) =>
  `#${r.id} ${r.member} · "${r.title}" saved as ${r.movie ? 'movie' : 'tv'}, pinned to ${r.tmdb_type}:${r.tmdb_id}`);

if (TMDB_TOKEN) {
  section('Title differs from TMDB\'s official name', report.name_mismatch, (r) =>
    `#${r.id} ${r.member} · "${r.title}" → "${r.tmdb_name}" (${r.tmdb_type}:${r.tmdb_id}${r.archived ? ', archived' : ''})`);
  section('Pinned to an entry TMDB no longer serves', report.dead_pins, (r) =>
    `${r.tmdb_type}:${r.tmdb_id} "${r.example_title}"`);
} else {
  line('\n(Set TMDB_TOKEN to also compare every title with TMDB\'s official name, find dead pins, and get suggestions for unmatched rows.)');
}

const n = report.normalization;
line('\n== Shared show rows');
line(`  ${n.rows} pinned copies → ${n.entries} shows; ${n.cast_rows} shared cast rows.`);
if (n.rows_without_entry) line(`  ${n.rows_without_entry} copies point at a show with no shared row (the nightly rebuild adds them).`);
line(n.leftover_columns
  ? `  Leftover per-copy columns are still on \`shows\`, and ${n.leftover_actor_rows} old per-copy cast rows: nothing reads them; the cleanup drops them.`
  : '  No leftover per-copy columns.');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  line(`\nFull report written to ${JSON_OUT}`);
}

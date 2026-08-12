#!/usr/bin/env node
//
// Everything the vibe pipeline knows about one member, end to end.
//
//   node scripts/vibe-diagnose.mjs            (defaults to paula)
//   node scripts/vibe-diagnose.mjs whitt
//   node scripts/vibe-diagnose.mjs paula --snapshot /tmp/paula.json
//   node scripts/vibe-diagnose.mjs paula --from /tmp/paula.json
//
// Reads a bounded, read-only snapshot out of the production D1 with
// `wrangler d1 execute --remote`, loads it into an in-memory SQLite built from
// schema.sql, and then runs the REAL `functions/api/vibe.js` handler against
// it. What it prints is what the member's app renders — not a re-implementation
// that can drift from the endpoint, and not a guess.
//
// It answers, in order:
//   1. Can the member reach their own vibe at all (the 2026-08 exclusion bug)?
//   2. What does the profile actually say — cluster, blend, traits, balance,
//      aligned picks, outliers?
//   3. What is it computed from, per list, and what is missing: titles with no
//      show_traits row (queue backlog, drains itself) versus titles scored
//      `unknown_show=1` (Claude couldn't identify them — these never drain and
//      need a rename in Show Cleanup).
//   4. Is the fix holding both ways — they see themselves, nobody else does?
//
// Read-only. Every statement is a SELECT; nothing writes to production. Member
// notes are never fetched, so the snapshot carries no private text.
//
// Requires `wrangler` on PATH and CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
// (or `wrangler login`). Node 22 for node:sqlite. `--from` replays a saved
// snapshot and needs neither.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'shows-db';

// ---- args ----

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const snapshotOut = flag('--snapshot');
const snapshotIn = flag('--from');
const slug = (argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--snapshot'
  && argv[argv.indexOf(a) - 1] !== '--from') || 'paula').toLowerCase();

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const h1 = (s) => console.log(`\n${bold(`== ${s}`)}`);
const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

// ---- snapshot ----

// Explicit column lists: `shows.notes` and the contact tables are deliberately
// not in here. A diagnostic doesn't need a member's private text to run.
const SHOW_COLS = [
  'id', 'title', 'list', 'member_slug', 'archived', 'added_by', 'created_at',
  'updated_at', 'network', 'network_url', 'rating', 'poster_url', 'movie',
  'seasons_released', 'full_series', 'next_season_date', 'genres',
].join(', ');

function queries() {
  return {
    members: `SELECT slug, name, first_name, last_initial, is_admin, disabled,
                     created_at, last_login_at, last_login_method
                FROM members`,
    groups: 'SELECT id, name, creator_slug FROM groups',
    group_members: 'SELECT group_id, member_slug FROM group_members',
    // Every row, archived included. The club-level queries only read active
    // ones, but the engagement check counts an archive as member intent, and
    // taking the whole table means one snapshot replays for ANY slug via
    // --from rather than only the one it was taken for.
    shows: `SELECT ${SHOW_COLS} FROM shows`,
    show_traits: 'SELECT * FROM show_traits',
    actors: `SELECT a.id, a.show_id, a.name FROM actors a
               JOIN shows s ON s.id = a.show_id WHERE s.archived = 0`,
  };
}

function wrangler(sql) {
  const args = ['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql];
  let out;
  try {
    out = execFileSync('wrangler', args, {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      out = execFileSync('npx', ['--yes', 'wrangler@latest', ...args], {
        encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      const detail = (e.stderr || e.stdout || String(e)).toString().trim().slice(0, 600);
      throw new Error(`wrangler failed:\n${detail}`);
    }
  }
  // Wrangler prints banners around the JSON often enough to be worth tolerating.
  const start = Math.min(...['[', '{'].map((c) => {
    const i = out.indexOf(c);
    return i === -1 ? Infinity : i;
  }));
  if (!Number.isFinite(start)) throw new Error(`No JSON in wrangler output:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
}

function takeSnapshot(who) {
  const tables = {};
  for (const [name, sql] of Object.entries(queries())) {
    process.stdout.write(dim(`  reading ${name}… `));
    tables[name] = wrangler(sql);
    process.stdout.write(dim(`${tables[name].length} rows\n`));
  }
  return { slug: who, taken_at: new Date().toISOString(), tables };
}

// ---- replay ----

function hydrate(snapshot) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      if (!cols.length) continue;
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      );
      stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
    }
  }
  return db;
}

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0) } };
  }
}

function sessionFor(db, who) {
  const id = `diagnose-${who}`;
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${who}@diagnose.local`, who, new Date(Date.now() + 3600_000).toISOString(),
        new Date().toISOString());
  return id;
}

const one = (db, sql, ...args) => db.prepare(sql).all(...args)[0] ?? {};
const many = (db, sql, ...args) => db.prepare(sql).all(...args);

// ---- run ----

const snapshot = snapshotIn
  ? JSON.parse(readFileSync(snapshotIn, 'utf8'))
  : (h1(`Snapshotting production D1 (read-only)`), takeSnapshot(slug));

if (snapshotOut) {
  writeFileSync(snapshotOut, JSON.stringify(snapshot, null, 2));
  console.log(dim(`  wrote ${snapshotOut}`));
}

const db = hydrate(snapshot);
const env = { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };

// The handler tree has to be importable as ESM; the repo has no package.json
// by design, so copy it beside one. Same trick the test suites use.
const sandbox = mkdtempSync(join(tmpdir(), 'vibe-diagnose-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
const vibe = await import(join(sandbox, 'functions', 'api', 'vibe.js'));
const { EXCLUDED_FROM_TASTE } = await import(join(sandbox, 'functions', '_shared', 'excluded-members.js'));

const ORIGIN = 'https://showpicker.club';
const askAs = async (viewer, target) => {
  const cookie = sessionFor(db, viewer);
  const path = target ? `/api/vibe?member=${encodeURIComponent(target)}` : '/api/vibe';
  const res = await vibe.onRequestGet({
    env,
    request: new Request(ORIGIN + path, { headers: { Cookie: `session=${cookie}` } }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
};

const member = one(db, 'SELECT * FROM members WHERE slug = ?', slug);
if (!member.slug) {
  console.error(`\nNo member row for "${slug}". Members: ` +
    many(db, 'SELECT slug FROM members ORDER BY slug').map((r) => r.slug).join(', '));
  process.exit(1);
}

h1('Who');
line('slug', member.slug);
line('name', `${member.name}${member.first_name ? ` (first_name "${member.first_name}")` : ''}`);
line('admin / disabled', `${member.is_admin ? 'admin' : 'member'} / ${member.disabled ? bold('DISABLED') : 'active'}`);
line('created', member.created_at || dim('—'));
line('last login', member.last_login_at
  ? `${member.last_login_at}${member.last_login_method ? ` (${member.last_login_method})` : ''}`
  : dim('never recorded'));
line('on the taste-exclusion list', EXCLUDED_FROM_TASTE.includes(slug) ? bold('yes') : 'no');
const groups = many(db,
  `SELECT g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.member_slug = ? ORDER BY g.name`, slug).map((r) => r.name);
line('groups', groups.length ? groups.join(', ') : dim('none'));

h1('Library');
const lib = one(db, `
  SELECT
    (SELECT COUNT(*) FROM shows WHERE member_slug = ?1 AND archived = 0) AS active,
    (SELECT COUNT(*) FROM shows WHERE member_slug = ?1 AND archived = 1) AS archived,
    (SELECT COUNT(*) FROM shows WHERE member_slug = ?1 AND COALESCE(added_by,'') = 'seed'
       AND archived = 0 AND updated_at IS NULL) AS untouched_seed`, slug);
line('active rows', lib.active);
line('archived rows', lib.archived);
line('untouched seed rows', lib.untouched_seed);

const perList = many(db, `
  SELECT s.list,
         COUNT(*) AS active,
         SUM(CASE WHEN t.title_lower IS NOT NULL AND COALESCE(t.unknown_show,0) = 0 THEN 1 ELSE 0 END) AS scored,
         SUM(CASE WHEN COALESCE(t.unknown_show,0) = 1 THEN 1 ELSE 0 END) AS unknown,
         SUM(CASE WHEN t.title_lower IS NULL THEN 1 ELSE 0 END) AS unscored
    FROM shows s
    LEFT JOIN show_traits t ON t.title_lower = LOWER(s.title)
   WHERE s.member_slug = ? AND s.archived = 0
   GROUP BY s.list ORDER BY s.list`, slug);
const LIST_LABEL = { recommending: 'Loved (weight 1.0)', watching: 'Watching (0.8)',
                     waiting: 'Awaiting (0.6)', next: 'Next Up (0.3)' };
console.log(dim('  list                         active  scored  unknown  unscored'));
for (const r of perList) {
  console.log(`  ${(LIST_LABEL[r.list] || r.list).padEnd(28)} ${String(r.active).padStart(6)} ` +
              `${String(r.scored).padStart(7)} ${String(r.unknown).padStart(8)} ${String(r.unscored).padStart(9)}`);
}

h1('What the endpoint returns for their own vibe');
const own = await askAs(slug, slug);
line('HTTP', own.status);
const m = own.body?.member;
const inOwnPicker = (own.body?.members || []).some((x) => x.slug === slug);
line('in their own picker', inOwnPicker ? 'yes' : bold('NO — the fix is not live here'));
line('picker also offers', (own.body?.members || []).filter((x) => x.slug !== slug)
  .map((x) => x.name).join(', ') || dim('nobody (no group-mates with libraries)'));

if (!m) {
  console.log(bold('  No member payload — see HTTP status above.'));
} else if (m.excluded) {
  console.log(bold('  STATE: "This member is excluded from taste analysis."'));
  console.log('  The exclusion is still being applied to their own slug. Deploy the fix.');
} else if (m.is_seed_only) {
  console.log(bold('  STATE: "Not enough activity yet to read a vibe."'));
  console.log('  Nothing in the library they chose themselves. Nothing to compute from.');
} else if (m.no_fingerprint) {
  console.log(bold('  STATE: "No scored shows yet."'));
  console.log(`  ${m.active_count} active shows, none with usable traits. See the queue below.`);
} else {
  line('STATE', bold('full profile'));
  line('computed from', `${m.scored_count} of ${m.active_count} active shows`);
  line('cluster', `${m.cluster.name} — ${Math.round(m.cluster.similarity * 100)}% match`);
  console.log(`  ${dim(m.cluster.tagline)}`);
  console.log(`  ${bold('blend')}`);
  for (const b of m.cluster.blend) line(`  ${b.name}`, `${Math.round(b.similarity * 100)}%`);
  console.log(`  ${bold('traits')}`);
  for (const [k, v] of Object.entries(m.display_traits)) {
    const bar = '█'.repeat(Math.round(v / 5)).padEnd(20, '·');
    line(`  ${k}`, `${bar} ${v}`);
  }
  console.log(`  ${bold('balance')}`);
  line('  warmth vs darkness', `${m.balance.warmth_darkness_label} (${m.balance.warmth_darkness_balance}/100)`);
  line('  genre range', `${m.balance.range}/100`);
  console.log(`  ${bold('aligned picks')}`);
  for (const p of m.aligned_picks) line(`  ${p.title}`, dim([p.network, p.genres].filter(Boolean).join(' · ')));
  if (!m.aligned_picks.length) console.log(dim('    none'));
  console.log(`  ${bold('outliers on their own list')}`);
  for (const p of m.outlier_picks) line(`  ${p.title}`, dim(p.list || ''));
  if (!m.outlier_picks.length) console.log(dim('    none'));
}

h1('What is missing, and whether it drains on its own');
const unscored = many(db, `
  SELECT MIN(s.title) AS title, COUNT(*) AS copies FROM shows s
   WHERE s.member_slug = ? AND s.archived = 0
     AND LOWER(s.title) NOT IN (SELECT title_lower FROM show_traits)
   GROUP BY LOWER(s.title) ORDER BY LOWER(s.title)`, slug);
const unknown = many(db, `
  SELECT MIN(s.title) AS title FROM shows s
    JOIN show_traits t ON t.title_lower = LOWER(s.title)
   WHERE s.member_slug = ? AND s.archived = 0 AND COALESCE(t.unknown_show,0) = 1
   GROUP BY LOWER(s.title) ORDER BY LOWER(s.title)`, slug);
const queue = one(db, `
  SELECT
    (SELECT COUNT(*) FROM (SELECT LOWER(title) FROM shows WHERE archived = 0
        AND LOWER(title) NOT IN (SELECT title_lower FROM show_traits)
        GROUP BY LOWER(title))) AS club_queue,
    (SELECT COUNT(*) FROM (SELECT LOWER(s.title) FROM shows s WHERE s.archived = 0
        AND LOWER(s.title) NOT IN (SELECT title_lower FROM show_traits)
        AND NOT EXISTS (SELECT 1 FROM shows o WHERE LOWER(o.title) = LOWER(s.title)
                          AND o.archived = 0 AND o.member_slug != ?1)
        AND s.member_slug = ?1
        GROUP BY LOWER(s.title))) AS hers_alone`, slug);
line('unscored titles (theirs)', `${unscored.length} ${dim('— queue backlog, drains itself')}`);
line('of those, only they hold', `${queue.hers_alone} ${dim('— unreachable by the old fill filter')}`);
line('club-wide fill queue', `${queue.club_queue} titles` +
  (queue.club_queue === unscored.length && unscored.length
    ? ` ${dim('— i.e. the whole club backlog is theirs')}` : ''));
line('scored unknown_show=1 (theirs)', `${unknown.length} ${dim('— never drains; needs a rename')}`);

const solo = one(db, `
  SELECT
    SUM(CASE WHEN shared THEN 1 ELSE 0 END) AS shared_titles,
    SUM(CASE WHEN shared THEN 0 ELSE 1 END) AS solo_titles
    FROM (SELECT LOWER(s.title) AS lt,
            EXISTS(SELECT 1 FROM shows o WHERE LOWER(o.title) = LOWER(s.title)
                     AND o.archived = 0 AND o.member_slug != ?1) AS shared
            FROM shows s JOIN show_traits t ON t.title_lower = LOWER(s.title)
           WHERE s.member_slug = ?1 AND s.archived = 0 AND COALESCE(t.unknown_show,0) = 0
           GROUP BY LOWER(s.title))`, slug);
// Both of these already counted: the fingerprint join asks show_traits for a
// row, never who else holds the title. What the old fill filter cost is
// the `hers_alone` unscored line above — titles it would never queue at all.
line('scored titles the club shares', solo.shared_titles ?? 0);
line('scored titles only they hold', `${solo.solo_titles ?? 0} ${dim('— scored while a copy was still elsewhere')}`);

if (unscored.length) {
  console.log(`\n  ${bold('Waiting on the scorer')} ${dim('(vibe-fill.yml runs every 15 min)')}`);
  for (const r of unscored.slice(0, 40)) console.log(`    · ${r.title}`);
  if (unscored.length > 40) console.log(dim(`    …and ${unscored.length - 40} more`));
}
if (unknown.length) {
  console.log(`\n  ${bold('Claude could not identify these — rename in Show Cleanup or they stay dark')}`);
  for (const r of unknown) console.log(`    · ${r.title}`);
}

h1('Is the fix holding both ways?');
const others = many(db,
  'SELECT slug FROM members WHERE slug != ? AND COALESCE(disabled,0) = 0 ORDER BY slug', slug)
  .map((r) => r.slug);
let leaks = 0;
for (const other of others) {
  const picker = await askAs(other, null);
  const forced = await askAs(other, slug);
  const listed = (picker.body?.members || []).some((x) => x.slug === slug);
  const readable = forced.status === 200 && forced.body?.member && !forced.body.member.excluded
                   && !!forced.body.member.cluster;
  if (listed || readable) {
    leaks++;
    console.log(`  ${bold('LEAK')} ${other}: ${listed ? 'sees them in the picker' : ''} ` +
                `${readable ? `reads the profile (HTTP ${forced.status})` : `blocked (HTTP ${forced.status})`}`);
  }
}
line('other members checked', others.length);
line('who can see this vibe', leaks === 0 ? bold('nobody — correct') : bold(`${leaks} — INVESTIGATE`));
line('who they can see', (own.body?.members || []).length - (inOwnPicker ? 1 : 0) + ' group-mate(s)');

h1('Verdict');
if (!m) {
  console.log('  The endpoint returned no member payload — start with the HTTP status.');
} else if (m.excluded) {
  console.log('  Still blocked. The deployed code is applying the exclusion to their own slug:');
  console.log('  confirm the fix reached production, then re-run.');
} else if (m.cluster) {
  const pct = m.active_count ? Math.round((m.scored_count / m.active_count) * 100) : 0;
  console.log(`  They have a vibe: ${bold(m.cluster.name)}, computed from ${m.scored_count}/${m.active_count}` +
              ` (${pct}%) of their active shows.`);
  if (unscored.length) {
    console.log(`  ${unscored.length} titles are still queued for scoring — the read sharpens as they land.`);
  }
  if (unknown.length) {
    console.log(`  ${unknown.length} title${unknown.length === 1 ? ' is' : 's are'} dark for good` +
                ' until the name is fixed in Show Cleanup.');
  }
} else {
  console.log('  They can reach the screen, but there is nothing to compute from yet — see above.');
}
console.log('');

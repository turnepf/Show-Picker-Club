// Shared plumbing for the offline vibe tools: pull a bounded, read-only
// snapshot of production D1 through `wrangler`, load it into an in-memory
// SQLite built from schema.sql, and expose a D1-shaped binding over it so the
// real Pages Functions can run against real data on a laptop.
//
// Used by scripts/vibe-diagnose.mjs and scripts/vibe-cluster-report.mjs.
// Every statement is a SELECT; `shows.notes` and the contact tables are never
// fetched, so a snapshot carries no member's private text.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_NAME = 'shows-db';

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
    // The whole table, archived included: the club-level queries read only
    // active rows, the engagement check counts an archive as member intent,
    // and taking everything means one snapshot replays for any slug.
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
  const start = Math.min(...['[', '{'].map((c) => {
    const i = out.indexOf(c);
    return i === -1 ? Infinity : i;
  }));
  if (!Number.isFinite(start)) throw new Error(`No JSON in wrangler output:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
}

export function takeSnapshot(slug, log = () => {}) {
  const tables = {};
  for (const [name, sql] of Object.entries(queries())) {
    log(`  reading ${name}… `);
    tables[name] = wrangler(sql);
    log(`${tables[name].length} rows\n`);
  }
  return { slug, taken_at: new Date().toISOString(), tables };
}

export function loadSnapshot(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveSnapshot(snapshot, path) {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export function hydrate(snapshot) {
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

export class Stmt {
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

export const envFor = (db) => ({ DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db });

// The functions tree has to be importable as ESM and the repo has no
// package.json by design, so copy it beside one. Same trick the test suites use.
export function functionsSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'vibe-tools-'));
  cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
  writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
  return (p) => import(join(sandbox, 'functions', p));
}

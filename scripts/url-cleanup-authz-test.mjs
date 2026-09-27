#!/usr/bin/env node
//
// Who may drive /api/admin-url-cleanup, and what the one scheduled action on
// it is allowed to decide.
//
// The endpoint is the operator's Show Cleanup page: dismissing a title out of
// the queue, overwriting a link, renaming a show, picking the winner among
// networks members disagree about. All of that is an admin session and
// nothing else.
//
// Two actions are exceptions, reachable with an X-Cron-Secret so a scheduled
// workflow can drive them without a session: `reclassify_storefronts` and —
// since 2026-09-22, when it stopped being a button and became the first step
// of watch-urls-fill.yml — `inherit_networks`. They qualify on the same two
// counts, and the cases below are those two counts written down:
//
//   1. They decide nothing. `inherit_networks` fills rows that have NO
//      network, and only where every other copy in the club already agrees
//      on one. A title whose copies disagree is skipped, not resolved — that
//      judgment stays with a human on the page. If that ever stopped being
//      true, a leaked cron secret would be able to overwrite what members
//      chose, which is the whole reason the allowance is an allowlist of two
//      rather than a flag on the endpoint.
//   2. They are idempotent. A second run finds nothing to do.
//
// No network, no container. Node 22 for node:sqlite.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'url-cleanup-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const api = await import(join(sandbox, 'functions', 'api/admin-url-cleanup.js'));

const ORIGIN = 'https://showpicker.club';
const SECRET = 'cron-secret-under-test';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

function makeEnv({ cronSecret = SECRET } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  const env = {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (s) => { for (const x of s) await x.run(); } },
    _db: db,
  };
  if (cronSecret) env.CRON_SECRET = cronSecret;
  return env;
}

function addMember(env, slug, { admin = false } = {}) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin) VALUES (?, ?, ?, ?)'
  ).run(slug, slug, slug, admin ? 1 : 0);
  env._db.prepare(
    'INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)'
  ).run(`${slug}@example.com`, slug);
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT OR IGNORE INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { title, member, network = null, url = null, list = 'watching' }) {
  env._db.prepare(
    'INSERT INTO shows (title, network, network_url, list, member_slug, archived) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(title, network, url, list, member);
}

const showRows = (env, title) =>
  env._db.prepare('SELECT network, network_url FROM shows WHERE LOWER(title) = LOWER(?) ORDER BY id').all(title);

// `cron` sends the header a workflow sends; `cookie` sends a session. Neither
// is the unauthenticated case.
function post(env, action, { cron, cookie, body = {} } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cron) headers['X-Cron-Secret'] = cron;
  if (cookie) headers.Cookie = `session=${cookie}`;
  const request = new Request(`${ORIGIN}/api/admin-url-cleanup`, {
    method: 'POST', headers, body: JSON.stringify({ action, ...body }),
  });
  return api.onRequestPost({ env, request, waitUntil: () => {} });
}

// ---------------------------------------------------------------------------

console.log('\n== the scheduled action runs on a cron secret alone');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addMember(env, 'quinn');
  addMember(env, 'stacy');
  // Two members agree the show is on Max; a third copy has no network at all.
  addShow(env, { title: 'Hacks', member: 'patrick', network: 'Max', url: 'https://play.max.com/show/hacks' });
  addShow(env, { title: 'Hacks', member: 'quinn', network: 'Max' });
  addShow(env, { title: 'Hacks', member: 'stacy' });

  const res = await post(env, 'inherit_networks', { cron: SECRET });
  const body = await res.json();
  check('the workflow is allowed in', res.status === 200, `got ${res.status}`);
  check('the orphan row adopted the network the club agrees on',
    showRows(env, 'Hacks').every((r) => r.network === 'Max'), JSON.stringify(showRows(env, 'Hacks')));
  check('and picked up a sibling URL in the same pass',
    showRows(env, 'Hacks').every((r) => r.network_url === 'https://play.max.com/show/hacks'),
    JSON.stringify(body));

  // Idempotence is half of why this is safe to schedule.
  const again = await post(env, 'inherit_networks', { cron: SECRET });
  const body2 = await again.json();
  check('a second run finds nothing to do',
    body2.networks_set === 0 && body2.urls_filled === 0, JSON.stringify(body2));
}

console.log('\n== it decides nothing a member disagrees about');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addMember(env, 'quinn');
  addMember(env, 'stacy');
  // The club disagrees: one copy says Netflix, one says Hulu, one is empty.
  addShow(env, { title: 'The Bear', member: 'patrick', network: 'Netflix' });
  addShow(env, { title: 'The Bear', member: 'quinn', network: 'Hulu' });
  addShow(env, { title: 'The Bear', member: 'stacy' });

  const body = await (await post(env, 'inherit_networks', { cron: SECRET })).json();
  const rows = showRows(env, 'The Bear');
  check('the contested title is skipped', body.networks_set === 0, JSON.stringify(body));
  check('the empty row is still empty', rows[2].network === null, JSON.stringify(rows));
  check('and nobody\'s answer was overwritten',
    rows[0].network === 'Netflix' && rows[1].network === 'Hulu', JSON.stringify(rows));
}

console.log('\n== the cron secret reaches those two actions and no others');
{
  const env = makeEnv();
  // Everything an operator has to be trusted with stays session-only. These
  // are the writes a leaked secret must not be able to reach.
  for (const action of ['dismiss', 'resolve_conflict', 'update', 'rename', 'list']) {
    const res = await post(env, action, { cron: SECRET, body: { title: 'Hacks', network: 'Max' } });
    check(`\`${action}\` refuses a cron secret`, res.status === 403, `got ${res.status}`);
  }
}

console.log('\n== a wrong or missing secret is not a secret');
{
  const env = makeEnv();
  const wrong = await post(env, 'inherit_networks', { cron: 'not-the-secret' });
  check('a wrong secret is refused', wrong.status === 403, `got ${wrong.status}`);

  const none = await post(env, 'inherit_networks');
  check('no secret at all is refused', none.status === 403, `got ${none.status}`);

  // cronAuthorized fails closed when CRON_SECRET isn't configured, so an
  // unconfigured deployment can't be driven by sending an empty header.
  const unconfigured = makeEnv({ cronSecret: null });
  const res = await post(unconfigured, 'inherit_networks', { cron: '' });
  check('an unconfigured CRON_SECRET never means open', res.status === 403, `got ${res.status}`);
}

console.log('\n== a session still has to be an admin session');
{
  const env = makeEnv();
  const member = addMember(env, 'stacy');
  const admin = addMember(env, 'patrick', { admin: true });

  const res = await post(env, 'inherit_networks', { cookie: member });
  check('a logged-in non-admin is refused', res.status === 403, `got ${res.status}`);

  const ok = await post(env, 'inherit_networks', { cookie: admin });
  check('an admin session still drives it by hand', ok.status === 200, `got ${ok.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

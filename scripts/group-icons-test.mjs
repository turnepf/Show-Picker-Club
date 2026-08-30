// Tests for group icons (migration 066) — the creator-picked SF Symbol and
// accent color on `groups`.
//
//   node scripts/group-icons-test.mjs
//
// The properties worth pinning are the write-path ones, because the clients
// deliberately don't re-validate what arrives:
//
//   1. The server is the gate: a value outside the curated sets is a 400 on
//      create and on PATCH, and nothing is stored.
//   2. PATCH semantics: an absent key leaves the stored value alone (a plain
//      rename can't wipe the icon), null clears it, and icon/color can ride
//      with or without a rename.
//   3. Creator-only, like rename — a group-mate who didn't create the group
//      gets 403.
//   4. Every group payload (list, detail, patch) carries icon and color.
//
// Same harness as scripts/group-suggestions-test.mjs: the functions tree is
// copied to a temp directory with a `type: module` package.json, and
// schema.sql is loaded into node:sqlite behind a thin D1 shim.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'group-icons-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const groupsApi = await load('api/groups.js');
const groupApi = await load('api/groups/[id].js');
const { GROUP_ICONS, GROUP_COLORS } = await load('_shared/group-icons.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite (see watching-with-test.mjs) ----

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
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

function addMember(env, slug, name) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial) VALUES (?, ?, ?, ?, ?)'
  ).run(slug, name, first, last || null, last ? last.charAt(0) : null);
  env._db.prepare(
    'INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)'
  ).run(`${slug}@example.com`, slug);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT OR IGNORE INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function req(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });

const createGroup = (env, cookie, body) =>
  groupsApi.onRequestPost(ctx(env, req('/api/groups', { cookie, method: 'POST', body }), {}));
const listGroups = (env, cookie) =>
  groupsApi.onRequestGet(ctx(env, req('/api/groups', { cookie }), {}));
const getGroup = (env, cookie, id) =>
  groupApi.onRequestGet(ctx(env, req(`/api/groups/${id}`, { cookie }), { id: String(id) }));
const patchGroup = (env, cookie, id, body) =>
  groupApi.onRequestPatch(ctx(env, req(`/api/groups/${id}`, { cookie, method: 'PATCH', body }), { id: String(id) }));

const storedIcon = (env, id) =>
  ({ ...env._db.prepare('SELECT icon, color FROM groups WHERE id = ?').get(id) });

function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'whitt', 'Whitt Dorothy');
  const patrick = addSession(env, 'patrick');
  const whitt = addSession(env, 'whitt');
  return { env, patrick, whitt };
}

console.log('\n== the curated sets are the gate');
{
  const { env, patrick } = club();
  const bad = await createGroup(env, patrick, { name: 'Bad', icon: 'skull.and.crossbones' });
  check('creating with an unknown icon is 400', bad.status === 400, `got ${bad.status}`);
  const badColor = await createGroup(env, patrick, { name: 'Bad', color: 'chartreuse' });
  check('creating with an unknown color is 400', badColor.status === 400, `got ${badColor.status}`);
  const none = env._db.prepare('SELECT COUNT(*) AS n FROM groups').get();
  check('and neither stored anything', Number(none.n) === 0, `got ${none.n} rows`);
  check('the sets themselves are non-empty', GROUP_ICONS.size > 0 && GROUP_COLORS.size > 0);
}

console.log('\n== create stores the choice and every payload carries it');
{
  const { env, patrick, whitt } = club();
  const created = await createGroup(env, patrick, { name: 'Thursday Night', icon: 'flame.fill', color: 'orange' });
  check('create with a valid icon and color is 201', created.status === 201, `got ${created.status}`);
  const { group } = await created.json();
  check('the create payload carries them back', group.icon === 'flame.fill' && group.color === 'orange');

  env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(group.id, 'whitt');
  const list = await (await listGroups(env, whitt)).json();
  check('the list payload carries them', list.groups[0].icon === 'flame.fill' && list.groups[0].color === 'orange');
  const detail = await (await getGroup(env, whitt, group.id)).json();
  check('the detail payload carries them', detail.group.icon === 'flame.fill' && detail.group.color === 'orange');

  const plain = await createGroup(env, patrick, { name: 'No Icon' });
  const { group: bare } = await plain.json();
  check('a group created without a choice stores nulls', bare.icon === null && bare.color === null);
}

console.log('\n== PATCH: absent keeps, null clears, creator only');
{
  const { env, patrick, whitt } = club();
  const { group } = await (await createGroup(env, patrick, { name: 'Movie Night', icon: 'film.fill', color: 'purple' })).json();
  env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(group.id, 'whitt');

  const renamed = await patchGroup(env, patrick, group.id, { name: 'Film Night' });
  check('a plain rename is 200', renamed.status === 200, `got ${renamed.status}`);
  let row = storedIcon(env, group.id);
  check('and leaves the icon and color alone', row.icon === 'film.fill' && row.color === 'purple',
        JSON.stringify(row));

  const iconOnly = await patchGroup(env, patrick, group.id, { icon: 'star.fill' });
  check('an icon-only PATCH (no name) is 200', iconOnly.status === 200, `got ${iconOnly.status}`);
  const { group: after } = await iconOnly.json();
  check('its payload carries the new icon and untouched color', after.icon === 'star.fill' && after.color === 'purple');
  check('and the name did not change', after.name === 'Film Night', `got ${after.name}`);

  const cleared = await patchGroup(env, patrick, group.id, { icon: null, color: null });
  check('nulls clear both', cleared.status === 200, `got ${cleared.status}`);
  row = storedIcon(env, group.id);
  check('back to the neutral default', row.icon === null && row.color === null, JSON.stringify(row));

  const junk = await patchGroup(env, patrick, group.id, { icon: 'not.a.real.symbol' });
  check('a junk icon on PATCH is 400', junk.status === 400, `got ${junk.status}`);

  const empty = await patchGroup(env, patrick, group.id, {});
  check('an empty PATCH is still 400', empty.status === 400, `got ${empty.status}`);

  const mate = await patchGroup(env, whitt, group.id, { icon: 'star.fill' });
  check('a group-mate who is not the creator gets 403', mate.status === 403, `got ${mate.status}`);
  row = storedIcon(env, group.id);
  check('and wrote nothing', row.icon === null && row.color === null, JSON.stringify(row));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

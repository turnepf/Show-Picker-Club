// Tests that deleting or merging a member leaves nothing that still names
// them, and that the demo reset clears what a visitor leaves on the shared
// account. From the 2026-11 security audit (run 2).
//
//   node scripts/member-references-test.mjs
//
//   1. **Account deletion reaches every reference.** POST /api/account-delete
//      deleted the members row while ratings, household links, device
//      records, groups the member created and their memberships elsewhere
//      still named the slug. With foreign keys enforced (D1's default) the
//      batch failed, so an account the member asked to delete stayed live.
//      Without enforcement the rows dangled, and createMember hands a freed
//      slug to the next signup with the same first name, who inherited the
//      old member's groups and household. The check here is a sweep: after
//      the delete, no column in any table holds the slug.
//   2. **An admin merge moves the same references** to the kept account
//      instead (functions/_shared/member-references.js, merge mode).
//   3. **The demo reset clears visitor residue** (demoResidueCleanup in
//      functions/_shared/demo.js): groups the demo account created, its
//      household rows, passkeys and connected apps, and sessions older than a
//      day — but never a fresh session, so App Review isn't logged out.
//
// Same harness as scripts/shows-authz-test.mjs, except that batch() runs in a
// transaction, as D1's does: a failing statement rolls the whole batch back,
// which is what turned a foreign-key failure into "the account was never
// deleted".

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'member-refs-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const deleteApi = await load('api/account-delete.js');
const mergeApi = await load('api/admin-member-merge.js');
const { demoResidueCleanup } = await load('_shared/demo.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- fixtures ----

function makeEnv({ foreignKeys = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      // All-or-nothing, like D1's batch.
      batch: async (stmts) => {
        db.exec('BEGIN');
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    _db: db,
  };
}

function addMember(env, slug, { admin = 0 } = {}) {
  env._db.prepare('INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, ?, 0)').run(slug, slug, slug, admin);
  env._db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run(`${slug}@example.com`, slug);
}

function addSession(env, slug, { id = `session-${slug}`, createdAt = new Date().toISOString() } = {}) {
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), createdAt);
  return id;
}

function addGroup(env, name, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run(name, slugs[0]);
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM groups').get().id);
  for (const s of slugs) env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  return id;
}

const run = (env, sql, ...b) => env._db.prepare(sql).run(...b);
const n = (env, sql, ...b) => Number(env._db.prepare(sql).get(...b).n);

// Everything a member can have pointing at them beyond their own lists and
// identities. `who` is the departing member, `other` a member who stays.
function giveReferences(env, who, other) {
  const bobsGroup = addGroup(env, `${other}'s group`, [other, who]);
  const ownGroup = addGroup(env, `${who}'s group`, [who, other]);
  run(env, "INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, '2099-01-01', ?)", bobsGroup, `tok-${who}-1`, who);
  run(env, "INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, '2099-01-01', ?)", ownGroup, `tok-${who}-2`, who);
  run(env, 'UPDATE groups SET profile_changed_by = ? WHERE id = ?', who, bobsGroup);
  run(env, "INSERT INTO group_suggestions (group_id, suggested_by, title) VALUES (?, ?, 'Severance')", ownGroup, other);
  const sid = Number(env._db.prepare('SELECT MAX(id) AS id FROM group_suggestions').get().id);
  run(env, "INSERT INTO group_suggestion_responses (suggestion_id, member_slug, response) VALUES (?, ?, 'dismissed')", sid, other);
  run(env, "INSERT INTO show_ratings (tmdb_id, tmdb_type, season_number, member_slug, rating) VALUES (95396, 'tv', 0, ?, 9)", who);
  run(env, 'INSERT INTO household_members (member_slug, other_slug) VALUES (?, ?), (?, ?)', who, other, other, who);
  run(env, "INSERT INTO household_invites (inviter_slug, code, expires_at) VALUES (?, ?, '2099-01-01')", who, `hh-${who}`);
  run(env, "INSERT INTO member_platforms (member_slug, platform, first_seen_at, last_seen_at) VALUES (?, 'ios', '2026-01-01', '2026-01-01')", who);
  run(env, "INSERT INTO member_spend (member_slug, day, lookups) VALUES (?, date('now'), 3)", who);
  run(env, "INSERT INTO vibe_views (member_slug, day, views) VALUES (?, date('now'), 2)", who);
  run(env, "INSERT INTO import_pending (member_slug, stamp) VALUES (?, 'x')", who);
  run(env, "INSERT INTO failed_logins (ip, member_slug, created_at) VALUES ('1.2.3.4', ?, '2026-01-01')", who);
  // A show of the other member's that `who` tagged through Watching With.
  run(env, "INSERT INTO shows (title, list, member_slug, archived) VALUES ('The Bear', 'watching', ?, 0)", other);
  const showId = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
  run(env, 'INSERT INTO show_watchers (show_id, member_slug, created_by) VALUES (?, ?, ?)', showId, other, who);
  return { bobsGroup, ownGroup, sid };
}

// Every (table.column) in the database holding exactly this value.
function whereNamed(env, value) {
  const hits = [];
  const tables = env._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    for (const col of env._db.prepare(`PRAGMA table_info("${name}")`).all()) {
      const c = Number(env._db.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${col.name}" = ?`).get(value).n);
      if (c) hits.push(`${name}.${col.name}×${c}`);
    }
  }
  return hits;
}

function req(path, { cookie, method = 'POST', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const ctx = (env, request) => ({ env, request, params: {}, waitUntil: () => {} });

async function deleteAccount(env, slug) {
  const cookie = addSession(env, slug);
  run(env, "INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES (?, '424242', 'delete', ?)",
    slug, new Date(Date.now() + 600000).toISOString());
  return deleteApi.onRequestPost(ctx(env, req('/api/account-delete', { cookie, body: { code: '424242' } })));
}

// ---- 1. account deletion ----

for (const foreignKeys of [true, false]) {
  console.log(`\n== deleting an account leaves nothing naming the slug (foreign keys ${foreignKeys ? 'on' : 'off'})`);
  const env = makeEnv({ foreignKeys });
  addMember(env, 'ann'); addMember(env, 'bob');
  const { bobsGroup, ownGroup, sid } = giveReferences(env, 'ann', 'bob');

  let res;
  try { res = await deleteAccount(env, 'ann'); } catch (e) { res = { status: `threw ${e.message}` }; }
  check('the delete answers 200', res.status === 200, `got ${res.status}`);
  check('the members row is gone', n(env, "SELECT COUNT(*) AS n FROM members WHERE slug = 'ann'") === 0);
  const hits = whereNamed(env, 'ann');
  check('no column in any table still holds the slug', hits.length === 0, hits.join(', '));
  check('the group they created is gone, with its contents',
    n(env, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', ownGroup) === 0
    && n(env, 'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', ownGroup) === 0
    && n(env, 'SELECT COUNT(*) AS n FROM group_suggestions WHERE group_id = ?', ownGroup) === 0
    && n(env, 'SELECT COUNT(*) AS n FROM group_suggestion_responses WHERE suggestion_id = ?', sid) === 0);
  check("someone else's group survives, minus them",
    n(env, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', bobsGroup) === 1
    && n(env, "SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND member_slug = 'bob'", bobsGroup) === 1);
  check("the other member's tagged show stays (the tag just loses its author)",
    n(env, "SELECT COUNT(*) AS n FROM show_watchers WHERE member_slug = 'bob'") === 1);

  // The slug is free again; whoever gets it next inherits nothing.
  addMember(env, 'ann');
  check('a new signup reusing the slug is in no group and no household',
    n(env, "SELECT COUNT(*) AS n FROM group_members WHERE member_slug = 'ann'") === 0
    && n(env, "SELECT COUNT(*) AS n FROM household_members WHERE member_slug = 'ann' OR other_slug = 'ann'") === 0);
}

// ---- 2. admin merge ----

console.log('\n== a merge moves every reference to the kept account');
{
  const env = makeEnv({ foreignKeys: true });
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'ann-2'); addMember(env, 'ann'); addMember(env, 'bob');
  const { bobsGroup, ownGroup } = giveReferences(env, 'ann-2', 'bob');
  const admin = addSession(env, 'patrick');

  let res;
  try {
    res = await mergeApi.onRequestPost(ctx(env, req('/api/admin-member-merge', { cookie: admin, body: { source: 'ann-2', target: 'ann' } })));
  } catch (e) { res = { status: `threw ${e.message}` }; }
  check('the merge answers 200', res.status === 200, `got ${res.status}`);
  check('the source member row is gone', n(env, "SELECT COUNT(*) AS n FROM members WHERE slug = 'ann-2'") === 0);
  const hits = whereNamed(env, 'ann-2');
  check('nothing still names the source slug', hits.length === 0, hits.join(', '));
  check('the rating moved', n(env, "SELECT COUNT(*) AS n FROM show_ratings WHERE member_slug = 'ann'") === 1);
  check('the household link moved, both directions',
    n(env, "SELECT COUNT(*) AS n FROM household_members WHERE member_slug = 'ann' AND other_slug = 'bob'") === 1
    && n(env, "SELECT COUNT(*) AS n FROM household_members WHERE member_slug = 'bob' AND other_slug = 'ann'") === 1);
  check('both group memberships moved',
    n(env, "SELECT COUNT(*) AS n FROM group_members WHERE member_slug = 'ann' AND group_id IN (?, ?)", bobsGroup, ownGroup) === 2);
  check('the group they created is kept, now created by the target',
    env._db.prepare('SELECT creator_slug FROM groups WHERE id = ?').get(ownGroup)?.creator_slug === 'ann');
}

console.log('\n== a merge folds a membership the target already has');
{
  const env = makeEnv({ foreignKeys: true });
  addMember(env, 'patrick', { admin: 1 });
  addMember(env, 'ann-2'); addMember(env, 'ann'); addMember(env, 'bob');
  const gid = addGroup(env, 'Shared', ['bob', 'ann-2', 'ann']);
  run(env, "INSERT INTO show_ratings (tmdb_id, tmdb_type, season_number, member_slug, rating) VALUES (1, 'tv', 0, 'ann', 7), (1, 'tv', 0, 'ann-2', 3)");
  const admin = addSession(env, 'patrick');
  const res = await mergeApi.onRequestPost(ctx(env, req('/api/admin-member-merge', { cookie: admin, body: { source: 'ann-2', target: 'ann' } })));
  check('200', res.status === 200, `got ${res.status}`);
  check('one membership, not two', n(env, "SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND member_slug = 'ann'", gid) === 1);
  check("the target's own rating wins", env._db.prepare("SELECT rating FROM show_ratings WHERE member_slug = 'ann' AND tmdb_id = 1").get().rating === 7);
  check('and nothing names the source', whereNamed(env, 'ann-2').length === 0, whereNamed(env, 'ann-2').join(', '));
}

// ---- 3. demo reset ----

console.log('\n== the demo reset clears what a visitor leaves on the shared account');
{
  const env = makeEnv({ foreignKeys: true });
  addMember(env, 'demo'); addMember(env, 'bob');
  const { bobsGroup, ownGroup, sid } = giveReferences(env, 'demo', 'bob');
  run(env, "INSERT INTO member_passkeys (credential_id, member_slug, public_key) VALUES ('cred-1', 'demo', 'pk')");
  run(env, "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('c1', 'Some AI', '[]')");
  run(env, "INSERT INTO oauth_grants (member_slug, client_id, scope) VALUES ('demo', 'c1', 'shows:read')");
  const grantId = Number(env._db.prepare('SELECT MAX(id) AS id FROM oauth_grants').get().id);
  run(env, "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ('h1', ?, 'access', '2099-01-01')", grantId);
  run(env, "INSERT INTO oauth_codes (code_hash, client_id, member_slug, redirect_uri, code_challenge, scope, expires_at) VALUES ('ch', 'c1', 'demo', 'x', 'y', 'shows:read', '2099-01-01')");
  addSession(env, 'demo', { id: 'old', createdAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  addSession(env, 'demo', { id: 'fresh', createdAt: new Date(Date.now() - 3600000).toISOString() });

  await env.DB.batch(demoResidueCleanup(env, 'demo'));

  check('groups the demo account created are gone, with their contents',
    n(env, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', ownGroup) === 0
    && n(env, 'SELECT COUNT(*) AS n FROM group_suggestions WHERE group_id = ?', ownGroup) === 0
    && n(env, 'SELECT COUNT(*) AS n FROM group_suggestion_responses WHERE suggestion_id = ?', sid) === 0);
  check("its place in other people's groups is gone",
    n(env, "SELECT COUNT(*) AS n FROM group_members WHERE member_slug = 'demo'") === 0
    && n(env, "SELECT COUNT(*) AS n FROM group_invites WHERE created_by = 'demo'") === 0);
  check("but the other member's group stays", n(env, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', bobsGroup) === 1);
  check('household links and invites are gone',
    n(env, "SELECT COUNT(*) AS n FROM household_members WHERE member_slug = 'demo' OR other_slug = 'demo'") === 0
    && n(env, "SELECT COUNT(*) AS n FROM household_invites WHERE inviter_slug = 'demo'") === 0);
  check('passkeys are gone', n(env, "SELECT COUNT(*) AS n FROM member_passkeys WHERE member_slug = 'demo'") === 0);
  check('connected apps are gone (grants, tokens, codes)',
    n(env, "SELECT COUNT(*) AS n FROM oauth_grants WHERE member_slug = 'demo'") === 0
    && n(env, 'SELECT COUNT(*) AS n FROM oauth_tokens WHERE grant_id = ?', grantId) === 0
    && n(env, "SELECT COUNT(*) AS n FROM oauth_codes WHERE member_slug = 'demo'") === 0);
  check('a session older than a day is gone', n(env, "SELECT COUNT(*) AS n FROM sessions WHERE id = 'old'") === 0);
  check('a fresh session is kept (App Review stays signed in)', n(env, "SELECT COUNT(*) AS n FROM sessions WHERE id = 'fresh'") === 1);
  check("its ratings are left alone", n(env, "SELECT COUNT(*) AS n FROM show_ratings WHERE member_slug = 'demo'") === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

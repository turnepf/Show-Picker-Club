// Tests for the group invite's lifecycle — migration 070, written from the
// 2026-09 security audit, where an invite token had no lifecycle at all.
//
//   node scripts/group-invite-lifecycle-test.mjs
//
// Group membership is the product's privacy unit: it is what scopes vibe
// reads, GET /api/shows/all, Also-watching, Group Trending, the
// recommendation board, and who Watching With may name. So the two ways a
// membership row could be written without the group agreeing are both worth
// pinning here.
//
//   1. **Redemption is a write, and it used to ride a cross-site GET.**
//      The handler is cookie-authenticated and performs an INSERT, so a
//      top-level navigation from any page on the web carried the victim's
//      session into it and joined them to the attacker's group. SameSite=Lax
//      does not help — it permits the cookie on exactly that navigation. The
//      write is now refused when Sec-Fetch-Site says cross-site, falling back
//      to an Origin check, while native clients that send neither header are
//      unaffected. The refusal must be a *preview*, not an error: a
//      cross-site caller learns nothing it didn't already hold.
//
//   2. **A token was never consumed, never counted and never cancellable.**
//      Every invite issued in the preceding 7 days was simultaneously live,
//      unlimited and uncancellable, and it kept working after the member who
//      issued it had left. The link stays shareable to several people — that
//      is what the UI promises — but it is now bounded (use_count/max_uses,
//      claimed by an atomic UPDATE so a race can't overshoot), revocable by
//      the issuer or the group's creator, and dead once its issuer leaves.
//
// Dead is dead in one uniform way: revoked, exhausted, expired and
// issuer-departed all answer 410, so a link that no longer works never tells
// its holder which kind of dead it is.
//
// Same harness as scripts/group-icons-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json, and schema.sql is
// loaded into node:sqlite behind a thin D1 shim.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'group-invite-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const inviteApi = await load('api/groups/[id]/invite.js');
const groupsApi = await load('api/groups.js');
const joinApi = await load('api/groups/join.js');
const leaveApi = await load('api/groups/[id]/leave.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (s) => { for (const x of s) await x.run(); } },
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

function addGroup(env, name, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run(name, slugs[0]);
  const { id } = env._db.prepare('SELECT MAX(id) AS id FROM groups').get();
  for (const s of slugs) {
    env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  }
  return Number(id);
}

// `site` is what a browser puts in Sec-Fetch-Site. Native clients (URLSession)
// send neither that nor Origin, which is the `undefined` case.
function req(path, { cookie, method = 'GET', body, site, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  if (site) headers['Sec-Fetch-Site'] = site;
  if (origin) headers.Origin = origin;
  return new Request(ORIGIN + path, {
    method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });

const mintInvite = (env, cookie, groupId) =>
  inviteApi.onRequestPost(ctx(env, req(`/api/groups/${groupId}/invite`, { cookie, method: 'POST' }), { id: String(groupId) }));
const listInvites = (env, cookie, groupId) =>
  inviteApi.onRequestGet(ctx(env, req(`/api/groups/${groupId}/invite`, { cookie }), { id: String(groupId) }));
const revokeInvite = (env, cookie, groupId, token) =>
  inviteApi.onRequestDelete(ctx(env, req(`/api/groups/${groupId}/invite?token=${token}`, { cookie, method: 'DELETE' }), { id: String(groupId) }));
const redeem = (env, cookie, token, opts = {}) =>
  joinApi.onRequestGet(ctx(env, req(`/api/groups/join?token=${token}`, { cookie, ...opts })));
const leaveGroup = (env, cookie, groupId) =>
  leaveApi.onRequestPost(ctx(env, req(`/api/groups/${groupId}/leave`, { cookie, method: 'POST' }), { id: String(groupId) }));

const isMember = (env, groupId, slug) =>
  !!env._db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?').get(groupId, slug);
const inviteRow = (env, token) =>
  env._db.prepare('SELECT * FROM group_invites WHERE token = ?').get(token);

async function tokenFor(env, cookie, groupId) {
  return (await (await mintInvite(env, cookie, groupId)).json()).token;
}

// Patrick's group. Stacy is a full member of the club in no group with him —
// the stranger open self-enrollment makes possible.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'quinn', 'Quinn Rosa');
  addMember(env, 'stacy', 'Stacy Kallay');
  const gid = addGroup(env, 'Thursday Night', ['patrick', 'quinn']);
  return { env, gid };
}

console.log('\n== a cross-site link joins nobody');
{
  const { env, gid } = club();
  const token = await tokenFor(env, addSession(env, 'patrick'), gid);
  const victim = addSession(env, 'stacy');

  const res = await redeem(env, victim, token, { site: 'cross-site' });
  check('the cross-site redemption is not an error', res.status === 200, `got ${res.status}`);
  const body = await res.json();
  check('it returns a preview, not a join', body.join_required === true && body.ok === undefined);
  check('and no membership row was written', !isMember(env, gid, 'stacy'));
  check('the use was not spent either', (inviteRow(env, token).use_count ?? 0) === 0);
}

console.log('\n== our own page and the native clients still work');
{
  const { env, gid } = club();
  const cookie = addSession(env, 'patrick');

  // The web app's own fetch().
  const a = await redeem(env, addSession(env, 'stacy'), await tokenFor(env, cookie, gid), { site: 'same-origin' });
  check('same-origin joins', (await a.json()).ok === true, `got ${a.status}`);
  check('and the row is there', isMember(env, gid, 'stacy'));

  // iOS/tvOS URLSession: no Sec-Fetch-Site, no Origin.
  const env2 = club();
  const t2 = await tokenFor(env2.env, addSession(env2.env, 'patrick'), env2.gid);
  const b = await redeem(env2.env, addSession(env2.env, 'stacy'), t2);
  check('a native client with neither header joins', (await b.json()).ok === true, `got ${b.status}`);

  // An Origin from our own site, with no Sec-Fetch-Site.
  const env3 = club();
  const t3 = await tokenFor(env3.env, addSession(env3.env, 'patrick'), env3.gid);
  const c = await redeem(env3.env, addSession(env3.env, 'stacy'), t3, { origin: ORIGIN });
  check('our own Origin joins', (await c.json()).ok === true, `got ${c.status}`);

  // A foreign Origin with no Sec-Fetch-Site is refused the same way.
  const env4 = club();
  const t4 = await tokenFor(env4.env, addSession(env4.env, 'patrick'), env4.gid);
  await redeem(env4.env, addSession(env4.env, 'stacy'), t4, { origin: 'https://evil.example' });
  check('a foreign Origin joins nobody', !isMember(env4.env, env4.gid, 'stacy'));
}

console.log('\n== one link, several people, but a ceiling');
{
  const { env, gid } = club();
  const token = await tokenFor(env, addSession(env, 'patrick'), gid);

  // Still shareable: two different people redeem the same link.
  addMember(env, 'joiner1', 'One Joiner');
  addMember(env, 'joiner2', 'Two Joiner');
  const r1 = await redeem(env, addSession(env, 'joiner1'), token);
  const r2 = await redeem(env, addSession(env, 'joiner2'), token);
  check('the same link admits more than one person',
    (await r1.json()).ok === true && (await r2.json()).ok === true);
  check('and the uses are counted', inviteRow(env, token).use_count === 2);

  // Exhaust the remaining eight.
  for (let i = 3; i <= 10; i++) {
    addMember(env, `joiner${i}`, `Joiner ${i}`);
    await redeem(env, addSession(env, `joiner${i}`), token);
  }
  check('ten uses are spent', inviteRow(env, token).use_count === 10);

  addMember(env, 'eleventh', 'Eleventh Person');
  const over = await redeem(env, addSession(env, 'eleventh'), token);
  check('the eleventh is refused', over.status === 410, `got ${over.status}`);
  check('and joined nobody', !isMember(env, gid, 'eleventh'));
  check('the counter did not move past the ceiling', inviteRow(env, token).use_count === 10);
}

console.log('\n== a leaked link can be killed without deleting the group');
{
  const { env, gid } = club();
  const patrick = addSession(env, 'patrick');
  const token = await tokenFor(env, patrick, gid);

  const listed = await (await listInvites(env, patrick, gid)).json();
  check('the live link is listed', listed.invites.some((i) => i.token === token));
  check('with its remaining uses', listed.invites[0].uses_left === 10);

  const outsider = await (await listInvites(env, addSession(env, 'stacy'), gid)).json();
  check('a non-member cannot list them', outsider.error === 'Forbidden');

  check('a non-member cannot revoke either',
    (await revokeInvite(env, addSession(env, 'stacy'), gid, token)).status === 403);

  const gone = await revokeInvite(env, patrick, gid, token);
  check('the issuer can revoke', gone.status === 200, `got ${gone.status}`);

  const after = await redeem(env, addSession(env, 'stacy'), token);
  check('a revoked link is dead', after.status === 410, `got ${after.status}`);
  check('and joined nobody', !isMember(env, gid, 'stacy'));

  const relisted = await (await listInvites(env, patrick, gid)).json();
  check('and it drops off the list', relisted.invites.length === 0);
}

console.log('\n== the group creator can revoke somebody else\'s link');
{
  const { env, gid } = club();
  // Quinn is in the group but did not create it; Patrick did.
  const quinnToken = await tokenFor(env, addSession(env, 'quinn'), gid);
  const res = await revokeInvite(env, addSession(env, 'patrick'), gid, quinnToken);
  check('the creator may revoke an invite they did not issue', res.status === 200, `got ${res.status}`);
}

console.log('\n== a token cannot be revoked from outside its own group');
{
  const { env, gid } = club();
  const other = addGroup(env, 'Other Group', ['stacy']);
  const token = await tokenFor(env, addSession(env, 'patrick'), gid);
  // Stacy creates her own group, then pastes Patrick's token at her group id.
  const res = await revokeInvite(env, addSession(env, 'stacy'), other, token);
  check('a foreign token is not revoked', res.status === 404, `got ${res.status}`);
  check('and the real invite is untouched', inviteRow(env, token).revoked_at === null);
}

console.log('\n== leaving takes your outstanding invites with you');
{
  const { env, gid } = club();
  const quinn = addSession(env, 'quinn');
  const token = await tokenFor(env, quinn, gid);

  const left = await leaveGroup(env, quinn, gid);
  check('the leave succeeds', left.status === 200, `got ${left.status}`);
  check('the invite row is gone', inviteRow(env, token) === undefined);

  const res = await redeem(env, addSession(env, 'stacy'), token);
  check('the link no longer works', res.status === 404, `got ${res.status}`);
  check('and joined nobody', !isMember(env, gid, 'stacy'));
}

console.log('\n== a token whose issuer is no longer a member is dead');
{
  const { env, gid } = club();
  const token = await tokenFor(env, addSession(env, 'quinn'), gid);
  // A membership removed some other way — a row predating the leave cleanup.
  env._db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_slug = ?').run(gid, 'quinn');

  const res = await redeem(env, addSession(env, 'stacy'), token);
  check('the orphaned link is refused', res.status === 410, `got ${res.status}`);
  check('and joined nobody', !isMember(env, gid, 'stacy'));
}

console.log('\n== dead is dead in one uniform way');
{
  const { env, gid } = club();
  const patrick = addSession(env, 'patrick');
  const stacy = addSession(env, 'stacy');

  const expired = await tokenFor(env, patrick, gid);
  env._db.prepare("UPDATE group_invites SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?").run(expired);

  const revoked = await tokenFor(env, patrick, gid);
  await revokeInvite(env, patrick, gid, revoked);

  const spent = await tokenFor(env, patrick, gid);
  env._db.prepare('UPDATE group_invites SET use_count = max_uses WHERE token = ?').run(spent);

  const bodies = [];
  for (const t of [expired, revoked, spent]) {
    const res = await redeem(env, stacy, t);
    bodies.push([res.status, JSON.stringify(await res.json())]);
  }
  check('expired, revoked and exhausted answer identically',
    bodies.every(([s, b]) => s === bodies[0][0] && b === bodies[0][1]),
    JSON.stringify(bodies));
  check('and none of them is a 200', bodies[0][0] === 410, `got ${bodies[0][0]}`);
}

console.log('\n== an existing member redeeming again changes nothing');
{
  const { env, gid } = club();
  const token = await tokenFor(env, addSession(env, 'patrick'), gid);
  const res = await redeem(env, addSession(env, 'quinn'), token);
  check('a member who is already in gets 409', res.status === 409, `got ${res.status}`);
  check('and it does not burn a use', (inviteRow(env, token).use_count ?? 0) === 0);
}

// The invite sheet in the app now tells the member how many people the link
// will let in, and it can only do that honestly if the number travels in the
// response. A mint that enforces one ceiling while reporting another — or
// reporting none, which drops the line from the sheet — is the drift this
// pins. Both mint sites answer from the same constant.
console.log('\n== a new link reports the ceiling it enforces');
{
  const { env, gid } = club();
  const res = await mintInvite(env, addSession(env, 'patrick'), gid);
  const body = await res.json();
  check('the mint reports a ceiling', Number.isInteger(body.max_uses) && body.max_uses > 0,
    JSON.stringify(body));
  check('and it is the one written on the row',
    inviteRow(env, body.token).max_uses === body.max_uses,
    `reported ${body.max_uses}, stored ${inviteRow(env, body.token).max_uses}`);

  // Creating a group mints its first link through the same helper, so the
  // sheet shown straight after "Create group" says the same thing.
  const created = await groupsApi.onRequestPost(
    ctx(env, req('/api/groups', { cookie: addSession(env, 'stacy'), method: 'POST', body: { name: 'Movie Night' } })));
  const first = (await created.json()).invite;
  check('the group-creation invite reports it too', first.max_uses === body.max_uses,
    JSON.stringify(first));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Tests for Show Picker Club as an MCP server, and the OAuth 2.1 server in
// front of it (migration 071, docs/INVARIANTS.md §27).
//
//   node scripts/mcp-test.mjs
//
// An AI app that connects gets a member's own permissions, no more. The
// properties pinned here are the ones that keep "no more" true:
//
//   1. **Only an OAuth token opens /mcp.** A session cookie alone is a 401 —
//      the endpoint takes writes, and a cookie is sent by any page a member
//      visits. The 401 names the metadata document so a client can connect.
//   2. **The consent screen is the member's, and only theirs.** An unknown
//      client or an unregistered redirect gets an error page and no redirect
//      (never an open redirector). A consent POST from another site, or with
//      a form rendered for another session, writes no code. Declining says so.
//   3. **Codes and refresh tokens are single-use, and a replay costs the
//      connection.** PKCE S256 is required. A code redeemed twice revokes the
//      grant it minted; a rotated refresh token presented again revokes it too.
//   4. **Scopes decide which tools exist.** A read-only grant isn't shown the
//      write tools and can't call one by name.
//   5. **The tools carry the app's own rules, because they call the app's own
//      handlers.** Owner-only memos stay owner-only; a stranger's lists are
//      unreachable; another member's row can't be edited, archived or deleted
//      (and saying "done" for a row that isn't yours is itself a lie the tool
//      refuses to tell); Watching With names only group-mates.
//   6. **Never admin.** An admin's own token can't reach an admin gate.
//   7. **Revocation, bans and caps take effect on the next call.** The owner
//      can revoke from Connected apps (a stranger's revoke is a 404); a
//      disabled member's token stops working; daily caps actually refuse.
//
// Same harness as scripts/shows-authz-test.mjs: the functions tree is copied
// beside a `type: module` package.json and schema.sql is loaded into
// node:sqlite behind a thin D1 shim, so the SQL under test runs. No TMDB or
// Watchmode keys are set, so nothing reaches the network.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'mcp-test-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const mcp = await load('mcp.js');
const register = await load('oauth/register.js');
const authorize = await load('oauth/authorize.js');
const token = await load('oauth/token.js');
const revoke = await load('oauth/revoke.js');
const prm = await load('.well-known/oauth-protected-resource/[[path]].js');
const asMeta = await load('.well-known/oauth-authorization-server/[[path]].js');
const oidcMeta = await load('.well-known/openid-configuration/[[path]].js');
const connectedApps = await load('api/connected-apps.js');
const disableApi = await load('api/admin-member-disable.js');
const reportingApi = await load('api/reporting.js');
const auth = await load('_shared/auth.js');
const admin = await load('_shared/admin.js');
const tools = await load('_shared/mcp-tools.js');

const ORIGIN = 'https://showpicker.club';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  guard() { if (this.args.length > 100) throw new Error('D1_ERROR: too many bound parameters'); }
  async first() { this.guard(); const rows = this.db.prepare(this.sql).all(...this.args); return rows.length ? { ...rows[0] } : null; }
  async all() { this.guard(); return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    this.guard();
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    },
    _db: db,
  };
}

function addMember(env, slug, name, { admin: isAdmin = 0 } = {}) {
  const [first, last] = name.split(' ');
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, last_name, last_initial, disabled, is_admin) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(slug, name, first, last || null, last ? last.charAt(0) : null, isAdmin);
}

function addSession(env, slug) {
  const id = `session-${slug}-${randomBytes(4).toString('hex')}`;
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slug, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

function addShow(env, { slug, title, list = 'watching', notes = null, tmdb = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, notes, recommended_by, watching_with, added_by, created_at, updated_at, tmdb_id, tmdb_type)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, '2026-08-01 00:00:00', '2026-08-01 00:00:00', ?, ?)`
  ).run(title, list, slug, notes, notes ? `REC-${notes}` : null, notes ? `WITH-${notes}` : null,
    `${slug}@example.com`, tmdb, tmdb ? 'tv' : null);
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

function addGroup(env, name, slugs) {
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)').run(name, slugs[0]);
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM groups').get().id);
  for (const s of slugs) env._db.prepare('INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)').run(id, s);
  return id;
}

const row = (env, sql, ...a) => env._db.prepare(sql).get(...a);

// Patrick (an admin) and Quinn share a group. Stacy is a stranger: a full
// member, in no group with either of them.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner', { admin: 1 });
  addMember(env, 'quinn', 'Rosa Quinn');
  addMember(env, 'stacy', 'Stacy Kallay');
  const groupId = addGroup(env, 'Couch', ['patrick', 'quinn']);
  return { env, groupId };
}

const waits = [];
const ctx = (env, request, params = {}) => ({ env, request, params, waitUntil: (p) => waits.push(p), data: {} });

// ---- OAuth client helpers ----

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

async function registerClient(env, body, ip = '203.0.113.1') {
  const res = await register.onRequestPost(ctx(env, new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
  })));
  return { status: res.status, data: await res.json() };
}

function authorizeUrl(q) {
  const u = new URL(`${ORIGIN}/oauth/authorize`);
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

async function getAuthorize(env, q, cookie) {
  const headers = cookie ? { Cookie: `session=${cookie}` } : {};
  const res = await authorize.onRequestGet(ctx(env, new Request(authorizeUrl(q), { headers })));
  return { status: res.status, location: res.headers.get('Location'), html: await res.text(), csp: res.headers.get('Content-Security-Policy') };
}

function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return out;
}

async function postConsent(env, fields, cookie, { site = 'same-origin' } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `session=${cookie}` };
  if (site) headers['Sec-Fetch-Site'] = site;
  const res = await authorize.onRequestPost(ctx(env, new Request(`${ORIGIN}/oauth/authorize`, {
    method: 'POST', headers, body: new URLSearchParams(fields).toString(),
  })));
  return { status: res.status, location: res.headers.get('Location'), html: await res.text() };
}

async function tokenRequest(env, params) {
  const res = await token.onRequestPost(ctx(env, new Request(`${ORIGIN}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  })));
  return { status: res.status, data: await res.json() };
}

// The whole dance a client does, returning the code and the token response.
async function connect(env, slug, { write = true, clientId, redirect = CLAUDE_REDIRECT } = {}) {
  if (!clientId) clientId = (await registerClient(env, { client_name: 'Claude', redirect_uris: [redirect] })).data.client_id;
  const cookie = addSession(env, slug);
  const { verifier, challenge } = pkce();
  const page = await getAuthorize(env, {
    response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st8', scope: 'shows:read shows:write', resource: `${ORIGIN}/mcp`,
  }, cookie);
  const fields = { ...hiddenFields(page.html), decision: 'allow', ...(write ? { grant_write: '1' } : {}) };
  const consent = await postConsent(env, fields, cookie);
  const code = new URL(consent.location).searchParams.get('code');
  const tok = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
  return { clientId, cookie, code, verifier, consent, tok, access: tok.data.access_token, refresh: tok.data.refresh_token };
}

let rpcId = 0;
async function rpc(env, accessToken, method, params, { cookie } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (cookie) headers.Cookie = `session=${cookie}`;
  const res = await mcp.onRequestPost(ctx(env, new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })));
  const text = await res.text();
  return { status: res.status, www: res.headers.get('WWW-Authenticate'), body: text ? JSON.parse(text) : null };
}

async function tool(env, accessToken, name, args = {}) {
  const r = await rpc(env, accessToken, 'tools/call', { name, arguments: args });
  const result = r.body && r.body.result;
  return { status: r.status, error: r.body && r.body.error, isError: !!(result && result.isError), text: result ? result.content[0].text : '', data: result && result.structuredContent };
}

// ---- tests ----

console.log('\n== discovery documents');
{
  const { env } = club();
  const p = await (await prm.onRequestGet({ request: new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), env })).json();
  check('the resource is the /mcp URL', p.resource === `${ORIGIN}/mcp`);
  check('it names this origin as the authorization server', p.authorization_servers[0] === ORIGIN);
  const a = await (await asMeta.onRequestGet({ request: new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env })).json();
  const oidc = oidcMeta.onRequestGet();
  check('OpenID discovery is a JSON 404, not the home page', oidc.status === 404
    && (oidc.headers.get('Content-Type') || '').includes('application/json'));
  check('S256 is the only PKCE method', JSON.stringify(a.code_challenge_methods_supported) === '["S256"]');
  check('dynamic registration is advertised', a.registration_endpoint === `${ORIGIN}/oauth/register`);
  check('only the code flow is offered', JSON.stringify(a.response_types_supported) === '["code"]');
}

console.log('\n== /mcp opens for a token and nothing else');
{
  const { env } = club();
  const none = await rpc(env, null, 'initialize', {});
  check('no credentials is 401', none.status === 401);
  check('the 401 points at the resource metadata',
    (none.www || '').includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`), none.www);
  const cookieOnly = await rpc(env, null, 'tools/list', {}, { cookie: addSession(env, 'patrick') });
  check('a session cookie alone is 401', cookieOnly.status === 401);
  const junk = await rpc(env, 'not-a-real-token', 'tools/list', {});
  check('an unknown token is 401 with invalid_token', junk.status === 401 && (junk.www || '').includes('invalid_token'));
  const get = mcp.onRequestGet({ request: new Request(`${ORIGIN}/mcp`, { headers: { Accept: 'text/event-stream' } }) });
  check('GET /mcp is 405 (stateless, no stream)', get.status === 405);
  check('the 405 declares utf-8 so its apostrophe renders', (get.headers.get('Content-Type') || '').includes('charset=utf-8'));
  const browse = mcp.onRequestGet({ request: new Request(`${ORIGIN}/mcp`, { headers: { Accept: 'text/html,application/xhtml+xml' } }) });
  check('a browser opening /mcp is sent to /connect', browse.status === 302 && browse.headers.get('Location') === '/connect');
  check('DELETE /mcp is still 405', mcp.onRequestDelete().status === 405);

  const c = await connect(env, 'patrick');
  check('the full dance mints tokens', !!c.access && !!c.refresh && c.tok.data.token_type === 'Bearer', JSON.stringify(c.tok.data));
  check('the authorization response carries iss and state',
    new URL(c.consent.location).searchParams.get('iss') === ORIGIN && new URL(c.consent.location).searchParams.get('state') === 'st8');
  const init = await rpc(env, c.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  check('initialize negotiates the asked-for version', init.body.result.protocolVersion === '2025-06-18');
  check('initialize advertises tools', !!init.body.result.capabilities.tools);
  const odd = await rpc(env, c.access, 'initialize', { protocolVersion: '1999-01-01' });
  check('an unknown version gets the latest supported', odd.body.result.protocolVersion === '2025-11-25');
  const refreshAsAccess = await rpc(env, c.refresh, 'tools/list', {});
  check('a refresh token is not an access token', refreshAsAccess.status === 401);
  env._db.prepare("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 minute') WHERE kind = 'access'").run();
  check('an expired access token is 401', (await rpc(env, c.access, 'tools/list', {})).status === 401);
}

console.log('\n== registration only accepts redirects a browser won\'t execute');
{
  const { env } = club();
  const bad = async (uri) => (await registerClient(env, { client_name: 'x', redirect_uris: [uri] })).status;
  check('javascript: is refused', (await bad('javascript:alert(1)')) === 400);
  check('data: is refused', (await bad('data:text/html,hi')) === 400);
  check('plain http off-machine is refused', (await bad('http://evil.example/cb')) === 400);
  check('a fragment is refused', (await bad('https://ok.example/cb#frag')) === 400);
  check('https is accepted', (await bad('https://claude.ai/api/mcp/auth_callback')) === 201);
  check('loopback http is accepted', (await bad('http://127.0.0.1:33418/callback')) === 201);
  check('an app scheme is accepted', (await bad('cursor://anysphere.cursor-retrieval/oauth/callback')) === 201);
  const r = await registerClient(env, { client_name: '<b>Claude</b>\u0007', redirect_uris: ['https://a.example/cb'] });
  check('a public client gets no secret', r.data.client_secret === undefined && r.data.token_endpoint_auth_method === 'none');
  const conf = await registerClient(env, { client_name: 'Conf', redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'client_secret_post' });
  check('a confidential client gets a secret', typeof conf.data.client_secret === 'string');
  const stored = row(env, 'SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?', conf.data.client_id);
  check('only a hash of the secret is stored', stored.client_secret_hash && stored.client_secret_hash !== conf.data.client_secret);

  let last = 0;
  for (let i = 0; i < 25; i++) last = (await registerClient(env, { client_name: 'spam', redirect_uris: ['https://a.example/cb'] }, '198.51.100.9')).status;
  check('one address is capped per hour', last === 429, `got ${last}`);
}

console.log('\n== the consent screen never becomes an open redirect');
{
  const { env } = club();
  const cookie = addSession(env, 'patrick');
  const { challenge } = pkce();
  const client = (await registerClient(env, { client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] })).data.client_id;
  const base = { response_type: 'code', client_id: client, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };

  const unknown = await getAuthorize(env, { ...base, client_id: 'spc_nope' }, cookie);
  check('an unknown client gets a page, not a redirect', unknown.status === 400 && !unknown.location);
  const wrongRedirect = await getAuthorize(env, { ...base, redirect_uri: 'https://evil.example/steal' }, cookie);
  check('an unregistered redirect gets a page, not a redirect', wrongRedirect.status === 400 && !wrongRedirect.location);
  const noPkce = await getAuthorize(env, { ...base, code_challenge: undefined }, cookie);
  check('no PKCE challenge redirects back with invalid_request',
    noPkce.status === 303 && new URL(noPkce.location).searchParams.get('error') === 'invalid_request');
  const plain = await getAuthorize(env, { ...base, code_challenge_method: 'plain' }, cookie);
  check('plain PKCE is refused', new URL(plain.location).searchParams.get('error') === 'invalid_request');
  const otherResource = await getAuthorize(env, { ...base, resource: 'https://elsewhere.example/mcp' }, cookie);
  check('a token for some other resource is refused', new URL(otherResource.location).searchParams.get('error') === 'invalid_target');

  const signedOut = await getAuthorize(env, base, null);
  check('signed out, it asks you to sign in and comes back', signedOut.status === 200 &&
    signedOut.html.includes('/?login=1&amp;return_to=%2Foauth%2Fauthorize%3F'));
  const page = await getAuthorize(env, base, cookie);
  check('signed in, the consent screen names the app and where it goes',
    page.html.includes('Connect Claude?') && page.html.includes('claude.ai'));
  check('the consent page may only post back here and to the app', (page.csp || '').includes("form-action 'self' https://claude.ai"));

  const evil = (await registerClient(env, { client_name: '<script>x</script>', redirect_uris: ['https://evil.example/cb'] })).data.client_id;
  const evilPage = await getAuthorize(env, { ...base, client_id: evil, redirect_uri: 'https://evil.example/cb' }, cookie);
  check('a client name is escaped', !evilPage.html.includes('<script>x</script>'));
  check('a lookalike shows its real host', evilPage.html.includes('evil.example'));

  const loop = (await registerClient(env, { client_name: 'CLI', redirect_uris: ['http://127.0.0.1:1111/callback'] })).data.client_id;
  const loopPage = await getAuthorize(env, { ...base, client_id: loop, redirect_uri: 'http://127.0.0.1:54321/callback' }, cookie);
  check('a loopback redirect may use any port (RFC 8252)', loopPage.status === 200 && loopPage.html.includes('Allow'));
}

console.log('\n== consent is refused from anywhere but the member\'s own page');
{
  const { env } = club();
  const cookie = addSession(env, 'patrick');
  const { challenge } = pkce();
  const client = (await registerClient(env, { client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] })).data.client_id;
  const page = await getAuthorize(env, { response_type: 'code', client_id: client, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }, cookie);
  const fields = { ...hiddenFields(page.html), decision: 'allow', grant_write: '1' };
  const codes = () => row(env, 'SELECT COUNT(*) AS n FROM oauth_codes').n;

  const cross = await postConsent(env, fields, cookie, { site: 'cross-site' });
  check('a cross-site POST is refused', cross.status === 403 && !cross.location && codes() === 0);
  const noHeaders = await postConsent(env, fields, cookie, { site: null });
  check('a POST with neither Sec-Fetch-Site nor Origin is refused', noHeaders.status === 403 && codes() === 0);
  const otherSession = await postConsent(env, fields, addSession(env, 'stacy'));
  check("a form rendered for another member's session is refused", otherSession.status === 403 && codes() === 0);
  const forged = await postConsent(env, { ...fields, csrf: 'f'.repeat(64) }, cookie);
  check('a forged csrf value is refused', forged.status === 403 && codes() === 0);
  const deny = await postConsent(env, { ...fields, decision: 'deny' }, cookie);
  check('Cancel sends access_denied back', new URL(deny.location).searchParams.get('error') === 'access_denied' && codes() === 0);
  const allow = await postConsent(env, fields, cookie);
  check('Allow sends a code back', !!new URL(allow.location).searchParams.get('code') && codes() === 1);
}

console.log('\n== codes and refresh tokens are single-use');
{
  const { env } = club();
  const c = await connect(env, 'patrick');
  const again = await tokenRequest(env, { grant_type: 'authorization_code', code: c.code, redirect_uri: CLAUDE_REDIRECT, client_id: c.clientId, code_verifier: c.verifier });
  check('a code redeemed twice fails', again.status === 400 && again.data.error === 'invalid_grant');
  check('and revokes what it minted', (await rpc(env, c.access, 'tools/list', {})).status === 401);

  const d = await connect(env, 'patrick');
  check('a fresh connection works after a revoked one', (await rpc(env, d.access, 'tools/list', {})).status === 200);

  const { env: env2 } = club();
  const clientId = (await registerClient(env2, { client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] })).data.client_id;
  const cookie = addSession(env2, 'patrick');
  const { challenge } = pkce();
  const page = await getAuthorize(env2, { response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }, cookie);
  const code = new URL((await postConsent(env2, { ...hiddenFields(page.html), decision: 'allow' }, cookie)).location).searchParams.get('code');
  const badPkce = await tokenRequest(env2, { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, client_id: clientId, code_verifier: pkce().verifier });
  check('the wrong PKCE verifier fails', badPkce.data.error === 'invalid_grant');
  const otherClient = (await registerClient(env2, { client_name: 'Other', redirect_uris: [CLAUDE_REDIRECT] })).data.client_id;
  const stolen = await tokenRequest(env2, { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, client_id: otherClient, code_verifier: 'x'.repeat(43) });
  check("another client can't redeem the code", stolen.data.error === 'invalid_grant');

  const r1 = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: d.refresh, client_id: d.clientId });
  check('a refresh rotates both tokens', r1.status === 200 && r1.data.refresh_token !== d.refresh && !!r1.data.access_token);
  check('the new access token works', (await rpc(env, r1.data.access_token, 'tools/list', {})).status === 200);
  const replay = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: d.refresh, client_id: d.clientId });
  check('replaying the old refresh token fails', replay.data.error === 'invalid_grant');
  check('and revokes the whole connection', (await rpc(env, r1.data.access_token, 'tools/list', {})).status === 401);

  const conf = await registerClient(env, { client_name: 'Conf', redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
  const noSecret = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: 'x', client_id: conf.data.client_id });
  check('a confidential client without its secret is invalid_client', noSecret.status === 401 && noSecret.data.error === 'invalid_client');
}

console.log('\n== scopes decide which tools exist');
{
  const { env } = club();
  const ro = await connect(env, 'patrick', { write: false });
  check('an unticked write box grants read only', ro.tok.data.scope === 'shows:read', ro.tok.data.scope);
  const list = (await rpc(env, ro.access, 'tools/list', {})).body.result.tools.map((t) => t.name);
  check('a read-only connection sees read tools', list.includes('list_my_shows') && list.includes('get_show'));
  check('and no write tools', !list.includes('add_show') && !list.includes('delete_show'));
  const refused = await tool(env, ro.access, 'add_show', { title: 'Severance', list: 'watching' });
  check('calling a write tool by name is an unknown tool', refused.error && refused.error.code === -32602);
  check('and writes nothing', row(env, 'SELECT COUNT(*) AS n FROM shows').n === 0);

  const rw = await connect(env, 'patrick');
  const all = (await rpc(env, rw.access, 'tools/list', {})).body.result.tools;
  check('a read-write connection sees the write tools', all.some((t) => t.name === 'add_show'));
  check('every tool carries annotations and a closed schema',
    all.every((t) => t.annotations && t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false));
  check('delete is marked destructive', all.find((t) => t.name === 'delete_show').annotations.destructiveHint === true);
  // Anthropic's connector-directory review: every tool has a title and the
  // hint that decides whether Claude asks first; anything that changes or
  // removes existing data is destructive; descriptions describe rather than
  // instruct.
  check('every tool has a title', all.every((t) => typeof t.title === 'string' && t.title.length > 0));
  check('every tool name is at most 64 characters', all.every((t) => t.name.length <= 64));
  const readOnly = all.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name);
  check('read tools are marked read-only', ['list_my_shows', 'get_show', 'search_titles', 'get_group'].every((n) => readOnly.includes(n)));
  const destructive = new Set(all.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name));
  for (const n of ['update_show', 'move_show', 'reorder_list', 'rate_show', 'archive_show', 'restore_show', 'delete_show', 'remove_recommendation', 'leave_group']) {
    check(`${n} is marked destructive`, destructive.has(n));
  }
  check('every write tool states destructiveHint explicitly',
    all.filter((t) => !t.annotations.readOnlyHint).every((t) => typeof t.annotations.destructiveHint === 'boolean'));
  const bossy = all.filter((t) => /\b(confirm with|prefer |you must|always |never |call [a-z_]+ first)/i.test(t.description));
  check('no tool description tells the model how to behave', bossy.length === 0, bossy.map((t) => t.name).join(', '));
  const init = (await rpc(env, rw.access, 'initialize', {})).body.result.instructions;
  check('the server instructions describe rather than direct', !/confirm|prefer|you must/i.test(init));
  const names = all.map((t) => t.name);
  for (const absent of ['join_group', 'delete_group', 'rename_group', 'delete_account', 'household']) {
    check(`no ${absent} tool`, !names.some((n) => n.includes(absent)));
  }
}

console.log('\n== the tools carry the app\'s own privacy rules');
{
  const { env, groupId } = club();
  const mine = addShow(env, { slug: 'patrick', title: 'Severance', list: 'watching', notes: 'PAT-NOTE' });
  const hers = addShow(env, { slug: 'quinn', title: 'Slow Horses', list: 'recommending', notes: 'QUINN-NOTE' });
  const strangers = addShow(env, { slug: 'stacy', title: 'Hacks', list: 'watching', notes: 'STACY-NOTE' });
  const { access } = await connect(env, 'patrick');

  const profile = await tool(env, access, 'get_profile');
  check('get_profile says who this is', profile.data.slug === 'patrick' && profile.data.groups[0].id === groupId);
  check('get_profile never claims admin', !JSON.stringify(profile.data).includes('admin'));

  const own = await tool(env, access, 'list_my_shows');
  check('your own list carries your notes', own.text.includes('PAT-NOTE') && own.text.includes('REC-PAT-NOTE'));
  check('list names use the member vocabulary', own.data.shows[0].list === 'watching');
  for (let i = 0; i < 5; i++) addShow(env, { slug: 'patrick', title: `Filler ${i}`, list: 'next' });
  const p1 = await tool(env, access, 'list_my_shows', { limit: 4 });
  check('a list comes a page at a time', p1.data.shows.length === 4 && p1.data.total === 6 && p1.data.next_offset === 4);
  const p2 = await tool(env, access, 'list_my_shows', { limit: 4, offset: p1.data.next_offset });
  check('and the last page has no next_offset', p2.data.shows.length === 2 && p2.data.next_offset === undefined);
  const capped = await tool(env, access, 'list_my_shows', { limit: 100000 });
  check('an oversized limit is capped, not refused', !capped.isError && capped.data.shows.length === 6);

  const mate = await tool(env, access, 'list_member_shows', { member_slug: 'quinn' });
  check("a group-mate's titles are readable", mate.text.includes('Slow Horses') && mate.data.shows[0].list === 'loved');
  check("but never their notes, recommender or watching-with",
    !mate.text.includes('QUINN-NOTE') && !mate.text.includes('REC-') && !mate.text.includes('WITH-'));
  const stranger = await tool(env, access, 'list_member_shows', { member_slug: 'stacy' });
  check("a stranger's lists are unreachable", stranger.isError && !stranger.text.includes('Hacks'));

  const detail = await tool(env, access, 'get_show', { show_id: hers });
  check("another member's show has no memos", detail.data && !detail.text.includes('QUINN-NOTE') && detail.data.is_yours === false);
  const ownDetail = await tool(env, access, 'get_show', { show_id: mine });
  check('your own show does', ownDetail.text.includes('PAT-NOTE') && ownDetail.data.is_yours === true);

  const search = await tool(env, access, 'search_libraries', { query: 's' });
  check("library search covers group-mates", search.text.includes('Slow Horses'));
  check("and never strangers", !search.text.includes('Hacks') && !search.text.includes('STACY'));

  const edit = await tool(env, access, 'update_show', { show_id: hers, notes: 'OVERWRITTEN' });
  check("another member's row can't be edited", edit.isError && row(env, 'SELECT notes FROM shows WHERE id = ?', hers).notes === 'QUINN-NOTE');
  const mv = await tool(env, access, 'move_show', { show_id: hers, list: 'next_up' });
  check("or moved", mv.isError && row(env, 'SELECT list FROM shows WHERE id = ?', hers).list === 'recommending');
  const arch = await tool(env, access, 'archive_show', { show_id: strangers });
  check("or archived — and the tool doesn't claim it was", arch.isError && row(env, 'SELECT archived FROM shows WHERE id = ?', strangers).archived === 0);
  const del = await tool(env, access, 'delete_show', { show_id: hers });
  check("or deleted", del.isError && !!row(env, 'SELECT id FROM shows WHERE id = ?', hers));
  const rate = await tool(env, access, 'rate_show', { show_id: hers, rating: 3 });
  check("or rated", rate.isError);

  const ok1 = await tool(env, access, 'update_show', { show_id: mine, notes: 'fresh note' });
  check('your own row can be edited', !ok1.isError && row(env, 'SELECT notes FROM shows WHERE id = ?', mine).notes === 'fresh note');
  check('an edit is member intent (updated_at moves)', row(env, 'SELECT updated_at FROM shows WHERE id = ?', mine).updated_at !== '2026-08-01 00:00:00');
  const moved = await tool(env, access, 'move_show', { show_id: mine, list: 'loved' });
  check('and moved', moved.data.moved.list === 'loved' && row(env, 'SELECT list FROM shows WHERE id = ?', mine).list === 'recommending');
  const a2 = await tool(env, access, 'archive_show', { show_id: mine });
  check('and archived', !a2.isError && row(env, 'SELECT archived FROM shows WHERE id = ?', mine).archived === 1);
  const back = await tool(env, access, 'restore_show', { show_id: mine, list: 'watching' });
  check('and restored', !back.isError && row(env, 'SELECT archived, list FROM shows WHERE id = ?', mine).archived === 0);
}

console.log('\n== adding a show, and Watching With stays inside groups');
{
  const { env } = club();
  const { access } = await connect(env, 'patrick');
  const add = await tool(env, access, 'add_show', { title: 'The Bear', list: 'next_up', notes: 'from a podcast', watching_with_members: ['quinn', 'stacy'] });
  check('add_show adds to your list', !add.isError && add.data.added.list === 'next_up', add.text);
  check('added_by is your name, like the app', row(env, "SELECT added_by FROM shows WHERE member_slug = 'patrick'").added_by === 'Patrick');
  check('a named group-mate gets a linked copy', !!row(env, "SELECT id FROM shows WHERE member_slug = 'quinn' AND title = 'The Bear'"));
  check('a named stranger gets nothing', !row(env, "SELECT id FROM shows WHERE member_slug = 'stacy'"));
  const dupe = await tool(env, access, 'add_show', { title: 'The Bear', list: 'watching' });
  check('a duplicate says which list it is already on', dupe.isError && dupe.text.includes('next_up'));
  const bad = await tool(env, access, 'add_show', { title: 'X', list: 'favourites' });
  check('an unknown list is explained', bad.isError && bad.text.includes('watching, awaiting, loved, next_up'));
}

console.log('\n== group actions');
{
  const { env, groupId } = club();
  const pat = await connect(env, 'patrick');
  const quinn = await connect(env, 'quinn');
  const mine = addShow(env, { slug: 'patrick', title: 'Severance', notes: 'n' });

  const rec = await tool(env, pat.access, 'recommend_to_group', { group_id: groupId, show_id: mine, note: 'so good' });
  check('you can recommend your own show to your group', !rec.isError, rec.text);
  const board = await tool(env, quinn.access, 'get_group_recommendations', { group_id: groupId });
  const card = board.data.recommendations[0];
  check("a group-mate sees the card", card && card.title === 'Severance');
  const taken = await tool(env, quinn.access, 'respond_to_recommendation', { group_id: groupId, recommendation_id: card.id, response: 'add' });
  check('and can add it to their own Next Up', !taken.isError && row(env, "SELECT list FROM shows WHERE member_slug = 'quinn' AND title = 'Severance'").list === 'next');
  const outsider = await connect(env, 'stacy');
  const peek = await tool(env, outsider.access, 'get_group_recommendations', { group_id: groupId });
  check("a stranger can't read the board", peek.isError);
  const peekGroup = await tool(env, outsider.access, 'get_group', { group_id: groupId });
  check("or the group", peekGroup.isError);
  const invite = await tool(env, outsider.access, 'create_group_invite', { group_id: groupId });
  check("or mint an invite to it", invite.isError && row(env, 'SELECT COUNT(*) AS n FROM group_invites').n === 0);

  const made = await tool(env, pat.access, 'create_group', { name: 'Book Club' });
  check('create_group returns an invite link', !made.isError && made.data.invite.url.includes('/groups/join?token='));
  const left = await tool(env, quinn.access, 'leave_group', { group_id: groupId });
  check('leave_group leaves', !left.isError && !row(env, "SELECT 1 AS x FROM group_members WHERE group_id = ? AND member_slug = 'quinn'", groupId));
  const gone = await tool(env, pat.access, 'list_member_shows', { member_slug: 'quinn' });
  check("once you share no group, their lists close", gone.isError);
}

console.log('\n== never admin');
{
  const { env } = club();
  const req = auth.actingAs(new Request(`${ORIGIN}/api/reporting`), { member_slug: 'patrick', email: 'Patrick' });
  check("an admin's delegated request fails the admin gate", (await admin.getAdminSession(req, env)) === null);
  const rep = await reportingApi.onRequestGet(ctx(env, req));
  check('so an admin endpoint answers 403', rep.status === 403);
  const listReq = auth.actingAs(new Request(`${ORIGIN}/api/connected-apps`), { member_slug: 'patrick', email: 'Patrick' });
  check("and a connection can't list or revoke connections", (await connectedApps.onRequestGet(ctx(env, listReq))).status === 401);
}

console.log('\n== revocation, bans and caps');
{
  const { env } = club();
  const c = await connect(env, 'quinn');
  const pat = addSession(env, 'patrick');
  const listFor = async (cookie) => (await (await connectedApps.onRequestGet(ctx(env,
    new Request(`${ORIGIN}/api/connected-apps`, { headers: { Cookie: `session=${cookie}` } })))).json());
  const quinnsApps = await listFor(c.cookie);
  check('Connected apps lists the connection', quinnsApps.apps.length === 1 && quinnsApps.apps[0].name === 'Claude' && quinnsApps.apps[0].host === 'claude.ai');
  check("and nobody else's", (await listFor(pat)).apps.length === 0);
  const grantId = quinnsApps.apps[0].id;
  const del = (cookie) => connectedApps.onRequestDelete(ctx(env,
    new Request(`${ORIGIN}/api/connected-apps?id=${grantId}`, { method: 'DELETE', headers: { Cookie: `session=${cookie}` } })));
  check("a stranger's revoke is 404", (await del(pat)).status === 404);
  check('and changes nothing', (await rpc(env, c.access, 'tools/list', {})).status === 200);
  check('the owner can revoke', (await del(c.cookie)).status === 200);
  check('which takes effect on the next call', (await rpc(env, c.access, 'tools/list', {})).status === 401);
  const r = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
  check('and the refresh token is dead too', r.data.error === 'invalid_grant');

  const again = await connect(env, 'quinn');
  const disable = await disableApi.onRequestPost(ctx(env, new Request(`${ORIGIN}/api/admin-member-disable`, {
    method: 'POST', headers: { Cookie: `session=${pat}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'quinn', action: 'disable' }),
  })));
  check('an admin can disable a member', disable.status === 200);
  check("whose connections stop at once", (await rpc(env, again.access, 'tools/list', {})).status === 401);
  env._db.prepare("UPDATE members SET disabled = 0 WHERE slug = 'quinn'").run();
  check("and don't come back on re-enable", (await rpc(env, again.access, 'tools/list', {})).status === 401);

  const p = await connect(env, 'patrick');
  const revoked = await revoke.onRequestPost(ctx(env, new Request(`${ORIGIN}/oauth/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: p.refresh, client_id: p.clientId }).toString(),
  })));
  check('an app can disconnect itself (RFC 7009)', revoked.status === 200 && (await rpc(env, p.access, 'tools/list', {})).status === 401);

  const q = await connect(env, 'patrick');
  check('the default write cap is 1,000 a day', tools.dailyCaps({}).writes === 1000);
  check('MCP_DAILY_WRITE_LIMIT overrides it', tools.dailyCaps({ MCP_DAILY_WRITE_LIMIT: '250' }).writes === 250);
  check('and junk, zero or negative falls back instead of refusing every change',
    ['abc', '0', '-5', ''].every((v) => tools.dailyCaps({ MCP_DAILY_WRITE_LIMIT: v }).writes === 1000));
  env._db.prepare("INSERT INTO mcp_usage (member_slug, day, calls, writes, searches) VALUES ('patrick', date('now'), 0, ?, 0)").run(tools.DAILY_CAPS.writes - 1);
  const last = await tool(env, q.access, 'add_show', { title: 'Andor', list: 'watching' });
  check('the last write under the cap goes through', !last.isError && row(env, "SELECT id FROM shows WHERE title = 'Andor'"));
  const w = await tool(env, q.access, 'add_show', { title: 'Severance', list: 'watching' });
  check('the daily write cap refuses the next write', w.isError && w.text.includes('limit of 1,000 changes') && w.text.includes('midnight UTC') && !row(env, "SELECT id FROM shows WHERE title = 'Severance'"));
  check('while reads still work', !(await tool(env, q.access, 'get_profile')).isError);
  env._db.prepare("UPDATE mcp_usage SET calls = 100000 WHERE member_slug = 'patrick'").run();
  check('reads never count toward a limit, however many', !(await tool(env, q.access, 'get_profile')).isError);
  env._db.prepare("UPDATE mcp_usage SET searches = ? WHERE member_slug = 'patrick'").run(tools.DAILY_CAPS.searches);
  check('the search cap is 1,000 a day', tools.DAILY_CAPS.searches === 1000);
  const srch = await tool(env, q.access, 'search_titles', { query: 'andor' });
  check('the search cap refuses a catalog search', srch.isError && srch.text.includes('limit of 1,000 catalog searches'));
  env._db.prepare("UPDATE mcp_usage SET day = date('now', '-1 day') WHERE member_slug = 'patrick'").run();
  check('and resets the next day', !(await tool(env, q.access, 'add_show', { title: 'Severance', list: 'watching' })).isError);
  const e2 = { ...env, MCP_DAILY_WRITE_LIMIT: '3' };
  env._db.prepare("UPDATE mcp_usage SET writes = 3 WHERE member_slug = 'patrick' AND day = date('now')").run();
  const lowered = await tool(e2, q.access, 'rate_show', { show_id: row(env, "SELECT id FROM shows WHERE title = 'Andor'").id, rating: 8 });
  check('the env limit is the one enforced', lowered.isError && lowered.text.includes('limit of 3 changes'));
}

console.log('\n== reporting counts connected people, not connections');
{
  const { env } = club();
  await connect(env, 'patrick');
  await connect(env, 'patrick');
  await connect(env, 'quinn');
  const res = await reportingApi.onRequestGet(ctx(env, new Request(`${ORIGIN}/api/reporting`, { headers: { Cookie: `session=${addSession(env, 'patrick')}` } })));
  const data = await res.json();
  check('two people with three connections read as 2', data.active_by_platform.day.mcp === 2, JSON.stringify(data.active_by_platform));
}

await Promise.allSettled(waits);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

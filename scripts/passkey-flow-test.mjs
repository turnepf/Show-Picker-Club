// End-to-end tests for the passkey endpoints, driven through the real
// handlers against a real SQLite database.
//
//   node scripts/passkey-flow-test.mjs
//
// scripts/webauthn-test.mjs covers the cryptography; this covers everything
// around it that decides who gets a session — challenges being single-use,
// registration and authentication challenges not being interchangeable, a
// credential never attaching to an account other than the one that asked for
// it, and a disabled member staying out.
//
// The functions tree is copied to a temp directory with a `type: module`
// package.json so Node loads the .js files as the ES modules they are — the
// repo itself has no package.json on purpose (see CLAUDE.md). schema.sql is
// loaded into node:sqlite, and a thin shim gives it D1's prepare/bind/
// first/all/run/batch surface, so the SQL under test is executed, not faked.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'passkey-flow-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const registerBegin = await load('auth/passkey-register-begin.js');
const registerFinish = await load('auth/passkey-register-finish.js');
const authBegin = await load('auth/passkey-begin.js');
const authFinish = await load('auth/passkey-finish.js');
const passkeyList = await load('api/passkeys.js');
const passkeyDelete = await load('api/passkeys/[id].js');
const { bytesToB64url, b64urlToBytes } = await load('_shared/webauthn.js');

const ORIGIN = 'https://showpicker.club';
const RP_ID = 'showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    // node:sqlite rejects undefined; D1 treats a missing value as NULL.
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

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    },
    _db: db,
  };
}

function addMember(env, slug, { disabled = 0 } = {}) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, ?)'
  ).run(slug, `${slug} Member`, slug, disabled);
}

function addSession(env, slug) {
  const id = `session-${slug}`;
  const expires = new Date(Date.now() + 86400000).toISOString();
  env._db.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, slug, slug, expires, new Date().toISOString());
  return id;
}

function post(path, body, { cookie, ip = '203.0.113.9' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

// ---- authenticator simulation (see scripts/webauthn-test.mjs) ----

function head(major, length) {
  if (length < 24) return Uint8Array.from([(major << 5) | length]);
  if (length < 256) return Uint8Array.from([(major << 5) | 24, length]);
  if (length < 65536) return Uint8Array.from([(major << 5) | 25, length >> 8, length & 0xff]);
  return Uint8Array.from([(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}
function cat(...chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function cborEncode(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return cat(head(3, b.length), b);
  }
  if (v instanceof Map) return cat(head(5, v.size), ...[...v].map(([k, x]) => cat(cborEncode(k), cborEncode(x))));
  throw new Error('unsupported');
}
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

async function authData({ rpId = RP_ID, flags, signCount = 0, credentialId, cose }) {
  const counter = Uint8Array.from([(signCount >>> 24) & 0xff, (signCount >> 16) & 0xff, (signCount >> 8) & 0xff, signCount & 0xff]);
  let out = cat(await sha256(new TextEncoder().encode(rpId)), Uint8Array.from([flags]), counter);
  if (flags & 0x40) {
    out = cat(out, new Uint8Array(16).fill(3),
              Uint8Array.from([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]),
              credentialId, cose);
  }
  return out;
}
const clientData = (type, challenge, origin = ORIGIN) =>
  bytesToB64url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));

function rawToDer(raw) {
  const trim = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = cat(Uint8Array.from([0]), v);
    return v;
  };
  const r = trim(raw.slice(0, 32)), s = trim(raw.slice(32, 64));
  const body = cat(Uint8Array.from([0x02, r.length]), r, Uint8Array.from([0x02, s.length]), s);
  return cat(Uint8Array.from([0x30, body.length]), body);
}

// A simulated platform authenticator holding one credential.
async function makeDevice() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const cose = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlToBytes(jwk.x)], [-3, b64urlToBytes(jwk.y)]]));
  const credentialId = crypto.getRandomValues(new Uint8Array(32));

  return {
    credentialIdB64: bytesToB64url(credentialId),
    async register(challenge) {
      const ad = await authData({ flags: 0x01 | 0x04 | 0x40, credentialId, cose });
      return {
        challenge,
        credential_id: bytesToB64url(credentialId),
        attestation_object: bytesToB64url(cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
        client_data_json: clientData('webauthn.create', challenge),
      };
    },
    async assert(challenge) {
      const ad = await authData({ flags: 0x01 | 0x04 });
      const cdj = clientData('webauthn.get', challenge);
      const signed = cat(ad, await sha256(b64urlToBytes(cdj)));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed));
      return {
        challenge,
        credential_id: bytesToB64url(credentialId),
        authenticator_data: bytesToB64url(ad),
        client_data_json: cdj,
        signature: bytesToB64url(rawToDer(raw)),
      };
    },
  };
}

// ---- scenarios ----

console.log('\n== register a passkey, then sign in with it');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const cookie = addSession(env, 'patrick');
  const device = await makeDevice();

  const beginResp = await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie }) });
  const options = await beginResp.json();
  check('register-begin returns options to a signed-in member', beginResp.status === 200 && !!options.challenge);
  check('user handle is the member slug', new TextDecoder().decode(b64urlToBytes(options.user.id)) === 'patrick');
  check('relying party is the site', options.rp.id === RP_ID);
  check('asks for a discoverable, verified credential',
        options.authenticatorSelection.residentKey === 'required'
        && options.authenticatorSelection.userVerification === 'required');

  const finishResp = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', await device.register(options.challenge), { cookie }),
  });
  check('register-finish accepts the credential', finishResp.status === 200);
  const stored = env._db.prepare('SELECT * FROM member_passkeys WHERE member_slug = ?').all('patrick');
  check('credential is stored against the member', stored.length === 1 && stored[0].credential_id === device.credentialIdB64);

  // Now sign in from a logged-out client — no cookie, no identifier.
  const authOptions = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  check('passkey-begin needs no session and no identifier', !!authOptions.challenge);

  const signInResp = await authFinish.onRequestPost({
    env, request: post('/auth/passkey-finish', await device.assert(authOptions.challenge)),
  });
  const signInBody = await signInResp.json();
  check('sign-in succeeds', signInResp.status === 200 && signInBody.success === true);
  check('sign-in resolves the right member', signInBody.slug === 'patrick');
  check('sign-in sets a session cookie',
        (signInResp.headers.get('Set-Cookie') || '').includes('HttpOnly'));

  const method = env._db.prepare("SELECT auth_method FROM sessions WHERE auth_method = 'passkey'").all();
  check('session is stamped auth_method=passkey', method.length === 1);
  const used = env._db.prepare('SELECT last_used_at FROM member_passkeys WHERE member_slug = ?').all('patrick');
  check('last_used_at is recorded', !!used[0].last_used_at);
}

console.log('\n== a challenge is single-use');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const cookie = addSession(env, 'patrick');
  const device = await makeDevice();

  const options = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie }) })).json();
  await registerFinish.onRequestPost({ env, request: post('/auth/passkey-register-finish', await device.register(options.challenge), { cookie }) });

  const authOptions = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  const assertion = await device.assert(authOptions.challenge);

  const first = await authFinish.onRequestPost({ env, request: post('/auth/passkey-finish', assertion) });
  check('the assertion works once', first.status === 200);

  // Byte-for-byte replay — what a network attacker would have captured.
  const replay = await authFinish.onRequestPost({ env, request: post('/auth/passkey-finish', assertion) });
  check('the identical assertion is refused on replay', replay.status === 400);
  check('no challenge rows survive', env._db.prepare('SELECT * FROM webauthn_challenges').all().length === 0);
}

console.log('\n== challenges are bound to their purpose and their member');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addMember(env, 'whitt');
  const patrickCookie = addSession(env, 'patrick');
  const whittCookie = addSession(env, 'whitt');
  const device = await makeDevice();

  // A sign-in challenge must not be usable to enroll a credential.
  const authOptions = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  const crossPurpose = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', await device.register(authOptions.challenge), { cookie: patrickCookie }),
  });
  check('an authenticate challenge cannot register a credential', crossPurpose.status === 400);

  // Patrick's registration challenge, completed by Whitt's session: the
  // credential must not land on either account.
  const patrickOptions = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie: patrickCookie }) })).json();
  const hijack = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', await device.register(patrickOptions.challenge), { cookie: whittCookie }),
  });
  check('another member cannot complete your registration', hijack.status === 400);
  check('nothing was written', env._db.prepare('SELECT * FROM member_passkeys').all().length === 0);

  // And a credential already owned can't be re-pointed at a second account.
  const own = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie: patrickCookie }) })).json();
  await registerFinish.onRequestPost({ env, request: post('/auth/passkey-register-finish', await device.register(own.challenge), { cookie: patrickCookie }) });
  const whittOptions = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie: whittCookie }) })).json();
  const steal = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', await device.register(whittOptions.challenge), { cookie: whittCookie }),
  });
  check('a registered credential cannot be moved to another account', steal.status === 409);
  const owner = env._db.prepare('SELECT member_slug FROM member_passkeys WHERE credential_id = ?').all(device.credentialIdB64);
  check('it still belongs to the original member', owner[0].member_slug === 'patrick');
}

console.log('\n== registration requires a session');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const anon = await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}) });
  check('register-begin refuses an anonymous caller', anon.status === 401);
  const anonFinish = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', { challenge: 'x', attestation_object: 'y', client_data_json: 'z' }),
  });
  check('register-finish refuses an anonymous caller', anonFinish.status === 401);
}

console.log('\n== unknown and disabled credentials are refused');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const cookie = addSession(env, 'patrick');
  const device = await makeDevice();
  const stranger = await makeDevice();

  const options = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie }) })).json();
  await registerFinish.onRequestPost({ env, request: post('/auth/passkey-register-finish', await device.register(options.challenge), { cookie }) });

  const a = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  const unknown = await authFinish.onRequestPost({ env, request: post('/auth/passkey-finish', await stranger.assert(a.challenge)) });
  check('an unregistered credential is refused', unknown.status === 401);

  // A credential whose signature doesn't match the stored key.
  const b = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  const forged = await stranger.assert(b.challenge);
  forged.credential_id = device.credentialIdB64;   // claim the real member's credential
  const forgedResp = await authFinish.onRequestPost({ env, request: post('/auth/passkey-finish', forged) });
  check('a forged signature is refused', forgedResp.status === 401);

  env._db.prepare('UPDATE members SET disabled = 1 WHERE slug = ?').run('patrick');
  const c = await (await authBegin.onRequestPost({ env, request: post('/auth/passkey-begin', {}) })).json();
  const banned = await authFinish.onRequestPost({ env, request: post('/auth/passkey-finish', await device.assert(c.challenge)) });
  check('a disabled member cannot sign in with their passkey', banned.status === 401);
}

console.log('\n== listing and removing are scoped to the member');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  addMember(env, 'whitt');
  const patrickCookie = addSession(env, 'patrick');
  const whittCookie = addSession(env, 'whitt');
  const device = await makeDevice();

  const options = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie: patrickCookie }) })).json();
  await registerFinish.onRequestPost({
    env,
    request: post('/auth/passkey-register-finish',
                  { ...(await device.register(options.challenge)), label: "Patrick's iPhone" },
                  { cookie: patrickCookie }),
  });

  const listReq = new Request(ORIGIN + '/api/passkeys', { headers: { Cookie: `session=${patrickCookie}` } });
  const mine = await (await passkeyList.onRequestGet({ env, request: listReq })).json();
  check('the owner sees their passkey', mine.passkeys.length === 1);
  check('the label is kept', mine.passkeys[0].label === "Patrick's iPhone");
  check('the public key is not published', !('public_key' in mine.passkeys[0]));

  const otherReq = new Request(ORIGIN + '/api/passkeys', { headers: { Cookie: `session=${whittCookie}` } });
  const theirs = await (await passkeyList.onRequestGet({ env, request: otherReq })).json();
  check('another member sees none of it', theirs.passkeys.length === 0);

  const anonList = await passkeyList.onRequestGet({ env, request: new Request(ORIGIN + '/api/passkeys') });
  check('listing requires a session', anonList.status === 401);

  const delReq = (cookie) => new Request(ORIGIN + '/api/passkeys/' + device.credentialIdB64,
                                         { method: 'DELETE', headers: { Cookie: `session=${cookie}` } });
  const foreignDelete = await passkeyDelete.onRequestDelete({ env, request: delReq(whittCookie), params: { id: device.credentialIdB64 } });
  check('another member cannot delete it', foreignDelete.status === 404);
  check('and it is still there', env._db.prepare('SELECT * FROM member_passkeys').all().length === 1);

  const ownDelete = await passkeyDelete.onRequestDelete({ env, request: delReq(patrickCookie), params: { id: device.credentialIdB64 } });
  check('the owner can delete it', ownDelete.status === 200);
  check('and it is gone', env._db.prepare('SELECT * FROM member_passkeys').all().length === 0);
}

console.log('\n== expired challenges are refused');
{
  const env = makeEnv();
  addMember(env, 'patrick');
  const cookie = addSession(env, 'patrick');
  const device = await makeDevice();

  const options = await (await registerBegin.onRequestPost({ env, request: post('/auth/passkey-register-begin', {}, { cookie }) })).json();
  env._db.prepare('UPDATE webauthn_challenges SET expires_at = ? WHERE challenge = ?')
    .run(new Date(Date.now() - 1000).toISOString(), options.challenge);
  const late = await registerFinish.onRequestPost({
    env, request: post('/auth/passkey-register-finish', await device.register(options.challenge), { cookie }),
  });
  check('a challenge past its expiry is refused', late.status === 400);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

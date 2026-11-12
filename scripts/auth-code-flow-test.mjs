// End-to-end tests for the email login/signup code flow, driven through the
// real handlers against a real SQLite database.
//
//   node scripts/auth-code-flow-test.mjs
//
// Written after App Review rejected tvOS 1.2 on 2026-08-08: "unable to receive
// the OTP code to sign in with email (no code received even when using any
// other email)". Two independent faults produced that, and neither could fail
// a code review:
//
//   1. /auth/request-code mailed a login code to DEMO_LOGIN_EMAIL. That
//      address is demo@example.com, and Resend refuses reserved domains with
//      a 422 — which surfaced as a 502 and a dead end on the email screen,
//      one step before the fixed DEMO_LOGIN_CODE would have worked.
//   2. Signup codes for unknown emails were gated on a Turnstile token that
//      no native client can produce, so with TURNSTILE_SECRET_KEY set every
//      signup code the apps asked for was dropped — silently, behind
//      { success: true }.
//
// The fake Resend below rejects reserved domains exactly like the real one,
// so fault 1 cannot come back without failing a test.
//
// Same harness as scripts/passkey-flow-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json so Node loads the
// .js files as the ES modules they are (the repo has no package.json on
// purpose — see CLAUDE.md), and schema.sql is loaded into node:sqlite behind
// a thin D1 shim, so the SQL under test is executed, not faked.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'auth-code-flow-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const requestCode = await load('auth/request-code.js');
const login = await load('auth/login.js');
const enroll = await load('auth/enroll.js');
const logout = await load('auth/logout.js');
const apple = await load('auth/apple.js');

const ORIGIN = 'https://showpicker.club';
const DEMO_EMAIL = 'demo@example.com';
const DEMO_CODE = '424242';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

// ---- fake outbound world ----
//
// One stub for both vendors the code path reaches. `sent` records every
// accepted email; `rejected` records the ones the provider refused; every
// Turnstile token is single-use, so a second verification of the same token
// fails the way the real service does.
const mail = { sent: [], rejected: [], turnstileChecks: 0 };

// A stand-in for Apple's signing key: /auth/apple verifies the identity
// token's RS256 signature against the JWKS at appleid.apple.com, which the
// stub below serves with this key's public half.
const appleKey = await (async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  return { jwk, privateKey: pair.privateKey };
})();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function appleToken(claims) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-kid' }));
  const body = b64url(JSON.stringify({
    iss: 'https://appleid.apple.com', aud: 'net.patrickturner.showpickerios',
    exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', appleKey.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const spentTokens = new Set();

globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  const jsonRes = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (String(url).startsWith('https://api.resend.com/emails')) {
    const to = Array.isArray(body.to) ? body.to : [body.to];
    // Resend's actual behavior, and the whole reason for this suite:
    // reserved domains are refused outright with a validation error.
    if (to.some((t) => /@(example\.(com|org|net)|test|invalid|localhost)$/i.test(String(t)))) {
      mail.rejected.push({ to, subject: body.subject });
      return jsonRes({ name: 'validation_error', message: 'Invalid `to` field.' }, 422);
    }
    mail.sent.push({ to, subject: body.subject, text: body.text });
    return jsonRes({ id: 'msg_' + mail.sent.length });
  }

  if (String(url) === 'https://appleid.apple.com/auth/keys') {
    return jsonRes({ keys: [appleKey.jwk] });
  }

  if (String(url).startsWith('https://challenges.cloudflare.com/')) {
    mail.turnstileChecks++;
    const ok = body.response === 'good-token' && !spentTokens.has(body.response);
    spentTokens.add(body.response);
    return jsonRes({ success: ok });
  }

  throw new Error(`unexpected outbound fetch: ${url}`);
};

function resetOutbound() {
  mail.sent.length = 0;
  mail.rejected.length = 0;
  mail.turnstileChecks = 0;
  spentTokens.clear();
}

// ---- fixtures ----

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  resetOutbound();
  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    },
    RESEND_API_KEY: 'test-key',
    _db: db,
    ...extra,
  };
}

function addMember(env, slug, email) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, 0)'
  ).run(slug, `${slug} Member`, slug);
  if (email) {
    env._db.prepare(
      'INSERT INTO member_emails (member_slug, email, is_primary) VALUES (?, ?, 1)'
    ).run(slug, email);
  }
}

// A native client (iOS/tvOS): URLSession never sends an Origin on a POST,
// which is exactly how the server tells it apart from the web form.
function post(path, body, { origin, ip = '203.0.113.9' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

const rows = (env, sql) => env._db.prepare(sql).all();
const context = (env, request) => ({ env, request, waitUntil: () => {} });

// ---- scenarios ----

console.log('\n== the demo account never needs a mailbox');
{
  const env = makeEnv({ DEMO_LOGIN_EMAIL: DEMO_EMAIL, DEMO_LOGIN_CODE: DEMO_CODE });
  addMember(env, 'demo', DEMO_EMAIL);

  const req = post('/auth/request-code', { email: DEMO_EMAIL, channel: 'email' });
  const res = await requestCode.onRequestPost(context(env, req));
  check('asking for the demo code succeeds', res.status === 200, `got ${res.status}`);
  check('and it is a success reply', (await res.json()).success === true);
  check('no email is attempted', mail.sent.length === 0 && mail.rejected.length === 0,
        `sent ${mail.sent.length}, rejected ${mail.rejected.length}`);
  check('and no OTP row is written', rows(env, 'SELECT * FROM login_otps').length === 0);

  // The whole point: the fixed code the reviewer already has still signs in.
  const signIn = await login.onRequestPost(context(env, post('/auth/login', { email: DEMO_EMAIL, code: DEMO_CODE })));
  check('the fixed demo code signs in', signIn.status === 200, `got ${signIn.status}`);
  check('and a session cookie comes back', (signIn.headers.get('Set-Cookie') || '').includes('session='));
}

console.log('\n== asking by slug does not mail the demo address either');
{
  const env = makeEnv({ DEMO_LOGIN_EMAIL: DEMO_EMAIL, DEMO_LOGIN_CODE: DEMO_CODE });
  addMember(env, 'demo', DEMO_EMAIL);

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { member: 'demo', channel: 'email' })));
  check('the request succeeds', res.status === 200, `got ${res.status}`);
  check('and nothing is mailed', mail.sent.length === 0 && mail.rejected.length === 0);

  // A demo member with a real second address still gets a code there.
  env._db.prepare('INSERT INTO member_emails (member_slug, email, is_primary) VALUES (?, ?, 0)')
    .run('demo', 'reviewer@showpicker.club');
  const second = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { member: 'demo', channel: 'email' })));
  check('a real second address still gets one', second.status === 200 && mail.sent.length === 1);
  check('and the demo address is not on it', !JSON.stringify(mail.sent[0].to).includes(DEMO_EMAIL));
}

console.log('\n== a half-configured demo falls through instead of dead-ending');
{
  // DEMO_LOGIN_CODE unset: /auth/login can't honor a fixed code, so
  // short-circuiting the send here would lock the account out entirely.
  const env = makeEnv({ DEMO_LOGIN_EMAIL: 'demo@showpicker.club' });
  addMember(env, 'demo', 'demo@showpicker.club');

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'demo@showpicker.club', channel: 'email' })));
  check('the request still succeeds', res.status === 200);
  check('and a real login code is mailed', mail.sent.length === 1, JSON.stringify(mail.sent));
  check('and the OTP row is written', rows(env, 'SELECT * FROM login_otps').length === 1);
}

console.log('\n== the demo email with no member row is just an unknown address');
{
  const env = makeEnv({ DEMO_LOGIN_EMAIL: 'ghost@showpicker.club', DEMO_LOGIN_CODE: DEMO_CODE });
  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'ghost@showpicker.club', channel: 'email' })));
  check('the request succeeds', res.status === 200);
  check('and it is treated as a signup', rows(env, 'SELECT * FROM enroll_otps').length === 1);
  check('so a signup code is mailed', mail.sent.length === 1 && /signup code/.test(mail.sent[0].subject));
}

console.log('\n== a member gets a login code, and it logs them in');
{
  const env = makeEnv();
  addMember(env, 'patrick', 'patrick@patrickturner.net');

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' })));
  check('the request succeeds', res.status === 200);
  check('one login code is mailed', mail.sent.length === 1);

  const otp = rows(env, 'SELECT * FROM login_otps')[0];
  check('the mailed code is the stored code', mail.sent[0].subject.includes(otp.code));
  const signIn = await login.onRequestPost(
    context(env, post('/auth/login', { email: 'patrick@patrickturner.net', code: otp.code })));
  check('and it signs the member in', signIn.status === 200, `got ${signIn.status}`);
}

console.log('\n== native signup codes are not gated on a captcha no app can pass');
{
  // The regression that emptied the email signup path: TURNSTILE_SECRET_KEY
  // set, a native client (no Origin) that cannot mint a token.
  const env = makeEnv({ TURNSTILE_SECRET_KEY: 'secret' });

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'newcomer@gmail.com', channel: 'email' })));
  check('the request succeeds', res.status === 200);
  check('a signup code is actually mailed', mail.sent.length === 1, JSON.stringify(mail.rejected));
  check('and stored to verify against', rows(env, 'SELECT * FROM enroll_otps').length === 1);
  check('no captcha check is attempted for a native caller', mail.turnstileChecks === 0);

  const code = rows(env, 'SELECT * FROM enroll_otps')[0].code;
  const signIn = await login.onRequestPost(
    context(env, post('/auth/login', { email: 'newcomer@gmail.com', code })));
  check('the signup code asks for a name', signIn.status === 200 && (await signIn.json()).needs_name === true);
}

console.log('\n== the web form still has to pass Turnstile');
{
  const env = makeEnv({ TURNSTILE_SECRET_KEY: 'secret' });
  addMember(env, 'patrick', 'patrick@patrickturner.net');

  const noToken = await requestCode.onRequestPost(context(env, post(
    '/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' }, { origin: ORIGIN })));
  check('a browser with no token is refused', noToken.status === 403, `got ${noToken.status}`);
  check('and nothing is mailed', mail.sent.length === 0);

  const badToken = await requestCode.onRequestPost(context(env, post(
    '/auth/request-code', { email: 'stranger@gmail.com', channel: 'email', turnstile_token: 'nope' }, { origin: ORIGIN })));
  check('a bad token is refused the same way for a stranger', badToken.status === 403);

  const before = mail.turnstileChecks;
  const good = await requestCode.onRequestPost(context(env, post(
    '/auth/request-code', { email: 'stranger@gmail.com', channel: 'email', turnstile_token: 'good-token' }, { origin: ORIGIN })));
  check('a good token gets the signup code through', good.status === 200 && mail.sent.length === 1);
  // Single-use: the token is verified once, at the front door. A second
  // check downstream would spend it and fail — which is what used to happen.
  check('and the token is verified exactly once',
        mail.turnstileChecks - before === 1, `checks: ${mail.turnstileChecks - before}`);
}

console.log('\n== a refused address is reported, not swallowed');
{
  const env = makeEnv();

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'someone@example.com', channel: 'email' })));
  check('the provider refusal surfaces as 502', res.status === 502, `got ${res.status}`);
  check('and says so', (await res.json()).error === 'send_failed');
  check('the provider did refuse it', mail.rejected.length === 1 && mail.sent.length === 0);
}

console.log('\n== a member address that bounces reports the same way');
{
  const env = makeEnv();
  addMember(env, 'ghost', 'ghost@example.com');

  const res = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'ghost@example.com', channel: 'email' })));
  check('member and stranger fail identically', res.status === 502, `got ${res.status}`);
}

// These three blocks use @dummy-mailbox.net rather than the @example.com the
// rest of the suite prefers: the fake Resend above refuses reserved domains
// exactly like the real one, and a cap test has to count messages that were
// actually accepted.
console.log('\n== the hourly caps actually fire');
{
  // Every one of these windows compared a JavaScript ISO string against a
  // column carrying SQLite's own datetime('now') format. TEXT comparison is
  // byte-wise and ' ' sorts below 'T', so the predicate was false for every
  // row written on the same UTC day: the caps counted zero and never fired
  // for roughly 23 hours out of every 24. These cases fail against the raw
  // comparison and pass against datetime() on both sides.
  const env = makeEnv();
  addMember(env, 'patrick', 'patrick@patrickturner.net');

  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await requestCode.onRequestPost(
      context(env, post('/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' })));
    lastStatus = res.status;
  }
  check('a sixth code inside the hour is refused', lastStatus === 429, `got ${lastStatus}`);
  check('and five is what was actually mailed', mail.sent.length === 5, `sent ${mail.sent.length}`);
  check('the refused request minted no row',
    rows(env, 'SELECT id FROM login_otps').length === 5);
}

console.log('\n== the per-IP cap covers signup codes, not just member codes');
{
  // The signup branch writes enroll_otps and returned before reaching the
  // shared per-IP check, so one source could spend the whole allowance on
  // member codes and then spend it again on signup codes to addresses of
  // its choosing. Both paths now draw on one budget.
  const env = makeEnv();
  addMember(env, 'patrick', 'patrick@patrickturner.net');

  // Ten strangers from one IP exhausts the per-IP hourly budget.
  for (let i = 0; i < 10; i++) {
    await requestCode.onRequestPost(
      context(env, post('/auth/request-code', { email: `stranger${i}@dummy-mailbox.net`, channel: 'email' })));
  }
  check('ten signup codes went out', mail.sent.length === 10, `sent ${mail.sent.length}`);

  const before = mail.sent.length;
  const eleventh = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'stranger99@dummy-mailbox.net', channel: 'email' })));
  check('an eleventh signup code from the same IP mails nothing',
    mail.sent.length === before, `sent ${mail.sent.length - before} more`);
  check('and still answers success, so it cannot be used to probe membership',
    eleventh.status === 200, `got ${eleventh.status}`);

  // The member path draws on the same budget rather than a fresh one.
  const memberRes = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' })));
  check('a member code from the exhausted IP is refused too',
    memberRes.status === 429, `got ${memberRes.status}`);

  // A different source is unaffected — the cap is per-IP, not global.
  const other = await requestCode.onRequestPost(
    context(env, post('/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' }, { ip: '198.51.100.7' })));
  check('another IP is unaffected', other.status === 200, `got ${other.status}`);
}

console.log('\n== the per-address signup cap fires');
{
  const env = makeEnv();
  for (let i = 0; i < 4; i++) {
    await requestCode.onRequestPost(
      context(env, post('/auth/request-code', { email: 'newcomer@dummy-mailbox.net', channel: 'email' })));
  }
  check('a fourth code to one address is not sent', mail.sent.length === 3, `sent ${mail.sent.length}`);
  check('and only three rows exist',
    rows(env, 'SELECT id FROM enroll_otps').length === 3);
}


// ---- security audit run-2 ----

// `site` is what a browser puts in Sec-Fetch-Site; `origin` its Origin.
function browserPost(path, body, { origin, site, ip = '203.0.113.9' } = {}) {
  const headers = { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (site) headers['Sec-Fetch-Site'] = site;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

console.log('\n== another site cannot sign a visitor into an account (login CSRF)');
{
  // The demo login is valid credentials anyone holds, which is exactly what a
  // login-CSRF page would auto-submit (as an enctype=text/plain form) to swap
  // the visitor into an account the attacker controls.
  const env = makeEnv({ DEMO_LOGIN_EMAIL: DEMO_EMAIL, DEMO_LOGIN_CODE: DEMO_CODE });
  addMember(env, 'demo', DEMO_EMAIL);
  const creds = { email: DEMO_EMAIL, code: DEMO_CODE };

  for (const [label, opts] of [
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['Sec-Fetch-Site: cross-site', { site: 'cross-site' }],
    ['cross-site with our own Origin spoofed', { site: 'cross-site', origin: ORIGIN }],
  ]) {
    const res = await login.onRequestPost(context(env, browserPost('/auth/login', creds, opts)));
    check(`/auth/login refuses ${label} with 403`, res.status === 403, `got ${res.status}`);
    check(`  and says cross_site`, (await res.json()).error === 'cross_site');
    check(`  and sets no cookie`, !res.headers.get('Set-Cookie'));
  }
  check('no session row was minted', rows(env, 'SELECT id FROM sessions').length === 0);

  const same = await login.onRequestPost(context(env, browserPost('/auth/login', creds, { origin: ORIGIN, site: 'same-origin' })));
  check('our own web page still signs in', same.status === 200 && (same.headers.get('Set-Cookie') || '').includes('session='), `got ${same.status}`);
  const native = await login.onRequestPost(context(env, post('/auth/login', creds)));
  check('a native client (no Origin, no Sec-Fetch-Site) still signs in', native.status === 200, `got ${native.status}`);

  const env2 = makeEnv();
  env2._db.prepare("INSERT INTO enroll_otps (email, code, expires_at) VALUES ('new@dummy-mailbox.net', '111111', ?)")
    .run(new Date(Date.now() + 600000).toISOString());
  const enr = await enroll.onRequestPost(context(env2, browserPost('/auth/enroll',
    { email: 'new@dummy-mailbox.net', code: '111111', full_name: 'New Person' }, { origin: 'https://evil.example' })));
  check('/auth/enroll refuses a foreign Origin', enr.status === 403 && (await enr.json()).error === 'cross_site', `got ${enr.status}`);
  check('  and creates no member', rows(env2, 'SELECT slug FROM members').length === 0);

  const rc = await requestCode.onRequestPost(context(env2, browserPost('/auth/request-code',
    { email: 'victim@dummy-mailbox.net', channel: 'email' }, { site: 'cross-site' })));
  check('/auth/request-code refuses a cross-site browser', rc.status === 403 && (await rc.json()).error === 'cross_site', `got ${rc.status}`);
  check('  and mails nothing', mail.sent.length === 0);

  const ap = await apple.onRequestPost(context(env2, browserPost('/auth/apple',
    { identity_token: await appleToken({ sub: 'x', email: 'a@dummy-mailbox.net', email_verified: true }) }, { origin: 'https://evil.example' })));
  check('/auth/apple refuses a foreign Origin', ap.status === 403, `got ${ap.status}`);
}

console.log('\n== an account-delete code does not sign anyone in');
{
  // Both live in login_otps; only channel tells them apart.
  const env = makeEnv();
  addMember(env, 'patrick', 'patrick@patrickturner.net');
  env._db.prepare("INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES ('patrick', '777777', 'delete', ?)")
    .run(new Date(Date.now() + 600000).toISOString());
  const res = await login.onRequestPost(context(env, post('/auth/login', { email: 'patrick@patrickturner.net', code: '777777' })));
  check('a delete code is 401 at /auth/login', res.status === 401, `got ${res.status}`);
  check('and mints no session', !res.headers.get('Set-Cookie') && rows(env, 'SELECT id FROM sessions').length === 0);

  env._db.prepare("INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES ('patrick', '888888', 'email', ?)")
    .run(new Date(Date.now() + 600000).toISOString());
  const ok = await login.onRequestPost(context(env, post('/auth/login', { email: 'patrick@patrickturner.net', code: '888888' }, { ip: '198.51.100.20' })));
  check('an email login code still signs in', ok.status === 200, `got ${ok.status}`);
}

console.log('\n== ten wrong signup codes for one email lock it, whatever the IPs');
{
  const EMAIL = 'target@dummy-mailbox.net';
  const seed = () => {
    const env = makeEnv();
    env._db.prepare('INSERT INTO enroll_otps (email, code, expires_at) VALUES (?, ?, ?)')
      .run(EMAIL, '123456', new Date(Date.now() + 600000).toISOString());
    return env;
  };
  const env = seed();
  let statuses = [];
  for (let i = 0; i < 10; i++) {
    const res = await login.onRequestPost(context(env, post('/auth/login', { email: EMAIL, code: String(900000 + i) }, { ip: `192.0.2.${i + 1}` })));
    statuses.push(res.status);
  }
  check('each wrong guess from a fresh IP is a 401', statuses.every((s) => s === 401), statuses.join(','));
  const right = await login.onRequestPost(context(env, post('/auth/login', { email: EMAIL, code: '123456' }, { ip: '192.0.2.200' })));
  check('then the right code from yet another IP is 429', right.status === 429, `got ${right.status}`);
  check('and the live signup code was spent', rows(env, `SELECT used_at FROM enroll_otps WHERE email = '${EMAIL}'`).every((r) => r.used_at),
    JSON.stringify(rows(env, 'SELECT used_at FROM enroll_otps')));
  const viaEnroll = await enroll.onRequestPost(context(env, post('/auth/enroll', { email: EMAIL, code: '123456', full_name: 'Target Person' }, { ip: '192.0.2.201' })));
  check('/auth/enroll refuses it as well', viaEnroll.status === 429, `got ${viaEnroll.status}`);
  check('and no member was created', rows(env, 'SELECT slug FROM members').length === 0);
  check('the failure log holds no email address', !JSON.stringify(rows(env, 'SELECT * FROM failed_logins')).includes('dummy-mailbox'));

  // The same lockout through /auth/enroll's own wrong guesses.
  const env2 = seed();
  for (let i = 0; i < 10; i++) {
    await enroll.onRequestPost(context(env2, post('/auth/enroll', { email: EMAIL, code: String(900000 + i), full_name: 'Target Person' }, { ip: `192.0.2.${i + 1}` })));
  }
  const after = await enroll.onRequestPost(context(env2, post('/auth/enroll', { email: EMAIL, code: '123456', full_name: 'Target Person' }, { ip: '192.0.2.250' })));
  check('wrong guesses at /auth/enroll lock the email too', after.status === 429, `got ${after.status}`);

  // Nine wrong guesses leave the right code working.
  const env3 = seed();
  for (let i = 0; i < 9; i++) {
    await login.onRequestPost(context(env3, post('/auth/login', { email: EMAIL, code: String(900000 + i) }, { ip: `192.0.2.${i + 1}` })));
  }
  const ok = await login.onRequestPost(context(env3, post('/auth/login', { email: EMAIL, code: '123456' }, { ip: '192.0.2.200' })));
  check('under the cap the right code still asks for a name', ok.status === 200 && (await ok.json()).needs_name === true, `got ${ok.status}`);
}

console.log('\n== a club-wide ceiling on signup codes sends nothing past it');
{
  // Hourly: 20 codes already out this hour, to other addresses from other IPs.
  const env = makeEnv();
  for (let i = 0; i < 20; i++) {
    env._db.prepare('INSERT INTO enroll_otps (email, code, ip, expires_at) VALUES (?, ?, ?, ?)')
      .run(`earlier${i}@dummy-mailbox.net`, '000000', `10.0.0.${i}`, new Date(Date.now() + 600000).toISOString());
  }
  const res = await requestCode.onRequestPost(context(env, post('/auth/request-code', { email: 'fresh@dummy-mailbox.net', channel: 'email' }, { ip: '198.51.100.50' })));
  check('past 20 an hour the reply is still success', res.status === 200, `got ${res.status}`);
  check('but nothing is mailed', mail.sent.length === 0, `sent ${mail.sent.length}`);
  check('and no code is stored', rows(env, "SELECT id FROM enroll_otps WHERE email = 'fresh@dummy-mailbox.net'").length === 0);

  // Daily: 50 in the last day, none of them this hour.
  const env2 = makeEnv();
  for (let i = 0; i < 50; i++) {
    env2._db.prepare("INSERT INTO enroll_otps (email, code, ip, expires_at, created_at) VALUES (?, ?, ?, ?, datetime('now', '-3 hours'))")
      .run(`earlier${i}@dummy-mailbox.net`, '000000', `10.0.1.${i}`, new Date(Date.now() + 600000).toISOString());
  }
  const day = await requestCode.onRequestPost(context(env2, post('/auth/request-code', { email: 'fresh@dummy-mailbox.net', channel: 'email' }, { ip: '198.51.100.51' })));
  check('past 50 a day the reply is still success', day.status === 200, `got ${day.status}`);
  check('but nothing is mailed', mail.sent.length === 0, `sent ${mail.sent.length}`);

  // Under both: it goes out.
  const env3 = makeEnv();
  for (let i = 0; i < 19; i++) {
    env3._db.prepare('INSERT INTO enroll_otps (email, code, ip, expires_at) VALUES (?, ?, ?, ?)')
      .run(`earlier${i}@dummy-mailbox.net`, '000000', `10.0.2.${i}`, new Date(Date.now() + 600000).toISOString());
  }
  await requestCode.onRequestPost(context(env3, post('/auth/request-code', { email: 'fresh@dummy-mailbox.net', channel: 'email' }, { ip: '198.51.100.52' })));
  check('the 20th code of the hour still goes out', mail.sent.length === 1, `sent ${mail.sent.length}`);
  // A member's login code is not a signup code and is never held back.
  // (env is the one already past the hourly ceiling.)
  addMember(env, 'patrick', 'patrick@patrickturner.net');
  const before = mail.sent.length;
  const member = await requestCode.onRequestPost(context(env, post('/auth/request-code', { email: 'patrick@patrickturner.net', channel: 'email' }, { ip: '198.51.100.53' })));
  check("a member's login code is not held by the signup ceiling", member.status === 200 && mail.sent.length === before + 1, `got ${member.status}, sent ${mail.sent.length - before}`);
}

console.log('\n== logout only redirects back to a page on this site');
{
  const env = makeEnv();
  const out = async (referer, method = 'POST') => {
    const headers = referer ? { Referer: referer } : {};
    const r = new Request(ORIGIN + '/auth/logout', { method, headers });
    const res = method === 'POST' ? await logout.onRequestPost(context(env, r)) : await logout.onRequestGet(context(env, r));
    return res.headers.get('Location');
  };
  check('a same-site referer comes back', (await out(`${ORIGIN}/patrick#watching`)) === '/patrick#watching');
  const proto = await out('https://evil.example//evil.example/phish');
  check("a foreign referer whose path starts '//' is not followed", proto === '/', `Location ${proto}`);
  const ownDouble = await out(`${ORIGIN}//evil.example/phish`);
  check("our own origin with a '//' path is not followed either", ownDouble === '/', `Location ${ownDouble}`);
  const foreign = await out('https://evil.example/patrick');
  check('any foreign referer falls back to /', foreign === '/', `Location ${foreign}`);
  check('GET behaves the same', (await out('https://evil.example//evil.example/x', 'GET')) === '/');
  check('no referer goes to /', (await out(null)) === '/');
}

console.log('\n== Sign in with Apple trusts an email only when Apple verified it');
{
  const seed = () => {
    const env = makeEnv();
    addMember(env, 'patrick', 'patrick@patrickturner.net');
    return env;
  };
  const signIn = async (env, claims, extra = {}) => apple.onRequestPost(context(env,
    post('/auth/apple', { identity_token: await appleToken(claims), ...extra }, { ip: `198.51.100.${Math.floor(Math.random() * 200) + 1}` })));
  const linked = (env) => rows(env, 'SELECT apple_sub, member_slug FROM member_apple_ids');

  let env = seed();
  let res = await signIn(env, { sub: 'apple-1', email: 'patrick@patrickturner.net', email_verified: false });
  check('an unverified email does not sign into the member who owns it', res.status !== 200 || !(res.headers.get('Set-Cookie') || '').includes('session='), `got ${res.status}`);
  check('and links no Apple id to them', linked(env).length === 0, JSON.stringify(linked(env)));

  env = seed();
  res = await signIn(env, { sub: 'apple-2', email: 'patrick@patrickturner.net' });
  check('an absent email_verified is treated the same', linked(env).length === 0 && !(res.headers.get('Set-Cookie') || '').includes('session='), `got ${res.status}`);

  env = seed();
  res = await signIn(env, { sub: 'apple-3', email: 'someone@dummy-mailbox.net', email_verified: 'false' }, { full_name: 'Some One' });
  check('an unverified email does not enroll a new member', rows(env, "SELECT slug FROM members WHERE slug != 'patrick'").length === 0, `got ${res.status}`);

  env = seed();
  res = await signIn(env, { sub: 'apple-4', email: 'patrick@patrickturner.net', email_verified: 'true' });
  check('a verified email (Apple sends "true") still links and signs in', res.status === 200
    && linked(env).some((r) => r.apple_sub === 'apple-4' && r.member_slug === 'patrick'), `got ${res.status}`);

  env = seed();
  env._db.prepare("INSERT INTO member_apple_ids (apple_sub, member_slug, email, created_at) VALUES ('apple-5', 'patrick', 'x', '2026-01-01')").run();
  res = await signIn(env, { sub: 'apple-5', email: 'relay@privaterelay.appleid.com', email_verified: false });
  check('an already-linked Apple id still signs in without a verified email', res.status === 200, `got ${res.status}`);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

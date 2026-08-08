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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'auth-code-flow-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const requestCode = await load('auth/request-code.js');
const login = await load('auth/login.js');

const ORIGIN = 'https://showpicker.club';
const DEMO_EMAIL = 'demo@example.com';
const DEMO_CODE = '424242';

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

// ---- fake outbound world ----
//
// One stub for both vendors the code path reaches. `sent` records every
// accepted email; `rejected` records the ones the provider refused; every
// Turnstile token is single-use, so a second verification of the same token
// fails the way the real service does.
const mail = { sent: [], rejected: [], turnstileChecks: 0 };
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

console.log(`\n${failed === 0 ? 'PASS' : 'FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

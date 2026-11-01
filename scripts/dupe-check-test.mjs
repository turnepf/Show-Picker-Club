// Tests for /api/admin-dupe-check — the monthly duplicate-account email.
//
//   node scripts/dupe-check-test.mjs
//
// Since 2026-11 the only signal is two accounts holding the same login
// email. The two older heuristics flagged mostly strangers at this size of
// club — a shared first name is routine, and an Apple "Hide My Email"
// signup with nothing else on file was nearly always a new person — so the
// properties pinned are that neither of those flags anything any more, that
// a shared address does (case and Gmail's dots / +tags ignored, nothing
// else folded), and that a reported pair is written to dupe_ignores so the
// next month stays quiet.
//
// Same harness as scripts/members-order-test.mjs: functions/ copied to a temp
// ES-module sandbox, schema.sql loaded into node:sqlite behind a D1 shim.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'dupe-check-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const dupeCheck = await import(join(sandbox, 'functions', 'api/admin-dupe-check.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
const env = {
  DB: { prepare: (sql) => new Stmt(db, sql) },
  CRON_SECRET: 'cron',
  RESEND_API_KEY: 'test',
  DEMO_LOGIN_EMAIL: 'demo@example.com',
};

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return new Response('{"id":"x"}', { status: 200 });
};

const addMember = (slug, first, last, emails) => {
  db.prepare('INSERT INTO members (slug, name, first_name, last_name) VALUES (?, ?, ?, ?)')
    .run(slug, first, first, last);
  for (const e of emails) {
    db.prepare('INSERT INTO member_emails (email, member_slug) VALUES (?, ?)').run(e, slug);
  }
};

// Shared first name, different people: no finding.
addMember('sarah', 'Sarah', 'Donnelley', ['sarah.d@example.com']);
addMember('sarahb', 'Sarah', 'Baskerville', ['sbask@example.com']);
// Relay-only signup: no finding.
addMember('george', 'George', 'M', ['abc123@privaterelay.appleid.com']);
// Same address, different case: one finding.
addMember('eric', 'Eric', 'Welch', ['Eric@Example.com']);
addMember('ericw', 'Eric', 'W', ['eric@example.com']);
// Gmail dots and +tag: one finding.
addMember('dana', 'Dana', 'Lee', ['dana.lee@gmail.com']);
addMember('dlee', 'D', 'Lee', ['danalee+tv@googlemail.com']);
// Dots matter outside Gmail: no finding.
addMember('pat', 'Pat', 'One', ['p.at@example.org']);
addMember('pat2', 'Pat', 'Two', ['pat@example.org']);
// The demo member never counts, even sharing an address.
addMember('demo', 'John', 'A', ['demo@example.com']);
addMember('johna', 'John', 'A', ['demo@example.com']);

const call = (body, secret = 'cron') => dupeCheck.onRequestPost({
  env,
  request: new Request('https://showpicker.club/api/admin-dupe-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
    body: JSON.stringify(body),
  }),
});

const denied = await call({ dry_run: true }, 'wrong');
check('a wrong cron secret is refused', denied.status === 403, `got ${denied.status}`);

const dry = await (await call({ dry_run: true })).json();
const text = (dry.findings || []).join('\n');
check('two findings, both shared emails', dry.new === 2, JSON.stringify(dry.findings));
check('same address in another case matches', /@eric\b/.test(text) && /@ericw\b/.test(text));
check('Gmail dots and +tag match', /@dana\b/.test(text) && /@dlee\b/.test(text));
check('a shared first name alone is not flagged', !/@sarah/.test(text));
check('a relay-only signup is not flagged', !/@george/.test(text));
check('dots outside Gmail still distinguish', !/@pat/.test(text));
check('the demo member never counts', !/@demo|@johna/.test(text));
check('a dry run writes and sends nothing',
  sent.length === 0 && db.prepare('SELECT COUNT(*) AS n FROM dupe_ignores').get().n === 0);

const real = await (await call({})).json();
check('a real run reports and emails', real.new === 2 && real.emailed === true && sent.length === 1);
const pairs = db.prepare('SELECT slug_a, slug_b FROM dupe_ignores ORDER BY slug_a').all()
  .map((r) => `${r.slug_a}|${r.slug_b}`);
check('reported pairs are recorded', pairs.join(',') === 'dana|dlee,eric|ericw', pairs.join(','));

const again = await (await call({})).json();
check('next month stays quiet', again.new === 0 && sent.length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

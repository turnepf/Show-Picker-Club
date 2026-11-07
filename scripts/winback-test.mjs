// The win-back email (functions/_shared/winback.js), its admin endpoint and
// the unsubscribe link, on the same harness as the other endpoint suites.
//
//   node scripts/winback-test.mjs
//
// What's pinned is who gets mailed and who never does:
//   - inactive means no visit of any kind in 60 days — a daily user who never
//     signs in again is not inactive;
//   - disabled, opted-out and the demo account are never candidates, and a
//     member is mailed once per lapse;
//   - each member gets one version, chosen awaiting → group → start → general,
//     and the shows named are their own, linked to their own cards;
//   - only an admin session or the cron secret reaches the endpoint, review
//     (which carries addresses) takes an admin session only, preview mails
//     PREVIEW_TO and nobody else, and send needs an explicit confirm;
//   - unsubscribe's GET writes nothing (mail scanners fetch every link), its
//     POST needs a valid token, and one-click POST from a mail client works.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { withLegacyShowColumns } from './lib/seed-titles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'winback-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const wb = await load('_shared/winback.js');
const api = await load('api/admin-winback.js');
const unsub = await load('api/unsubscribe.js');

const ORIGIN = 'https://showpicker.club';
const CRON = 'test-cron-secret';
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// Every Resend call is captured; nothing leaves the process.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const daysAgo = (n) => `datetime('now', '-${n} days')`;
const dateOnly = (n) => `date('now', '-${n} days')`;

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  withLegacyShowColumns(db);
  sent.length = 0;
  return {
    DB: { prepare: (sql) => new Stmt(db, sql) },
    CRON_SECRET: CRON,
    RESEND_API_KEY: 'test',
    DEMO_LOGIN_EMAIL: 'demo@example.com',
    _db: db,
  };
}

// lastSeen is days ago, or null for "seen today".
function member(env, slug, { lastSeen = 90, email = `${slug}@mail.test`, admin = 0, disabled = 0, optOut = 0, session = null } = {}) {
  env._db.exec(`INSERT INTO members (slug, name, first_name, is_admin, disabled, email_opt_out, created_at, last_login_at)
    VALUES ('${slug}', '${slug} X', '${slug[0].toUpperCase()}${slug.slice(1)}', ${admin}, ${disabled}, ${optOut}, ${daysAgo(400)}, ${daysAgo(lastSeen ?? 0)})`);
  if (email) env._db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run(email, slug);
  if (session != null) {
    env._db.exec(`INSERT INTO sessions (id, email, member_slug, expires_at, created_at, last_seen_at)
      VALUES ('s-${slug}', '${slug}@mail.test', '${slug}', '${new Date(Date.now() + 86400000).toISOString()}', ${daysAgo(session)}, ${daysAgo(session)})`);
  }
}

function show(env, slug, title, extra = {}) {
  const cols = { title, list: 'watching', member_slug: slug, archived: 0, created_at: '2026-01-01 00:00:00', ...extra };
  const keys = Object.keys(cols);
  env._db.prepare(`INSERT INTO shows (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols));
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

// Season facts live on the shared row; set them there the way enrichment does.
function premiered(env, showId, daysBack, season) {
  env._db.exec(`UPDATE titles SET season_premiere_date = ${dateOnly(daysBack)}, current_season = ${season}
    WHERE (tmdb_type, tmdb_id) IN (SELECT tmdb_type, tmdb_id FROM shows WHERE id = ${showId})`);
}

const post = (body, headers = {}) => new Request(`${ORIGIN}/api/admin-winback`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const cron = { 'X-Cron-Secret': CRON };
async function call(env, body, headers = cron) {
  const res = await api.onRequestPost({ request: post(body, headers), env });
  return { status: res.status, data: await res.json() };
}
const bySlug = (plan) => Object.fromEntries(plan.map((e) => [e.slug, e]));

console.log('\n== who counts as inactive');
{
  const env = makeEnv();
  member(env, 'gone');
  member(env, 'recent', { lastSeen: 10 });
  member(env, 'staysin', { lastSeen: 200, session: 2 });     // never signs in, opens the app daily
  member(env, 'off', { disabled: 1 });
  member(env, 'optout', { optOut: 1 });
  member(env, 'demo', { email: 'demo@example.com' });
  const p = bySlug(await wb.planWinback(env));
  check('90 days since any visit is inactive', !!p.gone);
  check('a recent sign-in is not', !p.recent);
  check('a recent session ping is not, even with an old sign-in', !p.staysin);
  check('a disabled member is never a candidate', !p.off);
  check('an opted-out member is never a candidate', !p.optout);
  check('the demo account is never a candidate', !p.demo);
}

console.log('\n== which version');
{
  const env = makeEnv();
  member(env, 'ann'); member(env, 'bob'); member(env, 'cat'); member(env, 'dan', { lastSeen: 5 }); member(env, 'eve');
  const backIds = ['Severance', 'Slow Horses', 'The Diplomat', 'Andor'].map((t, i) => {
    const id = show(env, 'ann', t, { list: 'waiting' });
    premiered(env, id, 10 + i, i + 2);
    return id;
  });
  const old = show(env, 'ann', 'Old News', { list: 'waiting' });
  premiered(env, old, 200, 1);                                 // before her last visit
  show(env, 'bob', 'Hacks');
  env._db.exec("INSERT INTO groups (id, name, creator_slug) VALUES (1, 'Porch Crew', 'dan')");
  env._db.exec("INSERT INTO group_members (group_id, member_slug) VALUES (1, 'bob'), (1, 'dan')");
  show(env, 'dan', 'Shrinking', { created_at: new Date().toISOString() });
  show(env, 'dan', 'Ted Lasso', { created_at: new Date().toISOString() });
  show(env, 'eve', 'Fargo');
  const p = bySlug(await wb.planWinback(env));
  check('awaiting shows back → awaiting', p.ann?.variant === 'awaiting');
  check('only seasons that premiered since her last visit', p.ann?.shows.length === 4);
  check('newest premiere first', p.ann?.shows[0].id === backIds[0]);
  check('a group-mate added shows → group', p.bob?.variant === 'group');
  check('group names the adder by first name and counts', p.bob?.group.adders.join() === 'Dan' && p.bob.group.added === 2);
  check('empty library → start', p.cat?.variant === 'start');
  check('everyone else → general', p.eve?.variant === 'general');

  const msg = wb.renderWinback(p.ann, { unsubscribe: 'https://u' });
  check('subject counts the shows', msg.subject === '4 shows you were waiting on are back');
  check('names three and says how many more', msg.text.includes('…and 1 more.') && !msg.text.includes('Andor'));
  check('each named show links to her own card', msg.html.includes(`${ORIGIN}/show/${backIds[0]}`));
  check('the example show links to her own copy', p.ann.example_show_id === backIds[2]
    && new RegExp(`/show/${backIds[2]}"[^>]*>The Diplomat</a>`).test(msg.html));
  check('season and date are stated', /Severance: Season 2 premiered [A-Z][a-z]{2} \d+/.test(msg.text));
  const g = wb.renderWinback(p.bob, { unsubscribe: 'https://u' });
  check('group email names the group and the count', g.subject === 'Porch Crew has been busy' && g.text.includes('Dan has added 2 shows'));
}

console.log('\n== markup in a title or group name is text');
{
  const env = makeEnv();
  member(env, 'ann');
  const id = show(env, 'ann', '<img src=x onerror=alert(1)>', { list: 'waiting' });
  premiered(env, id, 5, 1);
  const msg = wb.renderWinback((await wb.planWinback(env))[0], { unsubscribe: 'https://u' });
  check('escaped in the HTML', !msg.html.includes('<img src=x') && msg.html.includes('&lt;img'));
}

console.log('\n== the endpoint gate');
{
  const env = makeEnv();
  member(env, 'ann');
  member(env, 'boss', { admin: 1, lastSeen: 1, session: 0 });
  member(env, 'joe', { lastSeen: 1, session: 0 });
  const adminCookie = { Cookie: 'session=s-boss' };
  check('no credentials → 403', (await call(env, { mode: 'plan' }, {})).status === 403);
  check('a member session → 403', (await call(env, { mode: 'plan' }, { Cookie: 'session=s-joe' })).status === 403);
  check('a wrong secret → 403', (await call(env, { mode: 'plan' }, { 'X-Cron-Secret': 'nope' })).status === 403);
  const plan = await call(env, { mode: 'plan' });
  check('cron secret reads the plan', plan.status === 200 && plan.data.inactive === 1);
  check('plan carries no addresses', !JSON.stringify(plan.data).includes('@mail.test'));
  check('review refuses the cron secret', (await call(env, { mode: 'review' })).status === 403);
  const rev = await call(env, { mode: 'review' }, adminCookie);
  check('review for an admin session carries to, subject and body',
    rev.status === 200 && rev.data.messages[0].to === 'ann@mail.test' && rev.data.messages[0].subject && rev.data.messages[0].html);
  check('plan and review send nothing', sent.length === 0);
}

console.log('\n== preview and send');
{
  const env = makeEnv();
  member(env, 'ann'); member(env, 'bob'); member(env, 'nomail', { email: null });
  show(env, 'bob', 'Hacks');
  const pv = await call(env, { mode: 'preview' });
  check('preview sends one per version present', pv.data.sent.length === 2);
  check('preview goes only to Patrick', sent.length === 2 && sent.every((m) => m.to.length === 1 && m.to[0] === wb.PREVIEW_TO));
  check('preview stamps nobody', env._db.prepare('SELECT COUNT(*) n FROM members WHERE winback_sent_at IS NOT NULL').get().n === 0);
  check("preview's unsubscribe link can't opt the sample member out", sent.every((m) => m.html.includes('m=preview&amp;t=preview')));

  sent.length = 0;
  check('send without confirm → 400, nothing sent', (await call(env, { mode: 'send' })).status === 400 && sent.length === 0);
  const r = await call(env, { mode: 'send', confirm: 'send' });
  check('send mails each member with an address', r.data.sent === 2 && sent.length === 2);
  check('to their own address', sent.map((m) => m.to[0]).sort().join() === 'ann@mail.test,bob@mail.test');
  check('from Patrick, replies to Patrick', sent.every((m) => m.from.includes('patrick@showpicker.club') && m.reply_to === 'patrick@showpicker.club'));
  check('one-click unsubscribe headers', sent.every((m) => m.headers['List-Unsubscribe'].startsWith('<https://showpicker.club/api/unsubscribe?m=')
    && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'));
  check('nothing left to send', r.data.remaining === 0);
  sent.length = 0;
  const again = await call(env, { mode: 'send', confirm: 'send' });
  check('a second run sends nobody twice', again.data.sent === 0 && sent.length === 0);

  // Ann comes back, then goes quiet again: a new lapse.
  env._db.exec(`UPDATE members SET winback_sent_at = ${daysAgo(100)}, last_login_at = ${daysAgo(70)} WHERE slug = 'ann'`);
  const next = await call(env, { mode: 'send', confirm: 'send' });
  check('a new lapse gets a new email', next.data.sent === 1 && sent[0].to[0] === 'ann@mail.test');
}

console.log('\n== unsubscribe');
{
  const env = makeEnv();
  member(env, 'ann');
  const t = await wb.unsubscribeToken(env, 'ann');
  const optedOut = () => env._db.prepare("SELECT email_opt_out v FROM members WHERE slug = 'ann'").get().v === 1;
  const get = await unsub.onRequestGet({ request: new Request(`${ORIGIN}/api/unsubscribe?m=ann&t=${t}`), env });
  check('GET with a good token shows the button', get.status === 200 && (await get.text()).includes('<button'));
  check('GET writes nothing', !optedOut());
  const bad = await unsub.onRequestPost({ request: new Request(`${ORIGIN}/api/unsubscribe?m=ann&t=wrong`, { method: 'POST' }), env });
  check('POST with a bad token → 400, no write', bad.status === 400 && !optedOut());
  const other = await wb.unsubscribeToken(env, 'bob');
  await unsub.onRequestPost({ request: new Request(`${ORIGIN}/api/unsubscribe?m=ann&t=${other}`, { method: 'POST' }), env });
  check("another member's token doesn't work", !optedOut());
  const oneClick = await unsub.onRequestPost({ request: new Request(`${ORIGIN}/api/unsubscribe?m=ann&t=${t}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  }), env });
  check('one-click POST opts out', oneClick.status === 200 && optedOut());
  check('and she is off the list', (await wb.planWinback(env)).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

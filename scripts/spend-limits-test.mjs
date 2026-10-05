// Tests for the per-member ceilings on upstream spend, the club-wide URL
// sweep's gate, and household consent — written from the 2026-09 security
// audit, ahead of the repository going public.
//
//   node scripts/spend-limits-test.mjs
//
//   1. **Spend is metered where it happens, not where a row lands.** The row
//      caps (50 adds, 300 imported rows a day) only ever saw paths that insert.
//      The import's parse step (Claude), an edit, the suggest proxy, the
//      type-ahead search, and a duplicate add all spend on operator-held keys
//      without inserting, so none of them had any ceiling. member_spend
//      (migration 072) counts them per member per day. What's pinned is that
//      a refusal costs zero upstream calls, and that each path degrades the
//      way its clients already handle: parse and add answer 429, search
//      answers the empty shape clients treat as "no suggestions", and an edit
//      still saves what the member typed while skipping the lookup.
//   2. **A duplicate add is refused before it spends.** The duplicate check
//      used to run after enrichment, so re-adding a title you already have
//      paid for a full TMDB fan-out to be told 409.
//   3. **The club-wide URL sweep is not a member action.** POST
//      /api/sync-urls costs one write per distinct title in the whole club,
//      whoever asks. A member session now gets the old answer with nothing
//      done; the nightly job (X-Cron-Secret) and an admin run it.
//   4. **Nobody joins a household they weren't invited to.** PUT
//      /api/household wrote any slug it was handed. It can now only narrow the
//      caller's own set; the claimed side can see the claim (`member_of`) and
//      end it from their end.
//
// Same harness as scripts/shows-authz-test.mjs: the functions tree is copied
// to a temp directory with a `type: module` package.json, and schema.sql is
// loaded into node:sqlite behind a thin D1 shim, so the SQL under test runs.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Stmt } from './lib/d1.mjs';
import { fakeTmdb } from './lib/fake-tmdb.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'spend-limits-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const meter = await load('_shared/spend-meter.js');
const parseApi = await load('api/import/parse.js');
const showsApi = await load('api/shows.js');
const showApi = await load('api/shows/[id].js');
const suggestApi = await load('api/shows/suggest.js');
const searchApi = await load('api/title-search.js');
const syncUrlsApi = await load('api/sync-urls.js');
const householdApi = await load('api/household.js');
const householdRemoveApi = await load('api/household/remove.js');

const ORIGIN = 'https://showpicker.club';
const CRON = 'test-cron-secret';
const { DAILY_LIMITS } = meter;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

// ---- fake outbound world: count everything ----
//
// TMDB knows every title (an add TMDB can't identify is refused, so a
// refusal would hide the metering under test); everything else answers
// nothing useful.

const upstream = { calls: [] };
const tmdb = fakeTmdb();
globalThis.fetch = async (url) => {
  upstream.calls.push(String(url));
  const fromTmdb = tmdb.respond(url);
  if (fromTmdb) return fromTmdb;
  const target = String(url);
  if (target.startsWith('https://api.anthropic.com/')) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ items: [], trailing_section: '' }) }],
      stop_reason: 'end_turn',
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });
};

// ---- fixtures ----

function makeEnv({ withLedger = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  if (!withLedger) db.exec('DROP TABLE member_spend');
  upstream.calls.length = 0;
  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    },
    ANTHROPIC_API_KEY: 'test-key',
    TMDB_TOKEN: 'test-token',
    CRON_SECRET: CRON,
    _db: db,
  };
}

function addMember(env, slug, { admin = 0 } = {}) {
  env._db.prepare(
    'INSERT OR IGNORE INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, ?, 0)'
  ).run(slug, slug, slug, admin);
  const id = `session-${slug}`;
  env._db.prepare(
    'INSERT OR IGNORE INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, `${slug}@example.com`, slug, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return id;
}

// Put a member at the edge of a budget without making hundreds of calls.
function spendTo(env, slug, kind, used) {
  env._db.prepare(
    `INSERT INTO member_spend (member_slug, day, ${kind}) VALUES (?, date('now'), ?)
     ON CONFLICT(member_slug, day) DO UPDATE SET ${kind} = excluded.${kind}`
  ).run(slug, used);
}
const spent = (env, slug, kind) =>
  env._db.prepare(`SELECT ${kind} AS n FROM member_spend WHERE member_slug = ? AND day = date('now')`).get(slug)?.n ?? 0;

function req(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });
const tmdbCalls = () => upstream.calls.filter((u) => u.includes('themoviedb.org')).length;
const claudeCalls = () => upstream.calls.filter((u) => u.includes('anthropic.com')).length;

function addShow(env, slug, title, extra = {}) {
  const cols = { title, list: 'watching', member_slug: slug, archived: 0, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', ...extra };
  const keys = Object.keys(cols);
  env._db.prepare(`INSERT INTO shows (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols));
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

// ---- 1. the meter ----

console.log('\n== the meter counts per member and per kind, and refuses past the limit');
{
  const env = makeEnv();
  addMember(env, 'ann'); addMember(env, 'bob');
  spendTo(env, 'ann', 'claude', DAILY_LIMITS.claude - 1);
  check('the last unit under the limit is allowed', await meter.chargeSpend(env, 'ann', 'claude'));
  check('the next one is refused', !(await meter.chargeSpend(env, 'ann', 'claude')));
  check('a refused request still counts', spent(env, 'ann', 'claude') === DAILY_LIMITS.claude + 1);
  check('another member has their own budget', await meter.chargeSpend(env, 'bob', 'claude'));
  check('another kind has its own budget', await meter.chargeSpend(env, 'ann', 'lookups'));
  check('an unknown kind is never charged', await meter.chargeSpend(env, 'ann', 'nonsense'));
}

console.log('\n== the meter fails open on a database without migration 072');
{
  const env = makeEnv({ withLedger: false });
  addMember(env, 'ann');
  check('no table means allowed, not an error', await meter.chargeSpend(env, 'ann', 'lookups'));
}

// ---- 2. import parse (Claude) ----

console.log('\n== list import: Claude is metered per slice');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  const parse = () => parseApi.onRequestPost(ctx(env, req('/api/import/parse', { cookie: s, method: 'POST', body: { text: 'Severance' } })));
  const ok = await parse();
  check('a normal paste goes through', ok.status === 200, `got ${ok.status}`);
  check('and is charged one unit', spent(env, 'ann', 'claude') === 1);
  const bad = await parseApi.onRequestPost(ctx(env, req('/api/import/parse', { cookie: s, method: 'POST', body: { text: '   ' } })));
  check('an empty paste is a 400 and charges nothing', bad.status === 400 && spent(env, 'ann', 'claude') === 1);

  spendTo(env, 'ann', 'claude', DAILY_LIMITS.claude);
  upstream.calls.length = 0;
  const over = await parse();
  check('past the ceiling it is 429 rate_limited', over.status === 429 && (await over.json()).error === 'rate_limited', `got ${over.status}`);
  check('and Claude is never called', claudeCalls() === 0);
}

// ---- 3. add ----

console.log('\n== add: a duplicate is refused before anything is spent');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  addShow(env, 'ann', 'Severance');
  const res = await showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: s, method: 'POST', body: { title: 'severance', list: 'next' } })));
  const body = await res.json();
  check('409 exists_active', res.status === 409 && body.error === 'exists_active', `got ${res.status} ${body.error}`);
  check('with the list it is on', body.list === 'watching');
  check('zero TMDB calls', tmdbCalls() === 0, `made ${tmdbCalls()}`);
  check('and nothing charged', spent(env, 'ann', 'lookups') === 0);

  addShow(env, 'ann', 'Fargo', { archived: 1 });
  const arch = await showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: s, method: 'POST', body: { title: 'Fargo', list: 'next' } })));
  const archBody = await arch.json();
  check('an archived copy is 409 exists_archived with its id', arch.status === 409 && archBody.error === 'exists_archived' && Number.isInteger(archBody.id));
}

console.log('\n== add: metered, and refused past the ceiling with zero upstream calls');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  const add = (title) => showsApi.onRequestPost(ctx(env, req('/api/shows', { cookie: s, method: 'POST', body: { title, list: 'next', network: 'Netflix' } })));
  const ok = await add('The Bear');
  check('an add under the ceiling succeeds', ok.status === 200 || ok.status === 201, `got ${ok.status}`);
  check('and is charged one lookup', spent(env, 'ann', 'lookups') === 1);

  spendTo(env, 'ann', 'lookups', DAILY_LIMITS.lookups);
  upstream.calls.length = 0;
  const over = await add('Shogun');
  check('past the ceiling it is 429', over.status === 429, `got ${over.status}`);
  check('zero upstream calls', upstream.calls.length === 0, `made ${upstream.calls.length}`);
  check('and no row', !env._db.prepare("SELECT 1 FROM shows WHERE title = 'Shogun'").get());
}

// ---- 4. edit ----

console.log('\n== edit: past the ceiling it still saves, it just skips the lookup');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  // Pinned, as every copy is: an edit that keeps the show needs no lookup.
  const id = addShow(env, 'ann', 'Severance', { network: 'Apple TV+', tmdb_id: 95396, tmdb_type: 'tv' });
  spendTo(env, 'ann', 'lookups', DAILY_LIMITS.lookups);
  upstream.calls.length = 0;
  const res = await showApi.onRequestPut(ctx(env, req(`/api/shows/${id}`, { cookie: s, method: 'PUT', body: { notes: 'season 2 is great', network: 'Hulu' } }), { id: String(id) }));
  check('200', res.status === 200, `got ${res.status}`);
  const row = env._db.prepare('SELECT notes, network FROM shows WHERE id = ?').get(id);
  check("the member's note is saved", row.notes === 'season 2 is great');
  check('and their network change', row.network === 'Hulu');
  check('with zero upstream calls, Watchmode included', upstream.calls.length === 0, `made ${upstream.calls.length}`);
}

console.log('\n== edit: under the ceiling it enriches as before');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  const id = addShow(env, 'ann', 'Severance');
  await showApi.onRequestPut(ctx(env, req(`/api/shows/${id}`, { cookie: s, method: 'PUT', body: { notes: 'x' } }), { id: String(id) }));
  check('TMDB is asked', tmdbCalls() > 0);
  check('and one lookup is charged', spent(env, 'ann', 'lookups') === 1);
}

// ---- 5. suggest and type-ahead ----

console.log('\n== suggest: 429 past the ceiling, with zero upstream calls');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  spendTo(env, 'ann', 'lookups', DAILY_LIMITS.lookups);
  const res = await suggestApi.onRequestPost(ctx(env, req('/api/shows/suggest', { cookie: s, method: 'POST', body: { title: 'Severance' } })));
  check('429', res.status === 429, `got ${res.status}`);
  check('zero upstream calls', upstream.calls.length === 0);
}

console.log('\n== type-ahead: past the ceiling answers the empty shape, not an error');
{
  const env = makeEnv();
  const s = addMember(env, 'ann');
  const search = () => searchApi.onRequestGet(ctx(env, req('/api/title-search?q=severance', { cookie: s })));
  await search();
  check('a search is charged', spent(env, 'ann', 'searches') === 1);
  spendTo(env, 'ann', 'searches', DAILY_LIMITS.searches);
  upstream.calls.length = 0;
  const res = await search();
  const body = await res.json();
  check('200 with no results', res.status === 200 && Array.isArray(body.results) && body.results.length === 0);
  check('zero upstream calls', upstream.calls.length === 0);
  upstream.calls.length = 0;
  await searchApi.onRequestGet(ctx(env, req('/api/title-search?q=s', { cookie: s })));
  check('a too-short query is never charged', spent(env, 'ann', 'searches') === DAILY_LIMITS.searches + 1);
}

// ---- 6. sync-urls ----

console.log('\n== the club-wide URL sweep runs for the job and admins, not members');
{
  const seed = () => {
    const env = makeEnv();
    addMember(env, 'ann'); addMember(env, 'bob');
    addShow(env, 'ann', 'Severance', { network: 'Apple TV+', network_url: 'https://tv.apple.com/us/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx' });
    addShow(env, 'bob', 'Severance', { network: 'Apple TV+', network_url: null });
    return env;
  };
  const bobUrl = (env) => env._db.prepare("SELECT network_url FROM shows WHERE member_slug = 'bob'").get().network_url;
  const sync = (env, opts) => syncUrlsApi.onRequestPost(ctx(env, req('/api/sync-urls', { method: 'POST', ...opts })));

  let env = seed();
  const member = addMember(env, 'bob');
  let res = await sync(env, { cookie: member });
  let body = await res.json();
  check('a member session gets 200 {synced: 0}', res.status === 200 && body.synced === 0);
  check('and nothing is written', bobUrl(env) === null);

  res = await sync(env, {});
  check('no session and no secret is 401', res.status === 401);
  res = await sync(env, { headers: { 'X-Cron-Secret': 'wrong' } });
  check('a wrong secret is 401', res.status === 401, `got ${res.status}`);

  res = await sync(env, { headers: { 'X-Cron-Secret': CRON } });
  body = await res.json();
  check('the nightly job runs it', body.synced === 1 && bobUrl(env) !== null, JSON.stringify(body));

  env = seed();
  const admin = addMember(env, 'patrick', { admin: 1 });
  body = await (await sync(env, { cookie: admin })).json();
  check('an admin runs it', body.synced === 1);
}

// ---- 7. household ----

console.log('\n== household: nobody is added without their own invite');
{
  const env = makeEnv();
  const ann = addMember(env, 'ann');
  const bob = addMember(env, 'bob');
  addMember(env, 'cat');
  const put = (cookie, members) => householdApi.onRequestPut(ctx(env, req('/api/household', { cookie, method: 'PUT', body: { members } })));
  const get = async (cookie) => (await householdApi.onRequestGet(ctx(env, req('/api/household', { cookie })))).json();
  const rows = () => env._db.prepare('SELECT member_slug, other_slug FROM household_members ORDER BY 1, 2').all().map((r) => `${r.member_slug}>${r.other_slug}`);

  const res = await put(ann, ['bob']);
  check('PUT naming someone new is 403', res.status === 403, `got ${res.status}`);
  check('with household_invite_required', (await res.json()).error === 'household_invite_required');
  check('and writes nothing', rows().length === 0);

  // As /api/household/join would have written them.
  env._db.prepare("INSERT INTO household_members (member_slug, other_slug) VALUES ('ann', 'bob'), ('ann', 'cat')").run();
  const narrowed = await put(ann, ['bob']);
  check('PUT can still remove someone', narrowed.status === 200 && rows().join() === 'ann>bob', rows().join());
  check('an empty PUT clears the set', (await put(ann, [])).status === 200 && rows().length === 0);

  env._db.prepare("INSERT INTO household_members (member_slug, other_slug) VALUES ('ann', 'bob')").run();
  const bobView = await get(bob);
  check("the claimed member sees it in member_of", JSON.stringify(bobView.member_of) === '["ann"]', JSON.stringify(bobView.member_of));
  check('and the roster read still works', Array.isArray(bobView.members) && Array.isArray(bobView.household));

  const out = await householdRemoveApi.onRequestPost(ctx(env, req('/api/household/remove', { cookie: bob, method: 'POST', body: { member_slug: 'ann' } })));
  check("and can take themselves out of ann's household", out.status === 200 && rows().length === 0, rows().join());

  env._db.prepare("INSERT INTO household_members (member_slug, other_slug) VALUES ('ann', 'bob')").run();
  await householdRemoveApi.onRequestPost(ctx(env, req('/api/household/remove', { cookie: ann, method: 'POST', body: { member_slug: 'bob' } })));
  check('the owner can still remove from their end', rows().length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

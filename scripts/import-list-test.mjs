// End-to-end tests for the paste-a-list import, driven through the real
// handlers against a real SQLite database.
//
//   node scripts/import-list-test.mjs
//
// The import is the one place where a model's output turns into rows in a
// member's library, so the things worth pinning down are the boundaries
// around it rather than the extraction quality itself:
//
//   1. Claude never supplies a TMDB id — it supplies a title, and TMDB says
//      whether that title exists. A fake Claude below returns a hallucinated
//      tmdb_id and a hallucinated title; neither may reach the database.
//   2. Paging must not lose or duplicate titles, and a section heading must
//      survive the seam between two slices — otherwise a long paste silently
//      reclassifies everything after the first chunk.
//   3. Commit re-validates. The items come back from the client, so a bad
//      list name, an off-domain poster, or a duplicate title must be caught
//      here and not written.
//   4. An import is bounded by its own daily ceiling, not by /api/shows's
//      50-a-day human-pace cap, and not by nothing at all.
//
// Same harness as scripts/auth-code-flow-test.mjs: the functions tree is
// copied to a temp directory with a `type: module` package.json so Node loads
// the .js files as the ES modules they are (the repo has no package.json on
// purpose — see CLAUDE.md), and schema.sql is loaded into node:sqlite behind a
// thin D1 shim, so the SQL under test is executed, not faked.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'import-list-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const parse = await load('api/import/parse.js');
const commit = await load('api/import/commit.js');

const ORIGIN = 'https://showpicker.club';
const SESSION_ID = 'sess-test-1';

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
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fake outbound world ----
//
// The fake Claude is deliberately a bad citizen: it returns a `tmdb_id` field
// the schema never asked for, and one title that TMDB will not know. Both are
// there so the tests can prove the pipeline ignores the first and handles the
// second. `claude.calls` records what each slice was asked, so the paging
// tests can assert the carried section actually arrived.
const claude = { calls: [], reply: null, status: 200 };
const tmdb = { calls: [], known: new Map() };

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const jsonRes = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (target.startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(init.body || '{}');
    claude.calls.push({
      system: body.system?.[0]?.text ?? '',
      user: body.messages?.[0]?.content ?? '',
      model: body.model,
      schema: body.output_config?.format?.schema,
    });
    if (claude.status !== 200) return jsonRes({ error: { message: 'boom' } }, claude.status);
    const payload = typeof claude.reply === 'function'
      ? claude.reply(claude.calls[claude.calls.length - 1])
      : claude.reply;
    return jsonRes({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn',
    });
  }

  if (target.startsWith('https://api.themoviedb.org/')) {
    const q = decodeURIComponent(new URL(target).searchParams.get('query') || '');
    const type = target.includes('/search/movie') ? 'movie' : 'tv';
    tmdb.calls.push({ q, type });
    const hit = tmdb.known.get(q.toLowerCase());
    if (!hit || hit.type !== type) return jsonRes({ results: [] });
    return jsonRes({
      results: [{
        id: hit.id,
        [type === 'movie' ? 'title' : 'name']: hit.title,
        [type === 'movie' ? 'release_date' : 'first_air_date']: hit.date || '2020-01-01',
        poster_path: '/abc.jpg',
      }],
    });
  }

  throw new Error(`unexpected outbound fetch: ${target}`);
};

// ---- fixtures ----

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  claude.calls.length = 0;
  claude.status = 200;
  claude.reply = { items: [], trailing_section: '' };
  tmdb.calls.length = 0;
  tmdb.known = new Map();

  db.prepare('INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, 0)')
    .run('patrick', 'Patrick Turner', 'Patrick');
  db.prepare(
    "INSERT INTO sessions (id, email, member_slug, expires_at) VALUES (?, ?, ?, datetime('now', '+30 day'))"
  ).run(SESSION_ID, 'patrick@example.com', 'patrick');

  return {
    DB: {
      prepare: (sql) => new Stmt(db, sql),
      batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    },
    ANTHROPIC_API_KEY: 'test-key',
    TMDB_TOKEN: 'test-token',
    _db: db,
    ...extra,
  };
}

function knowTitle(title, id, type = 'tv', date = '2022-01-01', canonical = null) {
  tmdb.known.set(title.toLowerCase(), { id, type, date, title: canonical || title });
}

function post(path, body, { session = SESSION_ID } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers.Cookie = `session=${session}`;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

const context = (env, request) => ({ env, request, waitUntil: () => {} });
const shows = (env) => env._db.prepare('SELECT * FROM shows ORDER BY id').all();

function item(over = {}) {
  return {
    title: 'Severance', year: '', list: 'watching', notes: '', network: '',
    recommended_by: '', watching_with: '', movie: false, ...over,
  };
}

// ---- scenarios ----

console.log('\n== a session is required on both halves');
{
  const env = makeEnv();
  const p = await parse.onRequestPost(context(env, post('/api/import/parse', { text: 'Severance' }, { session: null })));
  check('parse refuses a logged-out caller', p.status === 401, `got ${p.status}`);
  const c = await commit.onRequestPost(context(env, post('/api/import/commit', { items: [] }, { session: null })));
  check('commit refuses a logged-out caller', c.status === 401, `got ${c.status}`);
  check('and Claude was never called', claude.calls.length === 0);
}

console.log('\n== TMDB decides what a title is, not Claude');
{
  const env = makeEnv();
  knowTitle('Severance', 95396, 'tv', '2022-02-18');
  // Claude returns a misspelling, a bogus id, and a show TMDB has never heard
  // of. Only the misspelling should be corrected; the id must be ignored and
  // the unknown title kept but flagged.
  claude.reply = {
    items: [
      { ...item({ title: 'Severence' }), tmdb_id: 999999999 },
      item({ title: 'A Show That Does Not Exist' }),
    ],
    trailing_section: '',
  };
  knowTitle('Severence', 95396, 'tv', '2022-02-18', 'Severance');

  const res = await parse.onRequestPost(context(env, post('/api/import/parse', { text: 'Severence\nA Show That Does Not Exist' })));
  const out = await res.json();
  check('parse succeeds', res.status === 200, `got ${res.status}`);
  check('the misspelling is corrected to TMDB spelling', out.items[0].title === 'Severance', out.items[0]?.title);
  check('what the member typed is preserved', out.items[0].raw_title === 'Severence');
  check('the id comes from TMDB, not from Claude', out.items[0].tmdb_id === 95396, String(out.items[0]?.tmdb_id));
  check('the year comes from TMDB', out.items[0].year === 2022, String(out.items[0]?.year));
  check('an unknown title is kept, not dropped', out.items.length === 2);
  check('and is flagged as unmatched', out.items[1].matched === false && out.items[1].tmdb_id === null);
  check('parse writes nothing', shows(env).length === 0);
}

console.log('\n== a hallucinated id cannot reach the database');
{
  const env = makeEnv();
  // Straight from a tampered-with (or model-poisoned) client payload.
  const res = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: [{ title: 'Severance', list: 'watching', tmdb_id: 'not-a-number', poster_url: 'https://evil.example/x.jpg' }],
  })));
  check('commit still succeeds', res.status === 200, `got ${res.status}`);
  const row = shows(env)[0];
  check('the non-integer id is dropped', row.tmdb_id === null, String(row.tmdb_id));
  check('the off-domain poster is dropped', row.poster_url === null, String(row.poster_url));
}

console.log('\n== the four lists are the only lists');
{
  const env = makeEnv();
  const res = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: [
      { title: 'Severance', list: 'watching' },
      { title: 'The Bear', list: 'favourites' },
      { title: 'Shrinking', list: 'DROP TABLE shows' },
    ],
  })));
  const out = await res.json();
  check('only the valid list is added', out.added === 1, JSON.stringify(out));
  check('the invented lists are skipped', out.skipped === 2);
  check('and only one row exists', shows(env).length === 1);
  check('on the list it named', shows(env)[0].list === 'watching');
}

console.log('\n== a section heading survives the seam between slices');
{
  const env = makeEnv();
  // Two slices' worth of text. The heading is only in the first.
  const text = 'LOVED\n' + 'The Wire\n'.repeat(1) + 'x'.repeat(12000) + '\nThe Bear\n';
  // Stands in for the model: extract whichever title is actually in this
  // slice, and report the heading it was told about (or found).
  let sawCarriedHeading = false;
  claude.reply = (call) => {
    const first = call.user.includes('This is the start of the list.');
    if (!first && call.user.includes('LOVED')) sawCarriedHeading = true;
    const found = ['The Wire', 'The Bear'].filter(t => call.user.includes(t) && !(first && t === 'The Bear'));
    return {
      items: found.map(title => item({ title, list: 'recommending' })),
      trailing_section: 'LOVED',
    };
  };
  knowTitle('The Wire', 1438);
  knowTitle('The Bear', 136315);

  // Drive it exactly the way the client does: page until the cursor comes
  // back null. Asserting a fixed number of slices would just pin the test to
  // whatever CHUNK_CHARS happens to be.
  const collected = [];
  const boundaries = [];
  let cursor = 0, section = '', slices = 0;
  while (cursor !== null && slices < 20) {
    const res = await parse.onRequestPost(context(env, post('/api/import/parse', { text, cursor, section })));
    const page = await res.json();
    collected.push(...page.items);
    if (page.next_cursor !== null) boundaries.push(page.next_cursor);
    cursor = page.next_cursor;
    section = page.section;
    slices++;
  }

  check('paging terminates', cursor === null, `stopped after ${slices} slices`);
  check('it took more than one slice', slices > 1, String(slices));
  check('the carried heading reaches every later slice', sawCarriedHeading);
  check('every slice cut on a line break', boundaries.every(b => text[b - 1] === '\n'));
  check('both titles came through, once each', collected.length === 2, JSON.stringify(collected.map(i => i.title)));
  check('and both landed on Loved', collected.every(i => i.list === 'recommending'));
  check('the last slice still reports the section', section === 'LOVED');
}

console.log('\n== the personal fields survive the round trip');
{
  const env = makeEnv();
  knowTitle('Slow Horses', 95480);
  claude.reply = {
    items: [item({
      title: 'Slow Horses', list: 'waiting', notes: 's4 in september',
      network: 'apple tv plus', recommended_by: 'Whitt', watching_with: 'Dorothy',
    })],
    trailing_section: '',
  };
  const parsed = await (await parse.onRequestPost(
    context(env, post('/api/import/parse', { text: 'Slow Horses - s4 in september' })))).json();
  check('the network is canonicalised', parsed.items[0].network === 'Apple TV+', parsed.items[0]?.network);

  await commit.onRequestPost(context(env, post('/api/import/commit', { items: parsed.items })));
  const row = shows(env)[0];
  check('the note is stored', row.notes === 's4 in september', String(row.notes));
  check('who recommended it is stored', row.recommended_by === 'Whitt');
  check('who they watch it with is stored', row.watching_with === 'Dorothy');
  check('the list is stored', row.list === 'waiting');
  check('a search-page URL is filled in', String(row.network_url).includes('tv.apple.com'), String(row.network_url));
  check('added_by is the member, as with a hand-add', row.added_by === 'patrick@example.com');
  check('updated_at is set — an import is member intent', !!row.updated_at);
}

console.log('\n== titles the member already has are skipped, not duplicated');
{
  const env = makeEnv();
  env._db.prepare(
    "INSERT INTO shows (title, list, member_slug, archived) VALUES ('Severance', 'watching', 'patrick', 0)"
  ).run();
  env._db.prepare(
    "INSERT INTO shows (title, list, member_slug, archived) VALUES ('The Wire', 'recommending', 'patrick', 1)"
  ).run();
  knowTitle('Severance', 95396);
  knowTitle('The Wire', 1438);
  claude.reply = {
    items: [item({ title: 'Severance' }), item({ title: 'The Wire' })],
    trailing_section: '',
  };

  const parsed = await (await parse.onRequestPost(
    context(env, post('/api/import/parse', { text: 'Severance\nThe Wire' })))).json();
  check('parse flags the active duplicate with its list', parsed.items[0].existing_list === 'watching');
  check('and flags the archived one as archived', parsed.items[1].existing_archived === true);

  const out = await (await commit.onRequestPost(
    context(env, post('/api/import/commit', { items: parsed.items })))).json();
  check('commit adds neither', out.added === 0 && out.skipped === 2, JSON.stringify(out));
  check('and the library is unchanged', shows(env).length === 2);
}

console.log('\n== one paste naming a title twice inserts it once');
{
  const env = makeEnv();
  const res = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: [
      { title: 'Andor', list: 'watching' },
      { title: 'andor', list: 'next' },
    ],
  })));
  const out = await res.json();
  check('the second is skipped', out.added === 1 && out.skipped === 1, JSON.stringify(out));
  check('one row exists', shows(env).length === 1);
}

console.log('\n== an import has its own ceiling');
{
  const env = makeEnv();
  const insert = env._db.prepare(
    "INSERT INTO shows (title, list, member_slug, created_at) VALUES (?, 'watching', 'patrick', datetime('now'))"
  );
  // Above /api/shows's 50-a-day human-pace cap, below the import ceiling.
  for (let i = 0; i < 120; i++) insert.run(`Filler ${i}`);

  const ok = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: [{ title: 'Severance', list: 'watching' }],
  })));
  check('an import is not blocked by the hand-add cap', ok.status === 200, `got ${ok.status}`);

  for (let i = 0; i < 180; i++) insert.run(`More ${i}`);
  const capped = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: [{ title: 'The Bear', list: 'watching' }],
  })));
  check('but it is bounded', capped.status === 429, `got ${capped.status}`);

  const huge = await commit.onRequestPost(context(env, post('/api/import/commit', {
    items: Array.from({ length: 201 }, (_, i) => ({ title: `Bulk ${i}`, list: 'next' })),
  })));
  check('and one call cannot post an unbounded batch', huge.status === 400, `got ${huge.status}`);
}

console.log('\n== a Claude outage surfaces instead of looking like an empty list');
{
  const env = makeEnv();
  claude.status = 500;
  const res = await parse.onRequestPost(context(env, post('/api/import/parse', { text: 'Severance' })));
  check('the failure is reported', res.status === 502, `got ${res.status}`);
  const out = await res.json();
  check('with a reason, not a silent success', out.error === 'parse_failed', JSON.stringify(out));
}

console.log('\n== an unconfigured deployment says so');
{
  const env = makeEnv();
  delete env.ANTHROPIC_API_KEY;
  const res = await parse.onRequestPost(context(env, post('/api/import/parse', { text: 'Severance' })));
  check('parse refuses cleanly without a key', res.status === 503, `got ${res.status}`);
}

console.log('\n== the request Claude receives is the one we intend');
{
  const env = makeEnv();
  knowTitle('Severance', 95396);
  claude.reply = { items: [item()], trailing_section: '' };
  await parse.onRequestPost(context(env, post('/api/import/parse', { text: 'Severance' })));
  const call = claude.calls[0];
  check('the schema pins the four lists', JSON.stringify(call.schema).includes('"recommending"'));
  check('the schema forbids extra fields', JSON.stringify(call.schema).includes('"additionalProperties":false'));
  check('the model is pinned', call.model === 'claude-opus-5', call.model);
  check('the paste is what it is asked about', call.user.includes('Severance'));
  check('one TMDB search per extracted title', tmdb.calls.length === 1, String(tmdb.calls.length));
}

// The fallback is the only thing deciding where an unheaded paste lands, and
// Watching feeds the calendar — so a watchlist pasted from Next Up landing on
// Watching would push forty unwatched titles into a subscribed feed. These pin
// the contract in both directions: the caller's choice reaches Claude and the
// row builder, junk never does, and a heading still beats both.
console.log('\n== the default list follows the door the member came in by');
{
  const env = makeEnv();
  claude.reply = { items: [], trailing_section: '' };
  await parse.onRequestPost(context(env, post('/api/import/parse', {
    text: 'Severance', default_list: 'next',
  })));
  check('the caller\'s fallback reaches Claude', claude.calls[0].user.includes('Fallback list for titles the text does not place: next'),
        claude.calls[0].user);

  const env2 = makeEnv();
  claude.reply = { items: [], trailing_section: '' };
  await parse.onRequestPost(context(env2, post('/api/import/parse', { text: 'Severance' })));
  check('an omitted fallback is still Watching', claude.calls[0].user.includes('place: watching'),
        claude.calls[0].user);

  // The system prompt is cached ephemeral and must stay byte-identical across
  // every slice of every import — which is exactly why the fallback rides in
  // the user turn. A four-way interpolation here would quietly cost a cache
  // entry per list and break the claim in ARCHITECTURE.md.
  const env3 = makeEnv();
  claude.reply = { items: [], trailing_section: '' };
  await parse.onRequestPost(context(env3, post('/api/import/parse', { text: 'A', default_list: 'next' })));
  const withNext = claude.calls[0].system;
  const env4 = makeEnv();
  claude.reply = { items: [], trailing_section: '' };
  await parse.onRequestPost(context(env4, post('/api/import/parse', { text: 'A', default_list: 'recommending' })));
  check('the cached system prompt does not vary with it', withNext === claude.calls[0].system);
  check('and it names no single list as the default', !withNext.includes('use "watching"'));
}

console.log('\n== a junk default cannot steer the import');
{
  for (const bad of ['archived', 'WATCHING', '', 'next; drop table shows', 42, null]) {
    const env = makeEnv();
    knowTitle('Severance', 95396);
    // Claude echoing a bad list back is the other half of the same hole.
    claude.reply = { items: [item({ list: 'nonsense' })], trailing_section: '' };
    const res = await parse.onRequestPost(context(env, post('/api/import/parse', {
      text: 'Severance', default_list: bad,
    })));
    const out = await res.json();
    check(`${JSON.stringify(bad)} falls back to Watching`,
          out.default_list === 'watching' && out.items[0].list === 'watching',
          JSON.stringify({ d: out.default_list, l: out.items[0]?.list }));
  }
}

console.log('\n== a heading still beats the default');
{
  const env = makeEnv();
  knowTitle('Severance', 95396);
  knowTitle('The Bear', 136315);
  // What a well-behaved model does with a heading: places the title itself and
  // ignores the fallback. The fallback must not overwrite that.
  claude.reply = {
    items: [item({ title: 'Severance', list: 'recommending' }), item({ title: 'The Bear', list: 'next' })],
    trailing_section: '',
  };
  const res = await parse.onRequestPost(context(env, post('/api/import/parse', {
    text: 'Loved\nSeverance\n\nNext Up\nThe Bear', default_list: 'watching',
  })));
  const out = await res.json();
  check('a placed title keeps its list', out.items[0].list === 'recommending', out.items[0].list);
  check('and so does the second', out.items[1].list === 'next', out.items[1].list);
  check('the response reports the fallback that was applied', out.default_list === 'watching', out.default_list);
}

console.log('\n== an unplaced title lands on the caller\'s list, all the way to the row');
{
  const env = makeEnv();
  knowTitle('Severance', 95396);
  // A model that returns a list key outside the four — the row builder's own
  // fallback, which used to be hardcoded to Watching.
  claude.reply = { items: [item({ list: 'not-a-list' })], trailing_section: '' };
  const res = await parse.onRequestPost(context(env, post('/api/import/parse', {
    text: 'Severance', default_list: 'next',
  })));
  const out = await res.json();
  check('the row builder honours it too', out.items[0].list === 'next', out.items[0].list);

  const done = await commit.onRequestPost(context(env, post('/api/import/commit', { items: out.items })));
  check('and commit accepts the row', done.status === 200, `got ${done.status}`);
  const rows = shows(env);
  check('the show is on Next Up in the database', rows.length === 1 && rows[0].list === 'next',
        JSON.stringify(rows.map(r => r.list)));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

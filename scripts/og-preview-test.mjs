// Tests for the link-preview pages — /show/:id, /groups/join, /household/join.
//
//   node scripts/og-preview-test.mjs
//
// Written for the 2026-08 "every share looks the same" report: a shared show
// arrived in Messages as a generic "Show Picker Club" card with no artwork,
// whatever show it was. The cause wasn't the apps — those links were already
// distinct and already deep-linked correctly — it was that every one of them
// fell through _redirects' catch-all to the marketing page, whose og:title is
// a constant and which carried no og:image at all.
//
// The reason this needs a test rather than a glance at the diff: these are the
// only pages on the site that render member-adjacent rows with NO session, so
// the interesting properties are all negative ones.
//
//   1. The title names the thing being shared — the whole point of the fix.
//   2. Nothing personal reaches the HTML. The show route selects catalog
//      columns explicitly, so a personal column added to `shows` later can't
//      quietly start appearing in a page anyone on the internet can fetch.
//   3. Titles are escaped. They come from TMDB and from members' own typing,
//      and they land inside content="…" attributes where a bare quote breaks
//      out of the tag.
//   4. A dead invite never confirms it existed — unknown and expired render
//      the same card, and neither names a group or a person.
//
// Same harness as scripts/vibe-scope-test.mjs: the functions tree is copied to
// a temp directory with a `type: module` package.json so Node loads the .js
// files as the ES modules they are, and schema.sql is loaded into node:sqlite
// behind a thin D1 shim, so the SQL under test is executed.

import { liftCopiesIntoTitles } from './lib/seed-titles.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'og-preview-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const showRoute = await load('show/[id].js');
const groupJoin = await load('groups/join.js');
const householdJoin = await load('household/join.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
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
  return { DB: { prepare: (sql) => new Stmt(db, sql) }, _db: db };
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function addMember(env, slug, name, firstName = null) {
  env._db.prepare(
    'INSERT INTO members (slug, name, first_name, is_admin, disabled) VALUES (?, ?, ?, 0, 0)'
  ).run(slug, name, firstName ?? name.split(' ')[0]);
}

function addShow(env, fields) {
  const row = {
    title: 'Untitled', list: 'watching', member_slug: 'patrick', archived: 0,
    ...fields,
  };
  const cols = Object.keys(row);
  env._db.prepare(
    `INSERT INTO shows (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => row[c]));
  // Facts seeded on the copy reach the shared row members read from.
  liftCopiesIntoTitles(env._db, { pinUnmatched: true });
  return env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id;
}

// Pull one meta tag's content back out of the rendered page.
function meta(html, property) {
  const re = new RegExp(
    `<meta (?:property|name)="${property.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}" content="([^"]*)"`
  );
  return (html.match(re) || [])[1] ?? null;
}

const get = async (mod, url, params = {}) => {
  const res = await mod.onRequestGet({
    env: get.env, params, request: new Request(url),
  });
  return { res, html: await res.text() };
};

// ---------------------------------------------------------------- show

console.log('\n/show/:id — the card names the show');
{
  const env = makeEnv(); get.env = env;
  addMember(env, 'patrick', 'Patrick Turner');
  const id = addShow(env, {
    title: 'Severance',
    overview: 'Mark leads a team of office workers whose memories have been surgically divided.',
    backdrop_url: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
    poster_url: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    release_year: 2022,
    network: 'Apple TV+',
    // The personal columns. None of these may reach the HTML.
    notes: 'SECRETNOTE rewatch with mom',
    recommended_by: 'SECRETREC Quinn',
    watching_with: 'SECRETWITH Rosa',
  });

  const { res, html } = await get(showRoute, `${ORIGIN}/show/${id}`, { id: String(id) });

  check('200 for a real show', res.status === 200, `got ${res.status}`);
  check('og:title is "<Title> on Show Picker Club"',
    meta(html, 'og:title') === 'Severance on Show Picker Club', meta(html, 'og:title'));
  check('og:description carries the synopsis',
    (meta(html, 'og:description') || '').startsWith('Mark leads a team'));
  check('og:image prefers the backdrop, upscaled',
    meta(html, 'og:image') === 'https://image.tmdb.org/t/p/w1280/backdrop.jpg', meta(html, 'og:image'));
  check('large card when there is real artwork',
    meta(html, 'twitter:card') === 'summary_large_image');
  check('og:url is canonical for the show',
    meta(html, 'og:url') === `${ORIGIN}/show/${id}`);

  // The property that matters most, and the one a diff won't show you.
  for (const secret of ['SECRETNOTE', 'SECRETREC', 'SECRETWITH']) {
    check(`no personal field leaks (${secret})`, !html.includes(secret));
  }
  check('does not name whose list it is on', !html.includes('patrick'));
}

console.log('\n/show/:id — artwork fallbacks');
{
  const env = makeEnv(); get.env = env;
  addMember(env, 'patrick', 'Patrick Turner');
  const posterOnly = addShow(env, {
    title: 'Andor', poster_url: 'https://image.tmdb.org/t/p/w500/poster.jpg',
  });
  const { html: p } = await get(showRoute, `${ORIGIN}/show/${posterOnly}`, { id: String(posterOnly) });
  check('falls back to the poster when there is no backdrop',
    meta(p, 'og:image') === 'https://image.tmdb.org/t/p/w1280/poster.jpg', meta(p, 'og:image'));

  const none = addShow(env, { title: 'Bare Row', release_year: 1999, network: 'PBS', movie: 1 });
  const { html: n } = await get(showRoute, `${ORIGIN}/show/${none}`, { id: String(none) });
  check('falls back to the site image when the row has no artwork',
    meta(n, 'og:image') === `${ORIGIN}/og-default.png`, meta(n, 'og:image'));
  check('small card when the image is the fallback logo',
    meta(n, 'twitter:card') === 'summary');
  check('no synopsis still describes the show',
    (meta(n, 'og:description') || '').includes('Movie') &&
    (meta(n, 'og:description') || '').includes('PBS'), meta(n, 'og:description'));

  // A non-TMDB artwork value must never be rendered into og:image, which other
  // people's clients fetch.
  const hostile = addShow(env, { title: 'Hostile', poster_url: 'javascript:alert(1)' });
  const { html: h } = await get(showRoute, `${ORIGIN}/show/${hostile}`, { id: String(hostile) });
  check('a non-TMDB image URL is rejected, not emitted',
    meta(h, 'og:image') === `${ORIGIN}/og-default.png` && !h.includes('javascript:alert'));
}

console.log('\n/show/:id — escaping and dead links');
{
  const env = makeEnv(); get.env = env;
  addMember(env, 'patrick', 'Patrick Turner');
  const id = addShow(env, { title: 'Bob\'s "Burgers" & <script>alert(1)</script>' });
  const { html } = await get(showRoute, `${ORIGIN}/show/${id}`, { id: String(id) });
  check('a title with quotes and markup cannot break out of the tag',
    !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
  check('the escaped title still reads correctly',
    (meta(html, 'og:title') || '').startsWith('Bob&#39;s &quot;Burgers&quot; &amp;'), meta(html, 'og:title'));

  const { res: missing, html: mh } = await get(showRoute, `${ORIGIN}/show/999999`, { id: '999999' });
  check('an id with no row renders the app card, not an error page',
    missing.status === 404 && meta(mh, 'og:title') === 'Show Picker Club');

  const { res: junk } = await get(showRoute, `${ORIGIN}/show/abc`, { id: 'abc' });
  check('a non-numeric id is handled', junk.status === 404);
}

// ---------------------------------------------------------------- groups

console.log('\n/groups/join — the card names the group');
{
  const env = makeEnv(); get.env = env;
  addMember(env, 'patrick', 'Patrick Turner');
  env._db.prepare('INSERT INTO groups (name, creator_slug) VALUES (?, ?)')
    .run('Thursday Night Club', 'patrick');
  const gid = env._db.prepare('SELECT MAX(id) AS id FROM groups').get().id;
  env._db.prepare(
    'INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(gid, 'live-token', iso(86400000), 'patrick');
  env._db.prepare(
    'INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(gid, 'dead-token', iso(-86400000), 'patrick');

  const { res, html } = await get(groupJoin, `${ORIGIN}/groups/join?token=live-token`);
  check('200 for a live invite', res.status === 200);
  check('og:title is "Join <Group> on Show Picker Club"',
    meta(html, 'og:title') === 'Join Thursday Night Club on Show Picker Club', meta(html, 'og:title'));

  // The web app redeems invites at /groups?token=…, so the card offers that
  // route alongside the App Store button — otherwise a browser-only member
  // taps an invite and lands somewhere they can't act on.
  check('a live invite offers the browser route',
    html.includes('href="/groups?token=live-token"') && html.includes('Join in your browser'));

  const { res: exp, html: eh } = await get(groupJoin, `${ORIGIN}/groups/join?token=dead-token`);
  check('an expired invite does not name the group',
    !eh.includes('Thursday Night Club') && exp.status === 404);
  check('a dead invite offers no browser route either',
    !eh.includes('/groups?token='));

  const { html: uh } = await get(groupJoin, `${ORIGIN}/groups/join?token=never-existed`);
  check('unknown and expired render the same card',
    meta(uh, 'og:title') === meta(eh, 'og:title'));

  const { res: bare } = await get(groupJoin, `${ORIGIN}/groups/join`);
  check('no token at all is handled', bare.status === 404);
}

// ---------------------------------------------------------------- household

console.log('\n/household/join — the card names whose household');
{
  const env = makeEnv(); get.env = env;
  addMember(env, 'patrick', 'Patrick Turner');
  env._db.prepare(
    'INSERT INTO household_invites (inviter_slug, code, expires_at) VALUES (?, ?, ?)'
  ).run('patrick', 'LIVE1', iso(86400000));
  env._db.prepare(
    'INSERT INTO household_invites (inviter_slug, code, expires_at) VALUES (?, ?, ?)'
  ).run('patrick', 'DEAD1', iso(-86400000));

  const { res, html } = await get(householdJoin, `${ORIGIN}/household/join?code=LIVE1`);
  check('200 for a live invite', res.status === 200);
  // The apostrophe is escaped in the attribute (&#39;) and renders as one —
  // that escaping is the point, so assert the escaped form rather than
  // "fixing" it away.
  check('og:title names the inviter\'s household',
    meta(html, 'og:title') === 'Join Patrick&#39;s household on Show Picker Club', meta(html, 'og:title'));
  check('only the first name is used, never the full name',
    !html.includes('Patrick Turner'));

  const { res: exp, html: eh } = await get(householdJoin, `${ORIGIN}/household/join?code=DEAD1`);
  check('an expired code names nobody',
    !eh.includes('Patrick') && exp.status === 404);

  const { html: uh } = await get(householdJoin, `${ORIGIN}/household/join?code=NOPE`);
  check('unknown and expired render the same card',
    meta(uh, 'og:title') === meta(eh, 'og:title'));

  // The web accepts household invites now, so a live card offers to continue
  // in the browser — and a dead one still offers nothing, so it can't hint
  // the code was ever real.
  check('a live invite offers "Continue in your browser" to the web accept',
    html.includes('href="/subscriptions?household=LIVE1"'));
  check('an expired or unknown invite offers no web link',
    !eh.includes('/subscriptions?household=') && !uh.includes('/subscriptions?household='));
}

// ------------------------------------------------------------ fallback card

// Every URL without tags of its own previews from whatever the _redirects
// catch-all serves, and that is index.html — the app since the 2026-08 restore,
// the marketing page before it. Whichever page holds that slot needs the tags;
// their absence is why every share used to arrive with no artwork.
console.log('\nCatch-all fallback page (public/index.html)');
{
  const html = readFileSync(join(repoRoot, 'public', 'index.html'), 'utf8');
  check('has an og:image — its absence is why every share had no artwork',
    meta(html, 'og:image') === `${ORIGIN}/og-default.png`, meta(html, 'og:image'));
  check('declares a large twitter card', meta(html, 'twitter:card') === 'summary_large_image');

  // The marketing page is a real page at its own URL now, and it is what the
  // App Store listing and the Ads campaign point at, so it keeps its own tags.
  const mk = readFileSync(join(repoRoot, 'public', 'download.html'), 'utf8');
  check('the marketing page keeps its own og:image',
    meta(mk, 'og:image') === `${ORIGIN}/og-default.png`, meta(mk, 'og:image'));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

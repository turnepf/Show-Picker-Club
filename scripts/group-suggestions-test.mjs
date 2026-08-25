// Tests for "Recommend to group" — JC's pop-up (via Jennifer, 8/2026), and
// the first suggestion feature since suggest-a-show was retired in 2026-07.
//
//   node scripts/group-suggestions-test.mjs
//
// A recommendation is a row the GROUP owns, never a write to anyone's list:
// the pop-up's "Add to Next Up" is the recipient's own tap pulling a copy
// onto their own list, and Dismiss is a per-member mark. The properties worth
// pinning are the ones that keep it that way:
//
//   1. Group-mates only, both directions. An outsider can neither read a
//      group's board nor put a card on it, and you can only recommend a copy
//      you actually own.
//   2. Recommending writes to nobody's list. Only a recipient's own Add does,
//      and only to their own.
//   3. A list they already made is never rearranged. An existing copy is
//      honoured where it sits — Add doesn't move it to Next Up — and an
//      archived one is revived rather than duplicated.
//   4. Dismiss is per-member. One member's Dismiss hides the card for them
//      and nobody else, and doesn't bar them adding later from the board.
//   5. Your own recommendation never asks you to respond.
//   6. One member can't flood a group: a duplicate title folds into the
//      existing card, and a per-member daily ceiling caps the rest.
//   7. A fresh copy remembers who to thank (recommended_by, the owner-only
//      memo that has always meant exactly this); a copy they already had
//      keeps its memos untouched.
//   8. Leaving the group takes your cards with you.
//
// Same harness as scripts/watching-with-test.mjs: the functions tree is
// copied to a temp directory with a `type: module` package.json, and
// schema.sql is loaded into node:sqlite behind a thin D1 shim. No TMDB_TOKEN
// is set, so enrichment returns its empty shape without touching the network.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'group-suggestions-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const load = (p) => import(join(sandbox, 'functions', p));
const boardApi = await load('api/groups/[id]/suggestions.js');
const cardApi = await load('api/groups/[id]/suggestions/[sid].js');
const leaveApi = await load('api/groups/[id]/leave.js');
const showApi = await load('api/shows/[id].js');
const { MAX_SUGGESTIONS_PER_DAY } = await load('_shared/group-suggestions.js');

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite (see watching-with-test.mjs) ----

const D1_MAX_BOUND_PARAMS = 100;

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  guard() {
    if (this.args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(`D1_ERROR: too many bound parameters (${this.args.length} > ${D1_MAX_BOUND_PARAMS})`);
    }
  }
  async first() {
    this.guard();
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    this.guard();
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    this.guard();
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  return {
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
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

function addShow(env, { slug, title, list = 'watching', archived = 0, tmdbId = null, poster = null, network = null, notes = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, archived, tmdb_id, poster_url, network, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, list, slug, archived, tmdbId, poster, network, notes, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  return Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
}

const rowsFor = (env, slug) =>
  env._db.prepare('SELECT * FROM shows WHERE member_slug = ? ORDER BY id').all(slug).map((r) => ({ ...r }));
const rowFor = (env, slug, title) =>
  rowsFor(env, slug).find((r) => r.title.toLowerCase() === title.toLowerCase());

function req(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return new Request(ORIGIN + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ctx = (env, request, params) => ({ env, request, params, waitUntil: () => {} });

const getBoard = (env, cookie, groupId) =>
  boardApi.onRequestGet(ctx(env, req(`/api/groups/${groupId}/suggestions`, { cookie }), { id: String(groupId) }));
const recommend = (env, cookie, groupId, body) =>
  boardApi.onRequestPost(ctx(env, req(`/api/groups/${groupId}/suggestions`, { cookie, method: 'POST', body }), { id: String(groupId) }));
const respond = (env, cookie, groupId, sid, body) =>
  cardApi.onRequestPost(ctx(env, req(`/api/groups/${groupId}/suggestions/${sid}`, { cookie, method: 'POST', body }), { id: String(groupId), sid: String(sid) }));
const removeCard = (env, cookie, groupId, sid) =>
  cardApi.onRequestDelete(ctx(env, req(`/api/groups/${groupId}/suggestions/${sid}`, { cookie, method: 'DELETE' }), { id: String(groupId), sid: String(sid) }));
const leaveGroup = (env, cookie, groupId) =>
  leaveApi.onRequestPost(ctx(env, req(`/api/groups/${groupId}/leave`, { cookie, method: 'POST' }), { id: String(groupId) }));

// Patrick, Whitt and Amy share a group (Patrick created it). Stacy is a club
// member in no group with them — the outsider every gate is measured against.
function club() {
  const env = makeEnv();
  addMember(env, 'patrick', 'Patrick Turner');
  addMember(env, 'whitt', 'Whitt Dorothy');
  addMember(env, 'amy', 'Amy Turner');
  addMember(env, 'stacy', 'Stacy Kallay');
  const groupId = addGroup(env, 'Show Picker Club', ['patrick', 'whitt', 'amy']);
  return { env, groupId };
}

console.log('\n== the board is group-mates only, both directions');
{
  const { env, groupId } = club();
  const anonRead = await getBoard(env, undefined, groupId);
  check('reading with no session is 401', anonRead.status === 401, `got ${anonRead.status}`);

  const stacy = addSession(env, 'stacy');
  const outsiderRead = await getBoard(env, stacy, groupId);
  check('an outsider reading the board is 403', outsiderRead.status === 403, `got ${outsiderRead.status}`);

  const stacyShow = addShow(env, { slug: 'stacy', title: 'Lanterns', tmdbId: 111 });
  const outsiderWrite = await recommend(env, stacy, groupId, { show_id: stacyShow });
  check('an outsider recommending into it is 403', outsiderWrite.status === 403, `got ${outsiderWrite.status}`);

  const patrick = addSession(env, 'patrick');
  const junk = await getBoard(env, patrick, 'abc');
  check('a junk group id is 400', junk.status === 400, `got ${junk.status}`);
}

console.log('\n== recommending puts a card on the board and rows on no list');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111, poster: 'https://image.tmdb.org/lanterns.jpg', network: 'HBO Max' });

  const res = await recommend(env, jc, groupId, { show_id: mine, note: 'Trust me on this one' });
  check('the recommend succeeds', res.status === 201, `got ${res.status}`);
  const { suggestion } = await res.json();
  check('the card names the recommender', suggestion.suggested_by_name === 'Patrick', suggestion.suggested_by_name);
  check('and carries the note', suggestion.note === 'Trust me on this one', String(suggestion.note));
  check('and the poster snapshot', suggestion.poster_url === 'https://image.tmdb.org/lanterns.jpg');
  check('and the recommender’s copy id, for navigation', suggestion.show_id === mine);
  check('it is marked as yours to you', suggestion.is_yours === 1);

  check('nothing lands on anyone’s list', rowsFor(env, 'whitt').length === 0 && rowsFor(env, 'amy').length === 0);

  const whitt = addSession(env, 'whitt');
  const board = await (await getBoard(env, whitt, groupId)).json();
  check('a group-mate sees the card', board.suggestions.length === 1, `got ${board.suggestions.length}`);
  check('unanswered, so their pop-up queue holds it',
    board.suggestions[0].is_yours === 0 && board.suggestions[0].your_response === null);
}

console.log('\n== you can only recommend a copy you own');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const theirs = addShow(env, { slug: 'whitt', title: 'Severance', tmdbId: 222 });
  const notMine = await recommend(env, jc, groupId, { show_id: theirs });
  check('someone else’s row is 404', notMine.status === 404, `got ${notMine.status}`);
  const junk = await recommend(env, jc, groupId, { show_id: 'nope' });
  check('a junk show_id is 400', junk.status === 400, `got ${junk.status}`);
}

console.log('\n== Add to Next Up is the recipient’s own pull');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111, poster: 'https://image.tmdb.org/lanterns.jpg', network: 'HBO Max' });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  const amy = addSession(env, 'amy');
  const res = await respond(env, amy, groupId, suggestion.id, { response: 'add' });
  check('the add succeeds', res.status === 200, `got ${res.status}`);
  const payload = await res.json();

  const hers = rowFor(env, 'amy', 'Lanterns');
  check('it lands on her list', !!hers);
  check('on Next Up', hers && hers.list === 'next', hers && hers.list);
  check('with the recommender’s enrichment inherited', hers && hers.poster_url === 'https://image.tmdb.org/lanterns.jpg');
  check('added_by is her own tap, not the recommender', hers && hers.added_by === 'amy@example.com', hers && hers.added_by);
  check('and the copy remembers who to thank', hers && hers.recommended_by === 'Patrick', hers && String(hers.recommended_by));
  check('the response returns her new row', payload.show && payload.show.id === hers.id);
  check('her card shows on_your_list', payload.suggestion.on_your_list === 'next', String(payload.suggestion.on_your_list));

  check('the recommender’s copy is untouched', rowFor(env, 'patrick', 'Lanterns').list === 'watching');

  const board = await (await getBoard(env, jc, groupId)).json();
  check('the card counts the add', board.suggestions[0].added_count === 1);
  check('and names who is in', board.suggestions[0].added_names.join(',') === 'Amy', board.suggestions[0].added_names.join(','));
}

console.log('\n== a list they already made is not rearranged');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  const existing = addShow(env, { slug: 'whitt', title: 'Lanterns', list: 'watching', tmdbId: 111, notes: 'ep 3 is where it clicks' });
  const whitt = addSession(env, 'whitt');
  await respond(env, whitt, groupId, suggestion.id, { response: 'add' });

  const theirRows = rowsFor(env, 'whitt');
  check('no duplicate row is created', theirRows.length === 1, `got ${theirRows.length}`);
  check('their placement is untouched — not moved to Next Up', theirRows[0].list === 'watching', theirRows[0].list);
  check('the existing row is the one linked', theirRows[0].id === existing);
  check('their own memos are not overwritten', theirRows[0].recommended_by === null && theirRows[0].notes === 'ep 3 is where it clicks');

  const board = await (await getBoard(env, whitt, groupId)).json();
  check('they still count as in', board.suggestions[0].your_response === 'added');
}

console.log('\n== an archived copy is revived onto Next Up, not duplicated');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Poker Face', tmdbId: 333 });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  const shelved = addShow(env, { slug: 'whitt', title: 'Poker Face', list: 'loved', archived: 1, tmdbId: 333 });
  const whitt = addSession(env, 'whitt');
  await respond(env, whitt, groupId, suggestion.id, { response: 'add' });

  const theirRows = rowsFor(env, 'whitt');
  check('still one row', theirRows.length === 1, `got ${theirRows.length}`);
  check('the same row', theirRows[0].id === shelved);
  check('unarchived onto Next Up', theirRows[0].archived === 0 && theirRows[0].list === 'next', theirRows[0].list);
}

console.log('\n== Dismiss is a per-member mark and nothing more');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  const whitt = addSession(env, 'whitt');
  const res = await respond(env, whitt, groupId, suggestion.id, { response: 'dismiss' });
  check('the dismiss succeeds', res.status === 200, `got ${res.status}`);
  check('nothing lands on their list', rowsFor(env, 'whitt').length === 0);

  const theirBoard = await (await getBoard(env, whitt, groupId)).json();
  check('their view records it', theirBoard.suggestions[0].your_response === 'dismissed');

  const amy = addSession(env, 'amy');
  const herBoard = await (await getBoard(env, amy, groupId)).json();
  check('everyone else’s pop-up still stands', herBoard.suggestions[0].your_response === null);
  check('the card itself is still on the board', herBoard.suggestions.length === 1);

  // Changed their mind at the board later.
  await respond(env, whitt, groupId, suggestion.id, { response: 'add' });
  const after = await (await getBoard(env, whitt, groupId)).json();
  check('a dismiss doesn’t bar adding later', after.suggestions[0].your_response === 'added');
  check('and the add really happened', rowFor(env, 'whitt', 'Lanterns').list === 'next');
}

console.log('\n== your own recommendation never asks you to respond');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();
  const res = await respond(env, jc, groupId, suggestion.id, { response: 'dismiss' });
  check('responding to your own card is 400', res.status === 400, `got ${res.status}`);
  const bogus = await respond(env, jc, groupId, suggestion.id, { response: 'promote' });
  check('an unknown response is 400', bogus.status === 400, `got ${bogus.status}`);
}

console.log('\n== a duplicate title folds into the existing card');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  const first = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  const whitt = addSession(env, 'whitt');
  const theirs = addShow(env, { slug: 'whitt', title: 'Lanterns', tmdbId: 111 });
  const again = await recommend(env, whitt, groupId, { show_id: theirs });
  check('the second recommend is a 200, not a new card', again.status === 200, `got ${again.status}`);
  const { suggestion } = await again.json();
  check('and returns the existing card', suggestion.id === first.suggestion.id);

  const board = await (await getBoard(env, jc, groupId)).json();
  check('the board holds one card', board.suggestions.length === 1, `got ${board.suggestions.length}`);
}

console.log('\n== one member cannot flood a group');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  let last;
  for (let i = 0; i < MAX_SUGGESTIONS_PER_DAY + 1; i++) {
    const id = addShow(env, { slug: 'patrick', title: `Filler ${i}`, tmdbId: 1000 + i });
    last = await recommend(env, jc, groupId, { show_id: id });
  }
  check(`the ${MAX_SUGGESTIONS_PER_DAY + 1}th recommend in a day is 429`, last.status === 429, `got ${last.status}`);
  const board = await (await getBoard(env, jc, groupId)).json();
  check('and did not land', board.suggestions.length === MAX_SUGGESTIONS_PER_DAY, `got ${board.suggestions.length}`);
}

console.log('\n== taking a card down: the recommender or the creator, nobody else');
{
  const { env, groupId } = club();
  const whitt = addSession(env, 'whitt');
  const theirs = addShow(env, { slug: 'whitt', title: 'Severance', tmdbId: 222 });
  const { suggestion } = await (await recommend(env, whitt, groupId, { show_id: theirs })).json();

  const amy = addSession(env, 'amy');
  const bystander = await removeCard(env, amy, groupId, suggestion.id);
  check('a bystander cannot remove it', bystander.status === 403, `got ${bystander.status}`);

  const own = await removeCard(env, whitt, groupId, suggestion.id);
  check('the recommender can retract it', own.status === 200, `got ${own.status}`);

  const { suggestion: second } = await (await recommend(env, whitt, groupId, { show_id: theirs })).json();
  const jc = addSession(env, 'patrick');
  const creator = await removeCard(env, jc, groupId, second.id);
  check('the group creator can tidy the board', creator.status === 200, `got ${creator.status}`);
  const board = await (await getBoard(env, jc, groupId)).json();
  check('and the card is gone for everyone', board.suggestions.length === 0);
}

console.log('\n== the recommender deleting their copy doesn’t strand the card');
{
  const { env, groupId } = club();
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111, poster: 'https://image.tmdb.org/lanterns.jpg' });
  const { suggestion } = await (await recommend(env, jc, groupId, { show_id: mine })).json();

  await showApi.onRequestDelete(ctx(env, req(`/api/shows/${mine}`, { cookie: jc, method: 'DELETE' }), { id: String(mine) }));
  check('precondition: the source row is gone', !rowFor(env, 'patrick', 'Lanterns'));

  const whitt = addSession(env, 'whitt');
  const board = await (await getBoard(env, whitt, groupId)).json();
  check('the card still renders from its snapshot', board.suggestions.length === 1 && board.suggestions[0].poster_url === 'https://image.tmdb.org/lanterns.jpg');
  check('with its dangling pointer nulled, not left stale', board.suggestions[0].show_id === null, String(board.suggestions[0].show_id));

  const res = await respond(env, whitt, groupId, suggestion.id, { response: 'add' });
  check('and can still be added', res.status === 200, `got ${res.status}`);
  const theirs = rowFor(env, 'whitt', 'Lanterns');
  check('from the snapshot, onto Next Up', theirs && theirs.list === 'next' && theirs.tmdb_id === 111);
}

console.log('\n== leaving the group takes your cards with you');
{
  const { env, groupId } = club();
  const whitt = addSession(env, 'whitt');
  const theirs = addShow(env, { slug: 'whitt', title: 'Severance', tmdbId: 222 });
  await recommend(env, whitt, groupId, { show_id: theirs });

  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  const { suggestion: patricksCard } = await (await recommend(env, jc, groupId, { show_id: mine })).json();
  await respond(env, whitt, groupId, patricksCard.id, { response: 'dismiss' });

  const res = await leaveGroup(env, whitt, groupId);
  check('the leave succeeds', res.status === 200, `got ${res.status}`);

  const board = await (await getBoard(env, jc, groupId)).json();
  check('their card went with them', !board.suggestions.some((s) => s.title === 'Severance'));
  check('other members’ cards stay', board.suggestions.some((s) => s.title === 'Lanterns'));
  const marks = env._db.prepare(
    'SELECT COUNT(*) AS cnt FROM group_suggestion_responses WHERE member_slug = ?'
  ).get('whitt');
  check('and their marks on other cards are cleared', Number(marks.cnt) === 0, `got ${marks.cnt}`);

  const gone = await getBoard(env, whitt, groupId);
  check('the board is closed to them now', gone.status === 403, `got ${gone.status}`);
}

console.log('\n== a second group’s board is its own');
{
  const { env, groupId } = club();
  const other = addGroup(env, 'Movie Night', ['patrick', 'stacy']);
  const jc = addSession(env, 'patrick');
  const mine = addShow(env, { slug: 'patrick', title: 'Lanterns', tmdbId: 111 });
  await recommend(env, jc, groupId, { show_id: mine });

  const stacy = addSession(env, 'stacy');
  const otherBoard = await (await getBoard(env, stacy, other)).json();
  check('a card in one group does not appear in another', otherBoard.suggestions.length === 0, `got ${otherBoard.suggestions.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

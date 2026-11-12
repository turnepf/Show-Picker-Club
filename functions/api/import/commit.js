// POST /api/import/commit — add the reviewed items to the caller's own lists.
//
// Body: { items: [ { title, list, notes?, network?, recommended_by?,
//                    watching_with?, movie?, year?, tmdb_id?, tmdb_type?,
//                    poster_url? }, ... ] }
// Returns: { added, skipped, titles: [...], skipped_titles: [...] }
//
// Deliberately does NOT enrich inline. /api/shows fans out to TMDB detail,
// credits, person and Watchmode lookups per row; a few dozen of those in one
// invocation blows the subrequest budget and times out. The rows here go in
// with what /api/import/parse already resolved (tmdb id, canonical title,
// poster, year) and the existing background enrichment rotation fills in
// overview, cast, trailer and a real deep link on its next pass.
//
// The items come back from the client, so everything is re-validated here.
// That is not a trust boundary in the usual sense — a member can only write to
// their own lists either way — but it does keep a mangled payload from putting
// junk in the four list columns or an off-domain URL in an <img src>.

import { getSession } from '../../_shared/auth.js';
import { LIST_KEYS } from '../../_shared/list-parse.js';
import { canonicalNetwork, networkSearchUrl } from '../../_shared/networks.js';
import { writeTitle, titleFieldsFromEnrichment } from '../../_shared/titles.js';
import { verifyIdentity } from '../../_shared/import-identity.js';
import { fetchEnrichmentById } from '../../_shared/enrichment.js';
import { showKey } from '../../_shared/same-show.js';
import { sendEmail, importUnmatchedEmail } from '../../_shared/email.js';
import { chargeSpend } from '../../_shared/spend-meter.js';
import { isDemoMember } from '../../_shared/demo.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Rows accepted in one commit call. The client posts a long import in batches.
const MAX_ITEMS_PER_CALL = 200;

// Per-member rows created per rolling day, counting imports and hand-adds
// together. /api/shows caps at 50 because that is far above human pace for
// one-at-a-time adds; an import is a different shape of write and would trip
// that instantly, so it gets its own (much higher) ceiling rather than a
// bypass.
const MAX_ROWS_PER_DAY = 300;

// TMDB lookups commit may make in one call for rows that arrive without
// parse's identity signature (older iOS builds drop it). Kept well inside the
// Functions subrequest budget; rows past it come back as unmatched for the
// member to add by hand rather than being taken on the client's word.
const MAX_IDENTITY_LOOKUPS_PER_CALL = 20;

// A network name is markup by the time anyone reads it (INVARIANTS §23), so
// refuse it the way the add and edit writers do.
const NETWORK_MARKUP = /[<>"'&]/;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const raw = Array.isArray(body.items) ? body.items : null;
  if (!raw) return json({ error: 'items required' }, 400);
  // The client sends, on its last call (`final`), the titles it set aside at
  // review because TMDB couldn't match them, and how many it added in all, so
  // the member gets one note listing what to add by hand.
  const clientUnmatched = (Array.isArray(body.unmatched_titles) ? body.unmatched_titles : [])
    .map((t) => str(t, 200)).filter(Boolean).slice(0, MAX_UNMATCHED_IN_EMAIL);
  const addedBefore = Number.isInteger(body.added_before) && body.added_before >= 0 ? Math.min(body.added_before, 10000) : 0;
  if (raw.length === 0) {
    const emailed = body.final === true ? await emailUnmatched(env, session, addedBefore, clientUnmatched) : false;
    return json({ added: 0, skipped: 0, titles: [], skipped_titles: [], unmatched: 0, unmatched_titles: [], emailed });
  }
  if (raw.length > MAX_ITEMS_PER_CALL) return json({ error: 'too_many_items' }, 400);

  const slug = session.member_slug;

  const { cnt: addedToday } = (await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM shows WHERE member_slug = ? AND created_at > datetime('now', '-1 day')"
  ).bind(slug).first()) || { cnt: 0 };
  if (addedToday + raw.length > MAX_ROWS_PER_DAY) {
    return json({ error: 'rate_limited', added_today: addedToday, limit: MAX_ROWS_PER_DAY }, 429);
  }

  // One dupe query for the whole batch. Archived rows count as existing —
  // silently resurrecting something the member archived on purpose would be
  // worse than skipping it and telling them.
  // Keyed by show (TMDB entry), so a different film that shares a title the
  // member already has still imports. Every copy and every item here is a
  // TMDB entry, so the key is the whole story.
  const { results: existingRows } = await env.DB.prepare(
    'SELECT tmdb_id, tmdb_type, movie FROM shows WHERE member_slug = ?'
  ).bind(slug).all();
  const taken = new Set((existingRows || []).map(r => showKey(r)));

  const inserts = [];
  const added = [];
  const skipped = [];
  // Titles TMDB couldn't identify. Every show is a TMDB entry now (a copy has
  // no title of its own), so these aren't added: they come back by name for
  // the member to add by hand, picking the right entry from search.
  const unmatched = [];
  const lookups = { left: MAX_IDENTITY_LOOKUPS_PER_CALL };

  for (const item of raw) {
    const title = str(item.title, 200);
    if (!title) continue;
    if (!Number.isInteger(item.tmdb_id) || !(item.tmdb_type === 'movie' || item.tmdb_type === 'tv')) {
      unmatched.push(title);
      continue;
    }
    const key = showKey({ title, tmdb_id: item.tmdb_id, tmdb_type: item.tmdb_type, movie: item.movie });
    // `taken` grows as we go, so a payload that lists the same show twice
    // inserts it once.
    if (taken.has(key)) { skipped.push(title); continue; }
    taken.add(key);

    const list = LIST_KEYS.includes(item.list) ? item.list : null;
    if (!list) { skipped.push(title); continue; }

    const tmdbId = item.tmdb_id;
    const tmdbType = item.tmdb_type;
    const year = Number.isInteger(item.year) && item.year > 1870 && item.year < 2200 ? item.year : null;

    // TMDB decides which show a row is; the client's word doesn't. An entry
    // the club already has is known. A new one needs parse's signature over
    // this exact (type, id, name, year), or a TMDB lookup here. Anything else
    // is set aside for the member to add by hand.
    const verified = await verifyRow(env, slug, { title, tmdb_id: tmdbId, tmdb_type: tmdbType, year }, item.identity_sig, lookups);
    if (!verified) { unmatched.push(title); continue; }

    const rawNetwork = str(item.network, 60);
    const network = rawNetwork && !NETWORK_MARKUP.test(rawNetwork) ? canonicalNetwork(rawNetwork) : null;

    inserts.push({
      title,
      network,
      network_url: networkSearchUrl(network, verified.name || title),
      recommended_by: str(item.recommended_by, 80),
      list,
      notes: str(item.notes, 500),
      movie: item.movie ? 1 : 0,
      watching_with: str(item.watching_with, 80),
      tmdb_id: tmdbId,
      tmdb_type: tmdbType,
      seed: verified.seed,
    });
    added.push(verified.name || title);
  }

  if (inserts.length) {
    // A copy has no title of its own: the name is TMDB's, on the shared row
    // below.
    const cols = 'network, network_url, recommended_by, list, notes, movie, watching_with, member_slug, added_by, tmdb_id, tmdb_type';
    const stmt = env.DB.prepare(`INSERT INTO shows (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // D1 batches are one round trip but not unbounded; chunk so a 200-row
    // import doesn't hand the driver a single oversized statement list.
    for (let i = 0; i < inserts.length; i += 50) {
      await env.DB.batch(inserts.slice(i, i + 50).map(r => stmt.bind(
        r.network, r.network_url, r.recommended_by, r.list, r.notes, r.movie, r.watching_with,
        slug, session.email, r.tmdb_id, r.tmdb_type,
      )));
    }
  }

  // A new entry gets its shared row now rather than at tonight's rebuild, from
  // a verified source only: parse's signed TMDB name and year, or the TMDB
  // payload commit fetched itself. An entry already in the club keeps the row
  // it has. No poster or other URL from the client is ever written; the
  // background /api/enrich pass the client fires next fills the artwork.
  const seeded = new Set();
  for (const r of inserts) {
    if (!r.seed) continue;
    const k = `${r.tmdb_type}:${r.tmdb_id}`;
    if (seeded.has(k)) continue;
    seeded.add(k);
    await writeTitle(env, r.tmdb_type, r.tmdb_id, r.seed);
  }

  // Imported rows land with the id, poster and year the parse step resolved,
  // but no cast, overview or real deep link. The client fires the existing
  // background /api/enrich pass once the import lands; the scheduled job is
  // the backstop if it doesn't.

  // A current client marks its last call `final` and sends what it left out.
  // An older one (iOS 1.6 and earlier, before the email existed) sends no
  // `final` and still submits unmatched rows, which the server sets aside and
  // the app never mentions. Its batches are held and sent as one note.
  let emailed = false;
  if (body.final === true) {
    emailed = await emailUnmatched(env, session, addedBefore + added.length, [...new Set([...clientUnmatched, ...unmatched])]);
  } else if (!('final' in body)) {
    emailed = await legacyBatch(context, session, raw.length, added.length, unmatched);
  }

  return json({
    added: added.length,
    skipped: skipped.length,
    titles: added,
    skipped_titles: skipped,
    unmatched: unmatched.length,
    unmatched_titles: unmatched,
    emailed,
  });
}

// An older app posts a long import in batches of exactly LEGACY_BATCH rows,
// back to back, and never says which is last. The titles it couldn't match
// collect in import_pending until the import ends, so the member gets one
// note with the whole list and the whole count. A short batch is the last
// one, so it sends at once. A full batch might be the last (an import of
// exactly 100 or 200), so it sends after a quiet period unless a later batch
// has taken the row over. Each send claims the row with DELETE ... RETURNING,
// so a batch and a quiet-period send can't both mail the same list.
const LEGACY_BATCH = 100;
const LEGACY_QUIET_MS = 20000; // the next batch arrives in seconds; waitUntil allows 30
const LEGACY_STALE = '-10 minutes'; // a held import older than this was abandoned

async function legacyBatch(context, session, rows, addedNow, unmatchedNow) {
  const { env } = context;
  const slug = session.member_slug;
  try {
    const held = await env.DB.prepare(
      `DELETE FROM import_pending WHERE member_slug = ? RETURNING titles, added,
         updated_at > datetime('now', '${LEGACY_STALE}') AS fresh`
    ).bind(slug).first();
    const prior = held && held.fresh ? held : { titles: '[]', added: 0 };
    let priorTitles = [];
    try { priorTitles = JSON.parse(prior.titles) || []; } catch (_) {}
    const titles = [...new Set([...priorTitles, ...unmatchedNow])];
    const added = (prior.added || 0) + addedNow;

    if (rows < LEGACY_BATCH) return await emailUnmatched(env, session, added, titles);

    const stamp = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO import_pending (member_slug, titles, added, stamp) VALUES (?, ?, ?, ?)'
    ).bind(slug, JSON.stringify(titles), added, stamp).run();
    const quiet = Number.isInteger(env.IMPORT_QUIET_MS) ? env.IMPORT_QUIET_MS : LEGACY_QUIET_MS; // tests shorten it
    context.waitUntil(new Promise((r) => setTimeout(r, quiet)).then(async () => {
      const mine = await env.DB.prepare(
        'DELETE FROM import_pending WHERE member_slug = ? AND stamp = ? RETURNING titles, added'
      ).bind(slug, stamp).first();
      if (mine) await emailUnmatched(env, session, mine.added, JSON.parse(mine.titles));
    }).catch(() => {}));
    return false;
  } catch (e) {
    // No table yet (migration 085 pending): fall back to this batch alone.
    return await emailUnmatched(env, session, addedNow, unmatchedNow);
  }
}

// One note to the member's own address listing what wasn't added. Never to
// the demo account, capped per day, and a failure to send never fails the
// import (the app shows the same list on screen).
const MAX_UNMATCHED_IN_EMAIL = 100;
async function emailUnmatched(env, session, added, titles) {
  if (!titles.length) return false;
  try {
    if (await isDemoMember(env, session.member_slug)) return false;
    const row = await env.DB.prepare(
      'SELECT email FROM member_emails WHERE member_slug = ? ORDER BY is_primary DESC LIMIT 1'
    ).bind(session.member_slug).first();
    if (!row || !row.email) return false;
    if (!(await chargeSpend(env, session.member_slug, 'emails'))) return false;
    const sent = await sendEmail(env, { to: row.email, ...importUnmatchedEmail({ added, titles: titles.slice(0, MAX_UNMATCHED_IN_EMAIL) }) });
    return !!sent.ok;
  } catch (e) {
    return false;
  }
}

// How a row's TMDB identity is established, or null when it can't be.
// Returns { name, seed } where seed is the writeTitle() payload for a shared
// row the club doesn't have yet (null when it already exists).
async function verifyRow(env, slug, row, sig, lookups) {
  const have = await env.DB.prepare('SELECT name FROM titles WHERE tmdb_type = ? AND tmdb_id = ?')
    .bind(row.tmdb_type, row.tmdb_id).first().catch(() => null);
  if (have) return { name: have.name || null, seed: null };

  if (await verifyIdentity(env, row, sig)) {
    return { name: row.title, seed: { name: row.title, fields: { release_year: row.year || null } } };
  }

  // No signature (an older client) or a bad one: ask TMDB, within budget and
  // on the member's daily lookup meter like every other TMDB-backed write.
  if (lookups.left <= 0) return null;
  lookups.left--;
  if (!(await chargeSpend(env, slug, 'lookups'))) { lookups.left = 0; return null; }
  const e = await fetchEnrichmentById(row.tmdb_id, row.tmdb_type, env);
  if (!e || e.tmdbId !== row.tmdb_id || !e.canonicalTitle) return null;
  const fields = titleFieldsFromEnrichment(e);
  return { name: e.canonicalTitle, seed: { name: e.canonicalTitle, fields } };
}

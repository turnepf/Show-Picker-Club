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
import { writeTitle } from '../../_shared/titles.js';
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

// Posters are rendered into an <img src> in the apps. Only ever our own
// enrichment's TMDB image host.
function safePosterUrl(url) {
  return typeof url === 'string' && url.startsWith('https://image.tmdb.org/') ? url : null;
}

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

    const rawNetwork = str(item.network, 60);
    const network = rawNetwork ? canonicalNetwork(rawNetwork) : null;
    const tmdbId = Number.isInteger(item.tmdb_id) ? item.tmdb_id : null;
    const tmdbType = item.tmdb_type === 'movie' || item.tmdb_type === 'tv' ? item.tmdb_type : null;
    const year = Number.isInteger(item.year) && item.year > 1870 && item.year < 2200 ? item.year : null;

    inserts.push([
      title,
      network,
      networkSearchUrl(network, title),
      str(item.recommended_by, 80),
      list,
      str(item.notes, 500),
      item.movie ? 1 : 0,
      str(item.watching_with, 80),
      safePosterUrl(item.poster_url),
      slug,
      session.email,
      tmdbId,
      tmdbType,
      year,
    ]);
    added.push(title);
  }

  if (inserts.length) {
    // A copy has no title of its own: the name is TMDB's, on the shared row
    // below.
    const cols = 'network, network_url, recommended_by, list, notes, movie, watching_with, member_slug, added_by, tmdb_id, tmdb_type';
    const stmt = env.DB.prepare(`INSERT INTO shows (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // D1 batches are one round trip but not unbounded; chunk so a 200-row
    // import doesn't hand the driver a single oversized statement list.
    for (let i = 0; i < inserts.length; i += 50) {
      // The poster and year belong to the show's shared row (below), not the
      // member's copy.
      await env.DB.batch(inserts.slice(i, i + 50).map(args => stmt.bind(...args.slice(1, 8), ...args.slice(9, 13))));
    }
  }

  // A new entry gets its shared row now rather than at tonight's rebuild;
  // an entry already in the club keeps the row it has.
  // The parse step resolved each title against TMDB, so its name, poster and
  // year are TMDB's. They seed the shared row; the nightly passes fill the
  // rest, since a row missing cast and episode data is a gap they select.
  const keys = new Map();
  for (const args of inserts) {
    if (args[11] && args[12]) keys.set(`${args[12]}:${args[11]}`, { type: args[12], id: args[11], name: args[0], poster: args[8], year: args[13] });
  }
  for (const k of keys.values()) {
    const have = await env.DB.prepare('SELECT 1 FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').bind(k.type, k.id).first().catch(() => null);
    if (!have) {
      await writeTitle(env, k.type, k.id, { name: k.name, fields: { poster_url: k.poster || null, release_year: k.year || null } });
    }
  }

  // Imported rows land with the id, poster and year the parse step resolved,
  // but no cast, overview or real deep link. The client fires the existing
  // background /api/enrich pass once the import lands; the scheduled job is
  // the backstop if it doesn't.

  // A current client marks its last call `final` and sends what it left out.
  // An older one (iOS 1.6 and earlier, before the email existed) sends no
  // `final` at all and still submits unmatched rows, so the server sets them
  // aside here and the app never says so; email those from each call, so a
  // member on an old build still learns what to add by hand. One call per 100
  // rows, so a long import on an old build can send a note per batch, inside
  // the same daily cap.
  const legacyClient = !('final' in body);
  const emailed = body.final === true
    ? await emailUnmatched(env, session, addedBefore + added.length, [...new Set([...clientUnmatched, ...unmatched])])
    : legacyClient
      ? await emailUnmatched(env, session, added.length, unmatched)
      : false;

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

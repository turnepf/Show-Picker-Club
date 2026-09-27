// "Watching With" as people rather than text.
//
// The field stays free text — you can still type "my sister" or "the group
// chat". What this module adds is the case where the name is a member of the
// club you share a private group with: naming them links the two libraries.
// The title lands on their list too, and their copy names you back.
//
// Three rules hold everywhere in here, and the tests in
// scripts/watching-with-test.mjs exist to keep them holding:
//
//   1. **Only group-mates can be named.** Every slug that arrives from a
//      client is checked against `group_members` before it is written
//      anywhere. A hand-typed slug for someone you share no group with is
//      dropped, not honoured. This is the whole reason a cross-member write
//      is acceptable here when suggest-a-show and share-to-member (retired
//      2026-07, still 410) were not: a group is a relationship both people
//      opted into.
//   2. **A list they already made is never rearranged.** If they already have
//      the title, we link to the row they have — whatever list it's on, in
//      whatever order they put it. Only a title they don't have gets created,
//      and only then does it land on the same list as the tagger's copy.
//   3. **Unlinking never deletes their row.** Dropping a link takes your name
//      off their copy and leaves the show sitting on their list. It arrived,
//      they may have started watching it; removing it is their call.
//
// `shows.watching_with` is kept in sync as the display string — free text
// first, then the linked members' names — so tvOS, watchOS and any build
// installed before this shipped keep rendering the one field they read.

import { fetchEnrichment } from './enrichment.js';

// Ceiling on how many people one show can name. Far above a sofa's capacity;
// it's here so a scripted client can't fan one add out across a large group.
export const MAX_WATCHERS = 10;

// ---- name helpers -------------------------------------------------------

const norm = (s) => (s || '').trim().toLowerCase();

// `watching_with` is a comma-joined display string. Splitting on commas is
// how it has always been read by eye; this makes that explicit so a linked
// name can be found and removed without disturbing the free text around it.
export function splitNames(text) {
  return (text || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

// Free text plus linked names, in that order, with any part that duplicates a
// linked name removed first. `knownNames` is the union of the names linked
// before and after the change: without the "before" half, a name whose link
// was just dropped would survive as free text and the removal would look like
// it did nothing.
export function composeWatchingWith(rawText, linkedNames, knownNames = linkedNames) {
  const known = knownNames.map(norm);
  const free = splitNames(rawText).filter((p) => !known.includes(norm(p)));
  const joined = [...free, ...linkedNames].join(', ');
  return joined || null;
}

// The name a member is shown as. Same fallback chain as /api/members and the
// group-watchers list: the first_name override, else the first word of their
// full name, else the slug. Disambiguated with a last initial only when two
// people in the same picker would otherwise read identically — the club is
// small enough that "Quinn" is usually the whole answer.
export function displayNames(rows) {
  const counts = {};
  for (const r of rows) {
    const fn = r.first_name || (r.name || '').split(' ')[0] || r.slug;
    counts[fn] = (counts[fn] || 0) + 1;
  }
  const out = new Map();
  for (const r of rows) {
    const fn = r.first_name || (r.name || '').split(' ')[0] || r.slug;
    const initial = r.last_initial || (r.last_name || '').charAt(0);
    out.set(r.slug, counts[fn] > 1 && initial ? `${fn} ${initial}` : fn);
  }
  return out;
}

// ---- reads --------------------------------------------------------------

// Everyone who shares at least one group with `slug`, excluding `slug`. This
// is the candidate list the picker draws, and the same set every write in
// here validates against. Disabled accounts are left out: they can't act on
// a show landing on their list.
export async function groupMates(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.slug, m.name, m.first_name, m.last_initial, m.last_name
       FROM group_members gm
       INNER JOIN members m ON m.slug = gm.member_slug
      WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?)
        AND m.slug != ?
        AND COALESCE(m.disabled, 0) = 0
      ORDER BY m.first_name, m.name`
  ).bind(slug, slug).all();
  return results || [];
}

// D1 allows at most 100 bound parameters per query — well under the size of a
// keen member's library, and this helper is called with one id per owned row.
// Chunking keeps the whole list load from 500ing on the day someone's library
// crosses that line.
const IN_CHUNK = 90;

// The linked members on each of `showIds`, as {slug, name}. One query per
// chunk of the page rather than one per row — list loads call this with every
// show the member owns.
export async function watchersForShows(env, showIds) {
  const byShow = new Map(showIds.map((id) => [id, []]));
  if (!showIds.length) return byShow;
  const results = [];
  for (let i = 0; i < showIds.length; i += IN_CHUNK) {
    const chunk = showIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const { results: rows } = await env.DB.prepare(
      `SELECT sw.show_id, m.slug, m.name, m.first_name, m.last_initial, m.last_name
         FROM show_watchers sw
         INNER JOIN members m ON m.slug = sw.member_slug
        WHERE sw.show_id IN (${placeholders})`
    ).bind(...chunk).all();
    results.push(...(rows || []));
  }
  const names = displayNames(results || []);
  for (const r of results || []) {
    const list = byShow.get(r.show_id);
    if (list) list.push({ slug: r.slug, name: names.get(r.slug) });
  }
  for (const list of byShow.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return byShow;
}

export async function watchersForShow(env, showId) {
  return (await watchersForShows(env, [showId])).get(showId) || [];
}

// Owner-only attribution: which member each row's `added_by` email belongs
// to, attached as `added_by_member` {slug, name} when it isn't the owner
// themselves. `added_by` has always carried the session email of whoever
// created the row; for a copy created by a Watching With tag that is the
// tagger — and naming them is what answers "why is this on my list" for a
// title the owner never added. Resolution goes through member_emails, so a
// non-member value ('seed', a departed member's email) resolves to nothing
// and the row simply carries no attribution.
export async function attachAddedByMembers(env, rows, ownerSlug) {
  const emails = [...new Set(rows.map((r) => r.added_by).filter((e) => e && e.includes('@')))];
  if (!emails.length) return;
  const found = [];
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const chunk = emails.slice(i, i + IN_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT me.email, m.slug, m.name, m.first_name, m.last_initial, m.last_name
         FROM member_emails me
         INNER JOIN members m ON m.slug = me.member_slug
        WHERE me.email IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();
    found.push(...(results || []));
  }
  if (!found.length) return;
  // One member can hold several emails; dedupe before display-name counting
  // or a two-email member would read as two people sharing a first name and
  // pick up a spurious last initial.
  const bySlug = new Map(found.map((m) => [m.slug, m]));
  const names = displayNames([...bySlug.values()]);
  const byEmail = new Map(found.map((m) => [m.email, m.slug]));
  for (const r of rows) {
    const slug = r.added_by ? byEmail.get(r.added_by) : null;
    if (slug && slug !== ownerSlug) r.added_by_member = { slug, name: names.get(slug) };
  }
}

// The member's own copy of a title, if they have one. Matched the way copies
// are matched everywhere else in the app: by tmdb_id when both rows carry
// one, else case-insensitively by title. Archived rows count — finding one is
// what stops a tag from creating a second copy of something they shelved.
export async function copyForMember(env, memberSlug, { title, tmdb_id }) {
  if (tmdb_id) {
    const byId = await env.DB.prepare(
      'SELECT * FROM shows WHERE member_slug = ? AND tmdb_id = ? LIMIT 1'
    ).bind(memberSlug, tmdb_id).first();
    if (byId) return byId;
  }
  return await env.DB.prepare(
    'SELECT * FROM shows WHERE member_slug = ? AND LOWER(title) = LOWER(?) LIMIT 1'
  ).bind(memberSlug, title).first();
}

// ---- writes -------------------------------------------------------------

// Narrow `slugs` to the ones the caller is actually allowed to name. Anything
// else — a slug for a member they share no group with, a slug that doesn't
// exist, their own — is dropped silently rather than 400'd: a stale client
// holding a group it has since left should save the rest of the edit, not
// fail it.
export async function validWatcherSlugs(env, ownerSlug, slugs) {
  if (!Array.isArray(slugs)) return null;
  const wanted = [...new Set(slugs.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))];
  if (!wanted.length) return [];
  const mates = new Set((await groupMates(env, ownerSlug)).map((m) => m.slug));
  return wanted.filter((s) => mates.has(s)).slice(0, MAX_WATCHERS);
}

// Give `memberSlug` a copy of `source` on `list`, or return the copy they
// already have. Rule 2 lives here: an existing row is returned untouched, and
// an archived one is brought back rather than duplicated.
//
// A created row inherits the source row's enrichment (poster, overview, cast,
// ids) instead of re-fetching it — same title, same TMDB entry, and it keeps
// a fan-out from multiplying upstream API calls by the size of the group.
//
// Exported for group suggestions (_shared/group-suggestions.js), whose
// "Add to Next Up" is the same operation pointed the other way: the member
// pulls a copy of the recommender's row onto their own list.
export async function ensureCopy(env, memberSlug, source, list, taggerEmail) {
  const existing = await copyForMember(env, memberSlug, source);
  if (existing) {
    if (existing.archived) {
      // Shelved, and now someone is watching it with them. Bring it back to
      // the list the tagger has it on — an archived row is on no list, so
      // there is no placement of theirs to preserve here.
      await env.DB.prepare(
        "UPDATE shows SET archived = 0, list = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(list, existing.id).run();
      return await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(existing.id).first();
    }
    return existing;
  }

  const result = await env.DB.prepare(
    `INSERT INTO shows (title, network, network_url, list, movie, full_series, rating,
        poster_url, network_logo_url, member_slug, added_by,
        overview, backdrop_url, tmdb_rating, content_rating, trailer_key, director,
        director_imdb_id, runtime, release_year, watch_link, tmdb_id, tmdb_type,
        episodes_released, vote_count, tagline, original_language, studio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    source.title, source.network || null, source.network_url || null, list,
    source.movie || 0, source.full_series || 0, source.rating || null,
    source.poster_url || null, source.network_logo_url || null,
    memberSlug, taggerEmail || null,
    source.overview || null, source.backdrop_url || null, source.tmdb_rating || null,
    source.content_rating || null, source.trailer_key || null, source.director || null,
    source.director_imdb_id || null, source.runtime || null, source.release_year || null,
    source.watch_link || null, source.tmdb_id || null, source.tmdb_type || null,
    source.episodes_released ?? null, source.vote_count ?? null, source.tagline || null,
    source.original_language || null, source.studio || null
  ).run();

  const newId = result.meta.last_row_id;
  // Cast comes along too — a row with no actors renders a visibly emptier
  // detail screen than the copy it was cloned from.
  const { results: cast } = await env.DB.prepare(
    'SELECT name, imdb_id, ord, tmdb_person_id FROM actors WHERE show_id = ?'
  ).bind(source.id).all();
  if (cast && cast.length) {
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
    await env.DB.batch(cast.map((a, i) => stmt.bind(newId, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
  }
  // A row cloned from a source that never got enriched (added offline, or
  // added before its enrichment landed) would otherwise stay bare forever —
  // nothing re-enriches a row that already exists. Fill it once, in the
  // background, from the title.
  if (!source.tmdb_id && !source.poster_url) {
    try {
      const enriched = await fetchEnrichment(source.title, env, !!source.movie);
      if (enriched && (enriched.posterUrl || enriched.tmdbId)) {
        await env.DB.prepare(
          `UPDATE shows SET poster_url = COALESCE(?, poster_url), overview = COALESCE(?, overview),
              tmdb_id = COALESCE(?, tmdb_id), tmdb_type = COALESCE(?, tmdb_type),
              enriched_at = datetime('now') WHERE id = ?`
        ).bind(enriched.posterUrl || null, enriched.overview || null,
          enriched.tmdbId || null, enriched.tmdbType || null, newId).run();
      }
    } catch (e) { /* the row is usable without it */ }
  }
  return await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(newId).first();
}

// Rewrite one row's `watching_with` from its current link set. `rawText` is
// the text to build on — what the client just sent for the row being edited,
// or the row's stored value for a mirror row nobody typed into.
async function refreshWatchingWith(env, show, rawText, previousNames) {
  const linked = await watchersForShow(env, show.id);
  const linkedNames = linked.map((w) => w.name);
  const text = composeWatchingWith(rawText, linkedNames, [...linkedNames, ...previousNames]);
  await env.DB.prepare('UPDATE shows SET watching_with = ? WHERE id = ?').bind(text, show.id).run();
  return { text, watchers: linked };
}

// Apply the full set of named members to `show`, adding and removing links in
// mirrored pairs.
//
// `slugs` is the complete desired set, not a delta — the edit sheet sends
// everyone currently ticked, so anyone previously linked and now absent is
// unlinked. Returns the row's new `watching_with` text and its watchers.
//
// `rawWatchingWith` is the free text the client sent for this row. Linked
// names are appended to it here rather than trusted from the client, so a
// client that sends the whole composed string back (or an older one that
// knows nothing about links) both end up correct.
export async function syncWatchers(env, { show, ownerSlug, ownerEmail, slugs, rawWatchingWith }) {
  const desired = await validWatcherSlugs(env, ownerSlug, slugs);
  // `null` means the client didn't mention watchers at all — an older build,
  // or a partial update. Leave the links alone and just recompose the text so
  // the names it already carries stay accurate.
  if (desired === null) {
    return await refreshWatchingWith(env, show, rawWatchingWith ?? show.watching_with, []);
  }

  const before = await watchersForShow(env, show.id);
  const beforeSlugs = new Set(before.map((w) => w.slug));
  const added = desired.filter((s) => !beforeSlugs.has(s));
  const removed = before.filter((w) => !desired.includes(w.slug)).map((w) => w.slug);

  const ownerName = displayNames([
    (await env.DB.prepare('SELECT slug, name, first_name, last_initial, last_name FROM members WHERE slug = ?')
      .bind(ownerSlug).first()) || { slug: ownerSlug },
  ]).get(ownerSlug);

  for (const slug of added) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO show_watchers (show_id, member_slug, created_by) VALUES (?, ?, ?)'
    ).bind(show.id, slug, ownerSlug).run();

    // The mirror: their copy of the title, naming the tagger back. This is
    // the cross-member write, and it is bounded to a member the check above
    // confirmed shares a group with the owner.
    const theirs = await ensureCopy(env, slug, show, show.list, ownerEmail);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO show_watchers (show_id, member_slug, created_by) VALUES (?, ?, ?)'
    ).bind(theirs.id, ownerSlug, ownerSlug).run();
    await refreshWatchingWith(env, theirs, theirs.watching_with, []);
    // A show arriving on their list is a member-initiated change to it, just
    // by a different member — same as the shared-in rows last_activity_at has
    // always counted. Background jobs are the ones that must not touch
    // updated_at; this isn't one.
    await env.DB.prepare("UPDATE shows SET updated_at = datetime('now') WHERE id = ?").bind(theirs.id).run();
  }

  for (const slug of removed) {
    await env.DB.prepare('DELETE FROM show_watchers WHERE show_id = ? AND member_slug = ?')
      .bind(show.id, slug).run();
    const theirs = await copyForMember(env, slug, show);
    if (!theirs) continue;
    // Rule 3: the link goes, the show stays. Their row keeps its list, its
    // order, its notes — it just stops naming the person who tagged them.
    await env.DB.prepare('DELETE FROM show_watchers WHERE show_id = ? AND member_slug = ?')
      .bind(theirs.id, ownerSlug).run();
    await refreshWatchingWith(env, theirs, theirs.watching_with, [ownerName]);
  }

  const removedNames = before.filter((w) => removed.includes(w.slug)).map((w) => w.name);
  return await refreshWatchingWith(env, show, rawWatchingWith ?? show.watching_with, removedNames);
}

// Take a departing member's name out of every `watching_with` that names
// them, before their rows go. Called by account deletion, which deletes
// explicitly rather than relying on cascades — and the display string is text,
// not a foreign key, so nothing would clean it up on its own.
//
// The links themselves are deleted by the caller in the same batch; this pass
// only rewrites the strings, which has to happen while the links still say
// which strings are affected.
export async function forgetMemberAsWatcher(env, slug) {
  const member = await env.DB.prepare(
    'SELECT slug, name, first_name, last_initial, last_name FROM members WHERE slug = ?'
  ).bind(slug).first();
  const name = displayNames([member || { slug }]).get(slug);
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM shows s
       INNER JOIN show_watchers sw ON sw.show_id = s.id
      WHERE sw.member_slug = ? AND s.member_slug != ?`
  ).bind(slug, slug).all();
  for (const show of results || []) {
    const remaining = (await watchersForShow(env, show.id)).filter((w) => w.slug !== slug);
    const text = composeWatchingWith(show.watching_with, remaining.map((w) => w.name), [...remaining.map((w) => w.name), name]);
    await env.DB.prepare('UPDATE shows SET watching_with = ? WHERE id = ?').bind(text, show.id).run();
  }
}

// Drop every link a show has in both directions. Called before deleting a
// row: the cascade takes the show's own links, but the mirror rows live on
// other members' shows and point back at an owner who still exists, so
// without this a deleted copy would leave its owner's name on other people's
// lists forever.
export async function unlinkShow(env, show) {
  const linked = await watchersForShow(env, show.id);
  if (!linked.length) return;
  const ownerName = displayNames([
    (await env.DB.prepare('SELECT slug, name, first_name, last_initial, last_name FROM members WHERE slug = ?')
      .bind(show.member_slug).first()) || { slug: show.member_slug },
  ]).get(show.member_slug);
  for (const w of linked) {
    const theirs = await copyForMember(env, w.slug, show);
    if (!theirs) continue;
    await env.DB.prepare('DELETE FROM show_watchers WHERE show_id = ? AND member_slug = ?')
      .bind(theirs.id, show.member_slug).run();
    await refreshWatchingWith(env, theirs, theirs.watching_with, [ownerName]);
  }
  await env.DB.prepare('DELETE FROM show_watchers WHERE show_id = ?').bind(show.id).run();
}

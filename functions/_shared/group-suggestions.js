// Recommend a show to a group — JC's "recommend to group" button (via
// Jennifer, 8/2026), and the first suggestion feature since suggest-a-show
// was retired in 2026-07.
//
// The design rule that makes it buildable at all: **nothing in here writes to
// another member's list.** A suggestion is a row the GROUP owns; the pop-up's
// "Add to Next Up" is the recipient's own tap, which pulls a copy onto their
// own list through the same ensureCopy path Watching With uses; Dismiss
// writes a per-member mark that hides the card for that member and nobody
// else. The retired feature's sin — anyone pushing a row onto anyone —
// cannot recur because there is no push anywhere.
//
// Scoping is the standard group tier: every route re-checks `group_members`
// and 403s otherwise. The note on a suggestion is GROUP-VISIBLE BY DESIGN —
// it is addressed to the group, unlike the owner-only memos (`notes`,
// `recommended_by`) on library rows. See docs/INVARIANTS.md.
//
// The properties scripts/group-suggestions-test.mjs pins:
//
//   1. Group-mates only, both directions: an outsider can neither read the
//      board nor put a card on it, and a member sees only their own groups'.
//   2. Adding never rearranges a list the member already made — an existing
//      copy (any list, archived included) is honoured, not duplicated.
//   3. Dismiss is per-member: one member's Dismiss leaves the card standing
//      for everyone else.
//   4. Your own recommendation never pops up at you.
//   5. One member can't flood a group: a per-member daily ceiling, and a
//      duplicate title folds into the existing card instead of stacking.

import { ensureCopy, copyForMember, displayNames } from './watchers.js';
import { sameShowWhere } from './same-show.js';

// Ceiling on recommendations per member per group per day. A recommendation
// fans a pop-up out to the whole group, so the cap is deliberately lower than
// anyone recommending in good faith would notice.
export const MAX_SUGGESTIONS_PER_DAY = 10;

export async function isGroupMember(env, groupId, memberSlug) {
  const row = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, memberSlug).first();
  return !!row;
}

// The board, shaped for one viewer: every suggestion in the group, newest
// first, each carrying the recommender's display name, who has added it, the
// viewer's own response, and where the title already sits in the viewer's
// library (`on_your_list`) so the client can label the Add button honestly.
// The pop-up queue is a client-side filter of this: !is_yours && !your_response.
export async function suggestionsForGroup(env, groupId, viewerSlug) {
  const { results: suggestions } = await env.DB.prepare(
    `SELECT gs.id, gs.group_id, gs.suggested_by, gs.show_id, gs.title,
            gs.tmdb_id, gs.movie, gs.poster_url, gs.network, gs.note, gs.created_at
       FROM group_suggestions gs
      WHERE gs.group_id = ?
      ORDER BY gs.created_at DESC, gs.id DESC`
  ).bind(groupId).all();
  if (!suggestions || !suggestions.length) return [];

  // Display names for everyone the payload mentions — recommenders and
  // responders — resolved in one query, disambiguated the same way every
  // other member-name surface is.
  const { results: memberRows } = await env.DB.prepare(
    `SELECT m.slug, m.name, m.first_name, m.last_initial, m.last_name
       FROM group_members gm INNER JOIN members m ON m.slug = gm.member_slug
      WHERE gm.group_id = ?`
  ).bind(groupId).all();
  const names = displayNames(memberRows || []);

  const ids = suggestions.map((s) => s.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: responses } = await env.DB.prepare(
    `SELECT suggestion_id, member_slug, response FROM group_suggestion_responses
      WHERE suggestion_id IN (${placeholders})`
  ).bind(...ids).all();
  const bySuggestion = new Map(ids.map((id) => [id, []]));
  for (const r of responses || []) bySuggestion.get(r.suggestion_id)?.push(r);

  const out = [];
  for (const s of suggestions) {
    const rs = bySuggestion.get(s.id) || [];
    const mine = rs.find((r) => r.member_slug === viewerSlug);
    const added = rs.filter((r) => r.response === 'added');
    const ownCopy = await copyForMember(env, viewerSlug, s);
    out.push({
      id: s.id,
      group_id: s.group_id,
      // The recommender's copy, for opening the catalog detail screen — the
      // same cross-member id Trending cards navigate with. Null once they
      // delete that copy; the snapshot below still renders the card.
      show_id: s.show_id,
      title: s.title,
      tmdb_id: s.tmdb_id,
      movie: s.movie || 0,
      poster_url: s.poster_url,
      network: s.network,
      note: s.note,
      created_at: s.created_at,
      suggested_by: s.suggested_by,
      // A recommender who has since left the group (or the club) falls back
      // to the slug rather than vanishing the card.
      suggested_by_name: names.get(s.suggested_by) || s.suggested_by,
      is_yours: s.suggested_by === viewerSlug ? 1 : 0,
      your_response: mine ? mine.response : null,
      added_count: added.length,
      added_names: added.map((r) => names.get(r.member_slug) || r.member_slug).sort(),
      on_your_list: ownCopy && !ownCopy.archived ? ownCopy.list : null,
    });
  }
  return out;
}

export async function suggestionForViewer(env, groupId, suggestionId, viewerSlug) {
  const all = await suggestionsForGroup(env, groupId, viewerSlug);
  return all.find((s) => s.id === suggestionId) || null;
}

// Put a card on the group's board, snapshotting identity from the
// recommender's own copy. Returns {status, ...}: 201 with the new card, 200
// with the existing one when the title is already on the board (a double-tap
// or a second member recommending the same show folds in rather than
// stacking pop-ups), 429 at the daily ceiling.
export async function createSuggestion(env, { groupId, memberSlug, show, note }) {
  // The same show already on this group's board → that card is the answer.
  // Same show means the same TMDB entry when both carry one, so a different
  // film that shares the title gets its own card.
  const match = sameShowWhere('g', show, { hasType: false });
  const existing = await env.DB.prepare(
    `SELECT id FROM group_suggestions g WHERE group_id = ? AND ${match.sql}
     ORDER BY (g.tmdb_id IS NULL) LIMIT 1`
  ).bind(groupId, ...match.binds).first();
  if (existing) {
    return { status: 200, suggestion: await suggestionForViewer(env, groupId, existing.id, memberSlug) };
  }

  const { cnt } = (await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM group_suggestions
      WHERE group_id = ? AND suggested_by = ? AND created_at >= datetime('now', '-1 day')`
  ).bind(groupId, memberSlug).first()) || { cnt: 0 };
  if (cnt >= MAX_SUGGESTIONS_PER_DAY) {
    return { status: 429, error: 'Too many recommendations today' };
  }

  const result = await env.DB.prepare(
    `INSERT INTO group_suggestions (group_id, suggested_by, show_id, title, tmdb_id, movie, poster_url, network, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    groupId, memberSlug, show.id, show.title, show.tmdb_id || null,
    show.movie || 0, show.poster_url || null, show.network || null, note || null
  ).run();
  return { status: 201, suggestion: await suggestionForViewer(env, groupId, Number(result.meta.last_row_id), memberSlug) };
}

// One member answers one card. 'dismissed' is only the mark; 'added' is the
// mark plus the pull — a copy of the recommended title onto the member's own
// Next Up, honouring any copy they already have (rule 2 of Watching With:
// an existing row is linked where it sits, an archived one is revived, a
// list they made is never rearranged). A later answer replaces an earlier
// one, so dismissing the pop-up doesn't bar adding from the board.
export async function respondToSuggestion(env, { groupId, suggestionId, memberSlug, memberEmail, response }) {
  const suggestion = await env.DB.prepare(
    'SELECT * FROM group_suggestions WHERE id = ? AND group_id = ?'
  ).bind(suggestionId, groupId).first();
  if (!suggestion) return { status: 404, error: 'Suggestion not found' };
  if (suggestion.suggested_by === memberSlug) {
    return { status: 400, error: 'You cannot respond to your own recommendation' };
  }

  let show = null;
  if (response === 'added') {
    // The source to clone: the recommender's copy when it still exists (full
    // enrichment, cast and all), else the snapshot on the card — ensureCopy
    // backfills a bare source from TMDB on its own.
    const source = (suggestion.show_id
      ? await env.DB.prepare('SELECT * FROM shows_v WHERE id = ?').bind(suggestion.show_id).first()
      : null) || {
        id: null, title: suggestion.title, tmdb_id: suggestion.tmdb_id,
        movie: suggestion.movie, poster_url: suggestion.poster_url, network: suggestion.network,
      };
    const hadCopy = await copyForMember(env, memberSlug, suggestion);
    // added_by is the member's own email — this is their tap, not the
    // recommender's write.
    show = await ensureCopy(env, memberSlug, source, 'next', memberEmail);
    // A card TMDB can't match (an old one with no entry) makes no copy.
    if (!show) return { status: 422, error: 'no_match', message: `"${suggestion.title}" wasn't found in the show catalog, so it can't be added.` };
    if (!hadCopy) {
      // A fresh copy remembers who to thank, in the owner-only field that has
      // always meant exactly this. A copy they already had is theirs — its
      // memos are not touched.
      const names = displayNames([
        (await env.DB.prepare('SELECT slug, name, first_name, last_initial, last_name FROM members WHERE slug = ?')
          .bind(suggestion.suggested_by).first()) || { slug: suggestion.suggested_by },
      ]);
      await env.DB.prepare(
        "UPDATE shows SET recommended_by = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(names.get(suggestion.suggested_by), show.id).run();
      show = await env.DB.prepare('SELECT * FROM shows_v WHERE id = ?').bind(show.id).first();
    }
  }

  await env.DB.prepare(
    `INSERT INTO group_suggestion_responses (suggestion_id, member_slug, response)
     VALUES (?, ?, ?)
     ON CONFLICT (suggestion_id, member_slug)
     DO UPDATE SET response = excluded.response, created_at = datetime('now')`
  ).bind(suggestionId, memberSlug, response).run();

  const card = await suggestionForViewer(env, groupId, suggestionId, memberSlug);
  return { status: 200, suggestion: card, ...(show ? { show } : {}) };
}

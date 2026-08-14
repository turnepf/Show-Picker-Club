import { isAdmin } from '../_shared/admin.js';

// GET /api/admin-member-groups?member=<slug>
//
// Which private groups one member belongs to, and who else is in each — the
// Groups section of the admin member screen (Admin ▸ Manage members ▸ a
// member), and the roster behind tapping one of those groups.
//
// This is the one place a group's membership is legible to somebody who isn't
// in the group, so the terms are narrow and deliberate:
//
//   1. **Admin only.** Not "a logged-in member", not "a group-mate" — the same
//      bar as /api/admin-member-emails, which already hands admins every
//      member's login email and phone number. Group names and a roster of
//      first names are a smaller disclosure than that; a non-admin session
//      gets 403 here, including for their own groups (they have /api/groups
//      for those).
//   2. **Membership only, never content.** Names, rosters, counts, who created
//      it. What a group is *watching* — Group Trending, the shared library —
//      stays behind `group_members` in /api/groups/[id], which this endpoint
//      does not touch. An operator answering "who is Thayná in a group with?"
//      needs the shape of the graph, not everyone's lists.
//
// See docs/INVARIANTS.md §13.
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// "Thayná Matos" for the operator's view. Manage Members already shows admins
// full names, so this screen showing first-name-only labels would be a
// pointless half-measure — two people called Dan are exactly the case where
// this screen has to be unambiguous. Falls back to whatever is on file, and
// finally to the slug, so a row with no name still renders as somebody.
function personName(m) {
  const full = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  return full || (m.name || '').trim() || m.slug;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }

  const slug = (new URL(request.url).searchParams.get('member') || '').trim().toLowerCase();
  if (!slug) {
    return json({ error: 'member required' }, 400);
  }

  // Groups the member is in. Newest first, the same order /api/groups uses,
  // so a member and an admin looking at the same person see the same list in
  // the same order.
  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.name, g.creator_slug, g.created_at,
            (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
       FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.member_slug = ?
      ORDER BY g.created_at DESC, g.id DESC`
  ).bind(slug).all();

  if (!groups || !groups.length) {
    return json({ member: slug, groups: [] });
  }

  // Every roster in one query rather than one per group — an operator opening
  // a member who is in eight groups shouldn't cost eight round trips.
  const ids = groups.map((g) => g.id);
  const { results: rows } = await env.DB.prepare(
    `SELECT gm.group_id, m.slug, m.name, m.first_name, m.last_name, m.disabled
       FROM group_members gm
       INNER JOIN members m ON m.slug = gm.member_slug
      WHERE gm.group_id IN (${ids.map(() => '?').join(',')})
      ORDER BY m.first_name COLLATE NOCASE, m.last_name COLLATE NOCASE, m.slug`
  ).bind(...ids).all();

  const byGroup = new Map(ids.map((id) => [id, []]));
  for (const r of rows || []) {
    byGroup.get(r.group_id)?.push({
      slug: r.slug,
      name: personName(r),
      is_creator: 0,
      disabled: r.disabled ? 1 : 0,
    });
  }

  return json({
    member: slug,
    groups: groups.map((g) => {
      const members = byGroup.get(g.id) || [];
      for (const m of members) m.is_creator = m.slug === g.creator_slug ? 1 : 0;
      return { ...g, members };
    }),
  });
}

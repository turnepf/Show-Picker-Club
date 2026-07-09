import { getSession } from '../_shared/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  // The roster stays public (the landing page and pre-login apps render it),
  // but full names and calendar tokens are for logged-in members only —
  // visitors get first-name-level display names.
  const session = await getSession(request, env);
  // Members are returned ordered by their most-recent non-seed activity
  // (newest first), then alphabetically. The frontend decides how many to
  // feature on the home page; the rest tuck into a "Browse all" disclosure.
  // last_activity_at is MAX(updated_at, created_at) over the member's shows
  // where added_by != 'seed', so editing/archiving seeded rows doesn't
  // count — only owning a real (self-added, suggested-in, or shared-in)
  // show registers as activity. NULL added_by predates the column and is
  // treated as engaged since only member-added shows ever had NULL there.
  // If members.calendar_token doesn't exist yet (pre-migration 029), retry
  // without it so the home page keeps rendering.
  const query = (withToken) => env.DB.prepare(
    `SELECT h.slug, h.name, h.first_name, h.last_initial,${withToken ? ' h.calendar_token,' : ''}
            COUNT(CASE WHEN s.archived = 0 THEN s.id END) as show_count,
            COUNT(CASE WHEN s.archived = 0 AND s.list = 'watching' THEN s.id END) as watching_count,
            COUNT(CASE WHEN s.archived = 0 AND s.list = 'waiting' THEN s.id END) as waiting_count,
            COUNT(CASE WHEN s.archived = 0 AND s.list = 'recommending' THEN s.id END) as recommending_count,
            COUNT(CASE WHEN s.archived = 0 AND s.list = 'next' THEN s.id END) as next_count,
            MAX(
              CASE WHEN COALESCE(s.added_by, '') != 'seed'
                   THEN COALESCE(s.updated_at, s.created_at) END
            ) as last_activity_at
     FROM members h
     LEFT JOIN shows s ON s.member_slug = h.slug
     GROUP BY h.slug, h.name, h.first_name, h.last_initial
     ORDER BY last_activity_at DESC NULLS LAST, h.name`
  ).all();
  const { results } = await query(true).catch(() => query(false));

  const firstNameCounts = {};
  for (const m of results) {
    const fn = m.first_name || m.name.split(' ')[0];
    firstNameCounts[fn] = (firstNameCounts[fn] || 0) + 1;
  }

  const members = results.map(m => {
    const fn = m.first_name || m.name.split(' ')[0];
    const displayName = firstNameCounts[fn] > 1 && m.last_initial
      ? `${fn} ${m.last_initial}`
      : fn;
    return {
      slug: m.slug,
      // Logged out, `name` degrades to the display name so the shipped app
      // decoders keep working without exposing members' full names.
      name: session ? m.name : displayName,
      ...(session && m.calendar_token ? { calendar_token: m.calendar_token } : {}),
      first_name: fn,
      display_name: displayName,
      show_count: m.show_count,
      watching_count: m.watching_count,
      waiting_count: m.waiting_count,
      recommending_count: m.recommending_count,
      next_count: m.next_count,
      last_activity_at: m.last_activity_at,
    };
  });

  return new Response(JSON.stringify({ members }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

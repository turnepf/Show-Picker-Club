import { getSession } from '../_shared/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  // The roster stays public (the landing page and pre-login apps render it).
  // Everyone — logged in or not — gets first-name-level display names only;
  // full names never leave the server. calendar_token is a per-member secret:
  // each member gets exactly their own, never anyone else's.
  const session = await getSession(request, env);
  // Members are returned ordered by their most-recent non-seed activity
  // (newest first), then alphabetically. The frontend decides how many to
  // feature on the home page; the rest tuck into a "Browse all" disclosure.
  // last_activity_at is MAX(updated_at, created_at) over the member's shows
  // where added_by != 'seed', so editing/archiving seeded rows doesn't
  // count — only owning a real (self-added, suggested-in, or shared-in)
  // show registers as activity. NULL added_by predates the column and is
  // treated as engaged since only member-added shows ever had NULL there.
  // Opening an app counts too: /auth/check stamps sessions.last_seen_at, and
  // the member's latest one joins in — truncated to the day, because this
  // endpoint is public and an exact stamp would tell anyone on the internet
  // who had the app open within the hour. A day-level open ties with nobody
  // who edited a show that day (the edit's time-of-day sorts above midnight).
  // If members.calendar_token (migration 029) doesn't exist yet, retry with
  // a simpler shape so the home page keeps rendering.
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
            ) as library_activity_at,
            MAX(o.opened_on) as opened_on
     FROM members h
     LEFT JOIN shows s ON s.member_slug = h.slug
     LEFT JOIN (SELECT member_slug, date(MAX(last_seen_at)) || ' 00:00:00' as opened_on
                FROM sessions WHERE member_slug IS NOT NULL
                GROUP BY member_slug) o ON o.member_slug = h.slug
     GROUP BY h.slug, h.name, h.first_name, h.last_initial`
  ).all();
  const { results } = await query(true).catch(() => query(false));
  // SQLite's two-argument MAX() is NULL if either side is, so the pick and
  // the sort happen here rather than in the query.
  for (const m of results) {
    const a = m.library_activity_at, b = m.opened_on;
    m.last_activity_at = a && b ? (a > b ? a : b) : (a || b || null);
  }
  results.sort((x, y) => {
    const a = x.last_activity_at, b = y.last_activity_at;
    if (a !== b) return !a ? 1 : !b ? -1 : a > b ? -1 : 1;
    return x.name.localeCompare(y.name);
  });

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
      // `name` is the display name for everyone — with self-enrollment open,
      // members are no longer all friends, so full names stay server-side.
      // Shipped app decoders read `name` and keep working.
      name: displayName,
      ...(session && session.member_slug === m.slug && m.calendar_token
        ? { calendar_token: m.calendar_token } : {}),
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

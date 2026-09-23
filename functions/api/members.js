import { getSession } from '../_shared/auth.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  // Three tiers, and each pays only for what it gets (docs/INVARIANTS.md §18):
  //
  //   logged out — slug and first-name-level display names, alphabetical.
  //     Universal links and the pre-login apps resolve slugs against this.
  //     One read per member; no shows or sessions are touched, so a crawler
  //     can't turn it into a scan of the library.
  //   member     — plus the per-list counts, and their own calendar_token
  //     (a per-member secret: each member gets exactly their own). Still
  //     alphabetical: the order would otherwise leak who is active.
  //   admin      — plus last_activity_at, most recent first. That's the
  //     roster the admin tools show, and it's the only tier that learns when
  //     anybody last used the app.
  //
  // last_activity_at is the later of two things. A write to a non-seed show:
  // MAX(updated_at, created_at) where added_by != 'seed', so editing seeded
  // rows doesn't count (NULL added_by predates the column and counts). And
  // opening an app: the member's latest sessions.last_seen_at, which
  // /auth/check stamps on launch and on every return to the foreground,
  // throttled to once an hour. Full names never leave the server, at any tier.
  const session = await getSession(request, env);
  const admin = session?.member_slug
    ? !!(await env.DB.prepare('SELECT is_admin FROM members WHERE slug = ?')
        .bind(session.member_slug).first().catch(() => null))?.is_admin
    : false;

  let results;
  if (!session) {
    ({ results } = await env.DB.prepare(
      'SELECT slug, name, first_name, last_initial FROM members'
    ).all());
  } else {
    // If members.calendar_token (migration 029) doesn't exist yet, retry
    // with a simpler shape so the roster keeps rendering.
    const query = (withToken) => env.DB.prepare(
      `SELECT h.slug, h.name, h.first_name, h.last_initial,${withToken ? ' h.calendar_token,' : ''}
              COUNT(CASE WHEN s.archived = 0 THEN s.id END) as show_count,
              COUNT(CASE WHEN s.archived = 0 AND s.list = 'watching' THEN s.id END) as watching_count,
              COUNT(CASE WHEN s.archived = 0 AND s.list = 'waiting' THEN s.id END) as waiting_count,
              COUNT(CASE WHEN s.archived = 0 AND s.list = 'recommending' THEN s.id END) as recommending_count,
              COUNT(CASE WHEN s.archived = 0 AND s.list = 'next' THEN s.id END) as next_count${admin ? `,
              MAX(
                CASE WHEN COALESCE(s.added_by, '') != 'seed'
                     THEN COALESCE(s.updated_at, s.created_at) END
              ) as library_activity_at,
              MAX(o.opened_at) as opened_at` : ''}
       FROM members h
       LEFT JOIN shows s ON s.member_slug = h.slug${admin ? `
       LEFT JOIN (SELECT member_slug, MAX(last_seen_at) as opened_at
                  FROM sessions WHERE member_slug IS NOT NULL
                  GROUP BY member_slug) o ON o.member_slug = h.slug` : ''}
       GROUP BY h.slug, h.name, h.first_name, h.last_initial`
    ).all();
    ({ results } = await query(true).catch(() => query(false)));
  }

  if (admin) {
    // SQLite's two-argument MAX() is NULL if either side is, so the pick
    // happens here rather than in the query.
    for (const m of results) {
      const a = m.library_activity_at, b = m.opened_at;
      m.last_activity_at = a && b ? (a > b ? a : b) : (a || b || null);
    }
  }
  results.sort((x, y) => {
    const a = x.last_activity_at, b = y.last_activity_at;
    if (admin && a !== b) return !a ? 1 : !b ? -1 : a > b ? -1 : 1;
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
      ...(session ? {
        show_count: m.show_count,
        watching_count: m.watching_count,
        waiting_count: m.waiting_count,
        recommending_count: m.recommending_count,
        next_count: m.next_count,
      } : {}),
      ...(admin ? { last_activity_at: m.last_activity_at } : {}),
    };
  });

  return new Response(JSON.stringify({ members }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

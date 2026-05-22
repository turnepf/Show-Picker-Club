export async function onRequestGet(context) {
  const { env } = context;
  // Members are returned ordered by their most-recent non-seed activity
  // (newest first), then alphabetically. The frontend decides how many to
  // feature on the home page; the rest tuck into a "Browse all" disclosure.
  // last_activity_at is MAX(updated_at, created_at) over the member's shows
  // where added_by != 'seed', so editing/archiving seeded rows doesn't
  // count — only owning a real (self-added, suggested-in, or shared-in)
  // show registers as activity. NULL added_by predates the column and is
  // treated as engaged since only member-added shows ever had NULL there.
  const { results } = await env.DB.prepare(
    `SELECT h.slug, h.name, h.first_name, h.last_initial,
            COUNT(CASE WHEN s.archived = 0 THEN s.id END) as show_count,
            MAX(
              CASE WHEN COALESCE(s.added_by, '') != 'seed'
                   THEN COALESCE(s.updated_at, s.created_at) END
            ) as last_activity_at
     FROM members h
     LEFT JOIN shows s ON s.member_slug = h.slug
     GROUP BY h.slug, h.name, h.first_name, h.last_initial
     ORDER BY last_activity_at DESC NULLS LAST, h.name`
  ).all();

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
      name: m.name,
      first_name: fn,
      display_name: displayName,
      show_count: m.show_count,
      last_activity_at: m.last_activity_at,
    };
  });

  return new Response(JSON.stringify({ members }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

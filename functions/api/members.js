export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  // ?engaged_only=1 — hide members whose library is still all seeded shows.
  // Editing or archiving a seed doesn't count; the signal is owning at
  // least one show that wasn't pre-loaded (self-added, suggested in, or
  // shared in — anything with added_by other than 'seed'). NULL added_by
  // means the row predates the seed-tracking column, which only ever
  // applies to member-added shows, so we treat NULL as engaged.
  const engagedOnly = url.searchParams.get('engaged_only') === '1';
  const engagedFilter = engagedOnly
    ? `AND EXISTS (
         SELECT 1 FROM shows s2
         WHERE s2.member_slug = h.slug
           AND COALESCE(s2.added_by, '') != 'seed'
       )`
    : '';
  const { results } = await env.DB.prepare(
    `SELECT h.slug, h.name, h.first_name, h.last_initial, COUNT(s.id) as show_count
     FROM members h
     LEFT JOIN shows s ON s.member_slug = h.slug AND s.archived = 0
     WHERE 1=1 ${engagedFilter}
     GROUP BY h.slug, h.name, h.first_name, h.last_initial
     ORDER BY RANDOM()`
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
    };
  });

  return new Response(JSON.stringify({ members }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

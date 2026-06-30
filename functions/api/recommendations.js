import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

// A member is "seed-only" when every row they have is an untouched seed:
// added_by='seed', not archived, and updated_at IS NULL.
const SEED_ONLY_CTE = `
  seed_only_members AS (
    SELECT m.slug FROM members m
    WHERE NOT EXISTS (
      SELECT 1 FROM shows s
      WHERE s.member_slug = m.slug
        AND (COALESCE(s.added_by, '') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
    )
  )
`;

const COLD_START_THRESHOLD = 15;

async function memberBased(env, member) {
  const { results } = await env.DB.prepare(`
    WITH member_active AS (
      SELECT DISTINCT LOWER(title) AS t FROM shows WHERE member_slug = ? AND archived = 0
    ),
    member_archived AS (
      SELECT DISTINCT LOWER(title) AS t FROM shows WHERE member_slug = ? AND archived = 1
    ),
    member_actor_names AS (
      SELECT DISTINCT a.name FROM actors a
      JOIN shows s ON s.id = a.show_id
      WHERE s.member_slug = ? AND s.archived = 0
    ),
    ${SEED_ONLY_CTE},
    neighbors AS (
      SELECT s.member_slug, COUNT(DISTINCT LOWER(s.title)) AS shared
      FROM shows s
      WHERE s.archived = 0
        AND s.member_slug != ?
        AND s.member_slug NOT IN (SELECT slug FROM seed_only_members)
        AND s.member_slug NOT IN (${EXCLUDED_SQL})
        AND LOWER(s.title) IN (SELECT t FROM member_active)
      GROUP BY s.member_slug
      ORDER BY shared DESC, s.member_slug
      LIMIT 5
    )
    SELECT
      MIN(s.title) AS title,
      COUNT(DISTINCT s.member_slug) AS n_neighbors,
      ROUND(AVG(CAST(s.rating AS REAL)), 1) AS avg_rating,
      GROUP_CONCAT(DISTINCT s.member_slug) AS who_slugs,
      GROUP_CONCAT(DISTINCT s.list) AS list_states,
      (SELECT s2.network FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY
          CASE WHEN INSTR(LOWER(s2.network_url), LOWER(REPLACE(REPLACE(s2.network, ' ', ''), '+', ''))) > 0 THEN 0 ELSE 1 END,
          s2.id
        LIMIT 1) AS network,
      (SELECT s2.network_url FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY
          CASE WHEN INSTR(LOWER(s2.network_url), LOWER(REPLACE(REPLACE(s2.network, ' ', ''), '+', ''))) > 0 THEN 0 ELSE 1 END,
          s2.id
        LIMIT 1) AS network_url,
      (SELECT s2.poster_url FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.poster_url IS NOT NULL
        LIMIT 1) AS poster_url,
      (SELECT COUNT(DISTINCT a.name) FROM actors a
       JOIN shows s2 ON s2.id = a.show_id
       WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
         AND a.name IN (SELECT name FROM member_actor_names)
      ) AS shared_actors
    FROM shows s
    WHERE s.archived = 0
      AND s.member_slug IN (SELECT member_slug FROM neighbors)
      AND LOWER(s.title) NOT IN (SELECT t FROM member_active)
      AND LOWER(s.title) NOT IN (SELECT t FROM member_archived)
    GROUP BY LOWER(s.title)
    ORDER BY n_neighbors DESC, shared_actors DESC, avg_rating DESC, LOWER(s.title)
    LIMIT 20
  `).bind(member, member, member, member).all();

  const { results: pool } = await env.DB.prepare(`
    WITH member_active AS (
      SELECT DISTINCT LOWER(title) AS t FROM shows WHERE member_slug = ? AND archived = 0
    ),
    ${SEED_ONLY_CTE}
    SELECT s.member_slug AS slug, COUNT(DISTINCT LOWER(s.title)) AS shared
    FROM shows s
    WHERE s.archived = 0
      AND s.member_slug != ?
      AND s.member_slug NOT IN (SELECT slug FROM seed_only_members)
      AND LOWER(s.title) IN (SELECT t FROM member_active)
    GROUP BY s.member_slug
    ORDER BY shared DESC, s.member_slug
    LIMIT 5
  `).bind(member, member).all();

  return { candidates: results, neighbor_pool: pool };
}

async function contentBased(env, member) {
  const { results } = await env.DB.prepare(`
    WITH member_active AS (
      SELECT DISTINCT LOWER(title) AS t FROM shows WHERE member_slug = ? AND archived = 0
    ),
    member_archived AS (
      SELECT DISTINCT LOWER(title) AS t FROM shows WHERE member_slug = ? AND archived = 1
    ),
    member_actor_names AS (
      SELECT DISTINCT a.name FROM actors a
      JOIN shows s ON s.id = a.show_id
      WHERE s.member_slug = ? AND s.archived = 0
    ),
    ${SEED_ONLY_CTE}
    SELECT
      MIN(s.title) AS title,
      COUNT(DISTINCT s.member_slug) AS n_neighbors,
      ROUND(AVG(CAST(s.rating AS REAL)), 1) AS avg_rating,
      GROUP_CONCAT(DISTINCT s.member_slug) AS who_slugs,
      GROUP_CONCAT(DISTINCT s.list) AS list_states,
      (SELECT s2.network FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY
          CASE WHEN INSTR(LOWER(s2.network_url), LOWER(REPLACE(REPLACE(s2.network, ' ', ''), '+', ''))) > 0 THEN 0 ELSE 1 END,
          s2.id
        LIMIT 1) AS network,
      (SELECT s2.network_url FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY
          CASE WHEN INSTR(LOWER(s2.network_url), LOWER(REPLACE(REPLACE(s2.network, ' ', ''), '+', ''))) > 0 THEN 0 ELSE 1 END,
          s2.id
        LIMIT 1) AS network_url,
      (SELECT s2.poster_url FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.poster_url IS NOT NULL
        LIMIT 1) AS poster_url,
      (SELECT COUNT(DISTINCT a.name) FROM actors a
       JOIN shows s2 ON s2.id = a.show_id
       WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
         AND a.name IN (SELECT name FROM member_actor_names)
      ) AS shared_actors
    FROM shows s
    WHERE s.archived = 0
      AND s.member_slug != ?
      AND s.member_slug NOT IN (SELECT slug FROM seed_only_members)
      AND LOWER(s.title) NOT IN (SELECT t FROM member_active)
      AND LOWER(s.title) NOT IN (SELECT t FROM member_archived)
    GROUP BY LOWER(s.title)
    HAVING shared_actors > 0
    ORDER BY shared_actors DESC, avg_rating DESC, n_neighbors DESC, LOWER(s.title)
    LIMIT 20
  `).bind(member, member, member, member).all();
  return { candidates: results, neighbor_pool: [] };
}

function diversify(candidates, take, perNetworkCap) {
  const picks = [];
  const networkCount = {};
  for (const c of candidates) {
    if (picks.length >= take) break;
    const net = c.network || '';
    if (net && (networkCount[net] || 0) >= perNetworkCap) continue;
    picks.push(c);
    networkCount[net] = (networkCount[net] || 0) + 1;
  }
  // If the cap blocked us from filling, top up with whatever's left.
  if (picks.length < take) {
    for (const c of candidates) {
      if (picks.length >= take) break;
      if (picks.includes(c)) continue;
      picks.push(c);
    }
  }
  return picks;
}

function buildNameResolver(members) {
  const firstNameCounts = {};
  for (const m of members) {
    const fn = m.first_name || (m.name ? m.name.split(' ')[0] : m.slug);
    firstNameCounts[fn] = (firstNameCounts[fn] || 0) + 1;
  }
  const bySlug = new Map(members.map(m => [m.slug, m]));
  return slug => {
    const m = bySlug.get(slug);
    if (!m) return { slug, name: slug };
    const fn = m.first_name || (m.name ? m.name.split(' ')[0] : slug);
    const name = firstNameCounts[fn] > 1 && m.last_initial ? `${fn} ${m.last_initial}` : fn;
    return { slug, name };
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const member = url.searchParams.get('member');
  if (!member) {
    return new Response(JSON.stringify({ error: 'member required' }), { status: 400, headers: corsHeaders() });
  }

  const memberRow = await env.DB.prepare(
    'SELECT slug, name, first_name, last_initial FROM members WHERE slug = ?'
  ).bind(member).first();
  if (!memberRow) {
    return new Response(JSON.stringify({ error: 'member not found' }), { status: 404, headers: corsHeaders() });
  }

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT LOWER(title)) FROM shows WHERE member_slug = ? AND archived = 0) AS active_count,
      (SELECT EXISTS(
         SELECT 1 FROM shows s
         WHERE s.member_slug = ?
           AND (COALESCE(s.added_by, '') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
       )) AS engaged
  `).bind(member, member).first();

  const isSeedOnly = !stats.engaged;
  const useContent = isSeedOnly || stats.active_count < COLD_START_THRESHOLD;

  const { candidates, neighbor_pool } = useContent
    ? await contentBased(env, member)
    : await memberBased(env, member);

  const picks = diversify(candidates, 3, 2);

  const slugsInPicks = new Set();
  for (const p of picks) {
    if (p.who_slugs) p.who_slugs.split(',').forEach(s => slugsInPicks.add(s));
  }
  for (const n of neighbor_pool) slugsInPicks.add(n.slug);

  const { results: allMembers } = await env.DB.prepare(
    'SELECT slug, name, first_name, last_initial FROM members'
  ).all();
  const resolve = buildNameResolver(allMembers);

  const fn = memberRow.first_name || memberRow.name.split(' ')[0];

  return new Response(JSON.stringify({
    member: memberRow.slug,
    member_name: fn,
    strategy: useContent ? 'content' : 'member',
    cold_start: useContent,
    is_seed_only: isSeedOnly,
    active_count: stats.active_count,
    neighbor_pool: neighbor_pool.map(n => ({ ...resolve(n.slug), shared: n.shared })),
    picks: picks.map(p => ({
      title: p.title,
      network: p.network,
      network_url: p.network_url,
      poster_url: p.poster_url,
      rating: p.avg_rating,
      n_neighbors: p.n_neighbors,
      shared_actors: p.shared_actors,
      list_states: p.list_states ? p.list_states.split(',') : [],
      who: p.who_slugs ? p.who_slugs.split(',').map(resolve) : [],
    })),
  }), { headers: corsHeaders() });
}

import { getSession } from '../../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

async function checkGroupMembership(env, groupId, memberSlug) {
  const membership = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, memberSlug).first();
  return !!membership;
}

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  const isMember = await checkGroupMembership(env, groupId, session.member_slug);
  if (!isMember) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  const group = await env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(groupId).first();
  if (!group) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }

  // Get group members
  const { results: groupMembers } = await env.DB.prepare(
    'SELECT member_slug FROM group_members WHERE group_id = ?'
  ).bind(groupId).all();

  if (groupMembers.length === 0) {
    return new Response(JSON.stringify({ shows: [] }), { headers: corsHeaders() });
  }

  const memberSlugs = groupMembers.map(m => m.member_slug);
  const placeholders = memberSlugs.map(() => '?').join(',');

  // Top shows by how many group members added them in the last 30 days
  const { results } = await env.DB.prepare(
    `SELECT LOWER(s.title) as ltitle, s.title, s.movie,
       MIN(s.id) as id,
       COUNT(DISTINCT s.member_slug) as member_count,
       GROUP_CONCAT(DISTINCT s.member_slug) as member_slugs,
       (SELECT x.poster_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.poster_url IS NOT NULL LIMIT 1) as poster_url,
       (SELECT x.network_logo_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.network_logo_url IS NOT NULL LIMIT 1) as network_logo_url,
       (SELECT x.rating FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.rating IS NOT NULL LIMIT 1) as rating,
       (SELECT x.genres FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.genres IS NOT NULL LIMIT 1) as genres,
       (SELECT x.network FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0 AND x.network IS NOT NULL LIMIT 1) as network,
       (SELECT x.network_url FROM shows x WHERE LOWER(x.title) = LOWER(s.title) AND x.archived = 0
          AND x.network_url IS NOT NULL AND x.network_url NOT LIKE '%/search%' AND x.network_url NOT LIKE '%/s?%'
          AND x.network_url NOT LIKE '%?q=%' AND x.network_url NOT LIKE '%?query=%' LIMIT 1) as network_url
     FROM shows s
     WHERE s.archived = 0
       AND s.member_slug IN (${placeholders})
       AND COALESCE(s.added_by, '') != 'seed'
       AND s.created_at >= datetime('now', '-30 days')
     GROUP BY LOWER(s.title)
     ORDER BY member_count DESC, CAST(rating AS REAL) DESC
     LIMIT 10`
  ).bind(...memberSlugs).all();

  // Pull actors for each show
  for (const show of results) {
    const { results: acts } = await env.DB.prepare(
      'SELECT name, imdb_id FROM actors WHERE show_id = ?'
    ).bind(show.id).all();
    show.actors = acts.length
      ? acts.map(a => ({ name: a.name, imdb_id: a.imdb_id }))
      : null;
  }

  // Map slugs to first names
  const { results: members } = await env.DB.prepare(
    'SELECT slug, first_name, name FROM members WHERE slug IN (' + memberSlugs.map(() => '?').join(',') + ')'
  ).bind(...memberSlugs).all();

  const nameMap = {};
  for (const m of members) {
    nameMap[m.slug] = m.first_name || (m.name || '').split(' ')[0];
  }

  // Add member names to each show
  for (const show of results) {
    show.members = (show.member_slugs || '').split(',').map(s => nameMap[s] || s).sort();
    delete show.member_slugs;
  }

  return new Response(JSON.stringify({ shows: results }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

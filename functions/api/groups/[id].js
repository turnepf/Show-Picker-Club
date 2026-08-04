import { getSession } from '../../_shared/auth.js';

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

  // Same shape as the group list — the apps decode one Group model, and the
  // detail screen gates its Delete action on is_creator.
  const group = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();
  if (!group) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }

  // Get members with their show counts
  const { results: members } = await env.DB.prepare(
    `SELECT m.slug, m.first_name, m.last_name,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0) AS show_count,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0 AND list = 'watching') AS watching_count,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0 AND list = 'awaiting') AS awaiting_count,
            MAX(s.updated_at) AS last_activity_at
     FROM group_members gm
     INNER JOIN members m ON m.slug = gm.member_slug
     LEFT JOIN shows s ON s.member_slug = m.slug
     WHERE gm.group_id = ?
     GROUP BY m.slug
     ORDER BY m.first_name, m.last_name`
  ).bind(groupId).all();

  const isCreator = group.creator_slug === session.member_slug;

  return new Response(JSON.stringify({
    group,
    members,
    is_creator: isCreator,
    can_manage: isCreator
  }), { headers: corsHeaders() });
}

// Rename a group. Creator only — the same bar as deleting it. groups.html has
// been calling this since private groups shipped; the handler never existed,
// so every rename came back 405.
export async function onRequestPatch(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return new Response(JSON.stringify({ error: 'Group name is required' }), { status: 400, headers: corsHeaders() });
  }

  const existing = await env.DB.prepare('SELECT creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }
  if (existing.creator_slug !== session.member_slug) {
    return new Response(JSON.stringify({ error: 'Only the creator can rename a group' }), { status: 403, headers: corsHeaders() });
  }

  await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, groupId).run();

  // Same group shape every other endpoint returns, so clients can swap it in.
  const group = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();

  return new Response(JSON.stringify({ group }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  const group = await env.DB.prepare('SELECT creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  if (!group) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }

  if (group.creator_slug !== session.member_slug) {
    return new Response(JSON.stringify({ error: 'Only the creator can delete a group' }), { status: 403, headers: corsHeaders() });
  }

  await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run();
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

import { getSession } from '../_shared/auth.js';
import { GROUP_ICONS, GROUP_COLORS, readIconField } from '../_shared/group-icons.js';
import { mintInvite } from '../_shared/group-invites.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.name, g.creator_slug, g.created_at, g.icon, g.color,
            (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
            CASE WHEN g.creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups g
     INNER JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.member_slug = ?
     ORDER BY g.name COLLATE NOCASE, g.created_at DESC`
  ).bind(session.member_slug, session.member_slug).all();

  return new Response(JSON.stringify({ groups }), { headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { name } = body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return new Response(JSON.stringify({ error: 'Group name is required' }), { status: 400, headers: corsHeaders() });
  }
  const icon = readIconField(body, 'icon', GROUP_ICONS);
  const color = readIconField(body, 'color', GROUP_COLORS);
  if (!icon.ok || !color.ok) {
    return new Response(JSON.stringify({ error: 'Unknown icon or color' }), { status: 400, headers: corsHeaders() });
  }

  // Create the group
  const result = await env.DB.prepare(
    'INSERT INTO groups (name, creator_slug, icon, color) VALUES (?, ?, ?, ?)'
  ).bind(name.trim(), session.member_slug, icon.present ? icon.value : null, color.present ? color.value : null).run();

  const groupId = result.meta.last_row_id;

  // Add creator as a member
  await env.DB.prepare(
    'INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)'
  ).bind(groupId, session.member_slug).run();

  // Generate first invite link
  const invite = await mintInvite(env, groupId, session.member_slug);

  // Same shape as the group list: the apps decode one Group model, so a
  // freshly created group carries its member_count and is_creator too.
  const group = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at, icon, color,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();
  return new Response(JSON.stringify({ group, invite }), { status: 201, headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

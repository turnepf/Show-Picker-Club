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

export async function onRequestPost(context) {
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

  // Check if this would leave the group empty (reject)
  const { cnt: memberCount } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?'
  ).bind(groupId).first()) || { cnt: 0 };

  if (memberCount <= 1) {
    return new Response(JSON.stringify({ error: 'Cannot leave a group with only one member' }), { status: 400, headers: corsHeaders() });
  }

  await env.DB.prepare(
    'DELETE FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, session.member_slug).run();

  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

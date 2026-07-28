import { getSession } from '../../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 24; i++) {
    token += chars[arr[i] % chars.length];
  }
  return token;
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

  // Generate invite link
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).bind(groupId, token, expiresAt, session.member_slug).run();

  return new Response(JSON.stringify({
    token,
    expires_at: expiresAt,
    url: `https://showpicker.club/groups/join?token=${token}`
  }), { status: 201, headers: corsHeaders() });
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

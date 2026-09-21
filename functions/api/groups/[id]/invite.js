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

// What links are live for this group, so a member can see what is
// outstanding before deciding whether to kill one. Group members only —
// this is the group's own business, and the tokens are the credentials.
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

  if (!await checkGroupMembership(env, groupId, session.member_slug)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  const { results } = await env.DB.prepare(
    `SELECT token, created_by, created_at, expires_at, use_count, max_uses
       FROM group_invites
      WHERE group_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC`
  ).bind(groupId).all();

  return new Response(JSON.stringify({
    invites: (results || []).map(r => ({
      ...r,
      uses_left: Math.max(0, (r.max_uses ?? 0) - (r.use_count ?? 0)),
      url: `https://showpicker.club/groups/join?token=${r.token}`,
    })),
  }), { headers: corsHeaders() });
}

// Kill a link that got somewhere it shouldn't have. Before this existed the
// only way to stop a leaked invite was to delete the group.
//
// The issuer or the group's creator may revoke. Not any member: an invite
// carries the name of the person who vouched, and letting a third member
// cancel it silently is a different power from the one this route is for.
// Delete stays creator-only, as it is everywhere else.
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

  let token = new URL(request.url).searchParams.get('token');
  if (!token) {
    try { token = (await request.json()).token; } catch { /* no body */ }
  }
  if (!token) {
    return new Response(JSON.stringify({ error: 'token required' }), { status: 400, headers: corsHeaders() });
  }

  if (!await checkGroupMembership(env, groupId, session.member_slug)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  const group = await env.DB.prepare('SELECT creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  // Scoped by group_id as well as token, so a member of one group can't
  // revoke another group's invite by pasting its token here.
  const res = await env.DB.prepare(
    `UPDATE group_invites SET revoked_at = datetime('now')
      WHERE token = ? AND group_id = ? AND revoked_at IS NULL
        AND (created_by = ? OR ? = ?)`
  ).bind(token, groupId, session.member_slug, session.member_slug, group?.creator_slug || '').run();

  if (!res.meta || res.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

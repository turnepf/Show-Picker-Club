import { getSession } from '../_shared/auth.js';

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

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.name, g.creator_slug, g.created_at,
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

  // Create the group
  const result = await env.DB.prepare(
    'INSERT INTO groups (name, creator_slug) VALUES (?, ?)'
  ).bind(name.trim(), session.member_slug).run();

  const groupId = result.meta.last_row_id;

  // Add creator as a member
  await env.DB.prepare(
    'INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)'
  ).bind(groupId, session.member_slug).run();

  // Generate first invite link
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO group_invites (group_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)'
  ).bind(groupId, token, expiresAt, session.member_slug).run();

  // Same shape as the group list: the apps decode one Group model, so a
  // freshly created group carries its member_count and is_creator too.
  const group = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();
  return new Response(JSON.stringify({
    group,
    invite: {
      token,
      expires_at: expiresAt,
      url: `https://showpicker.club/groups/join?token=${token}`
    }
  }), { status: 201, headers: corsHeaders() });
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

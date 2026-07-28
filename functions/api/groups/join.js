import { getSession } from '../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'token required' }), { status: 400, headers: corsHeaders() });
  }

  // Lookup the invite
  const invite = await env.DB.prepare(
    `SELECT gi.id, gi.group_id, gi.expires_at, g.name, g.creator_slug
     FROM group_invites gi
     INNER JOIN groups g ON g.id = gi.group_id
     WHERE gi.token = ?`
  ).bind(token).first();

  if (!invite) {
    return new Response(JSON.stringify({ error: 'Invite not found or expired' }), { status: 404, headers: corsHeaders() });
  }

  // Check expiration
  if (new Date(invite.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'Invite expired' }), { status: 410, headers: corsHeaders() });
  }

  // If no session, return preview only
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({
      group: {
        id: invite.group_id,
        name: invite.name
      },
      join_required: true
    }), { headers: corsHeaders() });
  }

  // Session exists; check if already a member
  const existing = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(invite.group_id, session.member_slug).first();

  if (existing) {
    return new Response(JSON.stringify({
      error: 'already_member',
      group_id: invite.group_id
    }), { status: 409, headers: corsHeaders() });
  }

  // Add member to group
  await env.DB.prepare(
    'INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)'
  ).bind(invite.group_id, session.member_slug).run();

  return new Response(JSON.stringify({
    ok: true,
    group_id: invite.group_id,
    group: {
      id: invite.group_id,
      name: invite.name
    }
  }), { headers: corsHeaders() });
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

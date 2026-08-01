import { getSession } from '../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { code } = body;

  if (!code || typeof code !== 'string') {
    return new Response(JSON.stringify({ error: 'Code is required' }), { status: 400, headers: corsHeaders() });
  }

  // Find and validate the invite
  const invite = await env.DB.prepare(
    'SELECT inviter_slug, expires_at FROM household_invites WHERE code = ?'
  ).bind(code).first();

  if (!invite) {
    return new Response(JSON.stringify({ error: 'Invalid or expired code' }), { status: 404, headers: corsHeaders() });
  }

  // Check if expired
  if (new Date(invite.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'Code has expired' }), { status: 410, headers: corsHeaders() });
  }

  // Prevent self-adding
  if (invite.inviter_slug === session.member_slug) {
    return new Response(JSON.stringify({ error: 'Cannot add yourself to household' }), { status: 400, headers: corsHeaders() });
  }

  // Add to inviter's household (caller joins inviter's household)
  await env.DB.prepare(
    'INSERT OR IGNORE INTO household_members (member_slug, other_slug) VALUES (?, ?)'
  ).bind(invite.inviter_slug, session.member_slug).run();

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

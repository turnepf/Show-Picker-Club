import { getSession } from '../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 8; i++) {
    code += chars[arr[i] % chars.length];
  }
  return code;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO household_invites (inviter_slug, code, expires_at) VALUES (?, ?, ?)'
  ).bind(session.member_slug, code, expiresAt).run();

  return new Response(JSON.stringify({
    code,
    expires_at: expiresAt,
    url: `https://showpicker.club/household/join?code=${code}`
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

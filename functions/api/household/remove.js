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
  const { member_slug } = body;

  if (!member_slug || typeof member_slug !== 'string') {
    return new Response(JSON.stringify({ error: 'member_slug is required' }), { status: 400, headers: corsHeaders() });
  }

  // Either side can end it. Take someone out of your household, or take
  // yourself out of theirs — a row somebody else wrote about you is still
  // about you, and joining by invite must not be a door that only opens in.
  await env.DB.prepare(
    `DELETE FROM household_members
      WHERE (member_slug = ?1 AND other_slug = ?2) OR (member_slug = ?2 AND other_slug = ?1)`
  ).bind(session.member_slug, member_slug).run();

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

import { getSession } from '../../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { list } = body;
  const validLists = ['watching', 'waiting', 'recommending', 'next'];
  if (!validLists.includes(list)) {
    return new Response(JSON.stringify({ error: 'Invalid list' }), { status: 400, headers: corsHeaders() });
  }

  await env.DB.prepare(
    "UPDATE shows SET list = ?, updated_at = datetime('now') WHERE id = ? AND member_slug = ?"
  ).bind(list, params.id, session.member_slug).run();

  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

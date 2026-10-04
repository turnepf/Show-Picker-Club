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

  const res = await env.DB.prepare(
    "UPDATE shows SET list = ?, updated_at = datetime('now') WHERE id = ? AND member_slug = ?"
  ).bind(list, params.id, session.member_slug).run();

  // The read-back carries the same owner predicate as the write above, and a
  // write that matched nothing answers 404 instead of falling through to it.
  // Re-reading by id alone returned another member's whole row — notes,
  // watching_with, recommended_by and added_by (their login email) — to any
  // logged-in member who guessed the id, even though the UPDATE changed
  // nothing. A row this session may not write is a row it may not read, and
  // 404 also keeps an unallocated id indistinguishable from a foreign one.
  if (!res.meta || res.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }

  const show = await env.DB.prepare(
    'SELECT * FROM shows_v WHERE id = ? AND member_slug = ?'
  ).bind(params.id, session.member_slug).first();
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

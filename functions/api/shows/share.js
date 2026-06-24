import { getSession } from '../../_shared/auth.js';
import { safeNetworkUrl } from '../../_shared/url-utils.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { show_id, source_member, target_member, recommended_by, notes } = body;

  if (!show_id || !source_member || !target_member) {
    return new Response(JSON.stringify({ error: 'show_id, source_member, and target_member are required' }), { status: 400, headers: corsHeaders() });
  }

  // You can only share FROM your own list. Without this, any logged-in member
  // could copy any other member's show into any third member's list.
  if (source_member !== session.member_slug) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  // Fetch the source show
  const show = await env.DB.prepare(
    'SELECT * FROM shows WHERE id = ? AND member_slug = ?'
  ).bind(show_id, source_member).first();

  if (!show) {
    return new Response(JSON.stringify({ error: 'Show not found' }), { status: 404, headers: corsHeaders() });
  }

  // Check for duplicate in target member
  const existing = await env.DB.prepare(
    'SELECT id, list, archived FROM shows WHERE LOWER(title) = LOWER(?) AND member_slug = ?'
  ).bind(show.title, target_member).first();

  if (existing) {
    if (existing.archived) {
      return new Response(JSON.stringify({ duplicate: true, archived: true }), { headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ duplicate: true, archived: false, list: existing.list }), { headers: corsHeaders() });
  }

  // Insert into target member's "next" list, carrying over all data
  const result = await env.DB.prepare(
    `INSERT INTO shows (title, network, network_url, recommended_by, rating, list, notes, movie, full_series, member_slug, added_by)
     VALUES (?, ?, ?, ?, ?, 'next', ?, ?, ?, ?, ?)`
  ).bind(
    show.title,
    show.network || null,
    safeNetworkUrl(show.network_url),
    recommended_by || null,
    show.rating || null,
    notes || null,
    show.movie || 0,
    show.full_series || 0,
    target_member,
    recommended_by || 'Anonymous'
  ).run();

  // Copy actors too
  const showId = result.meta.last_row_id;
  const { results: actors } = await env.DB.prepare(
    'SELECT name FROM actors WHERE show_id = ?'
  ).bind(show_id).all();

  if (actors.length > 0) {
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name) VALUES (?, ?)');
    await env.DB.batch(actors.map(a => stmt.bind(showId, a.name)));
  }

  return new Response(JSON.stringify({ success: true }), { status: 201, headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

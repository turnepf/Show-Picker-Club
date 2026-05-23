import { fetchEnrichment } from '../../_shared/enrichment.js';
import { getSession } from '../../_shared/auth.js';
import { canonicalNetwork, networkFromUrl } from '../../_shared/networks.js';

function cleanUrl(url) {
  if (!url) return url;
  url = url.split('?')[0];
  if (url.includes('amazon.com/')) url = url.split('ref=')[0];
  return url.replace(/\/+$/, '/');
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}



export async function onRequestGet(context) {
  const { env, params } = context;
  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  if (!show) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }
  return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const existing = await env.DB.prepare('SELECT * FROM shows WHERE id = ? AND member_slug = ?').bind(params.id, session.member_slug).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
  }

  const body = await request.json();
  const val = (key) => body[key] !== undefined ? body[key] : existing[key];
  const title = val('title');
  const network_url = body.network_url !== undefined ? cleanUrl(body.network_url) : existing.network_url;
  // URL trumps the dropdown — if the pasted URL's domain says Netflix, the
  // stored network is Netflix regardless of what the dropdown said. Falls
  // through to alias-folding the dropdown pick when the URL doesn't tell
  // us anything.
  const network = networkFromUrl(network_url) || canonicalNetwork(val('network'));
  const recommended_by = val('recommended_by');
  const list = val('list');
  const notes = val('notes');
  const movie = val('movie');
  const full_series = val('full_series');
  const watching_with = val('watching_with');
  const archived = val('archived');

  const enriched = await fetchEnrichment(title, env, !!movie);
  const rating = enriched.rating || existing.rating;

  await env.DB.prepare(
    "UPDATE shows SET title = ?, network = ?, network_url = ?, recommended_by = ?, list = ?, notes = ?, movie = ?, full_series = ?, watching_with = ?, rating = ?, archived = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(title, network, network_url, recommended_by, list, notes, movie, full_series, watching_with, rating, archived, params.id).run();

  if (enriched.actors.length > 0) {
    await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(params.id).run();
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id) VALUES (?, ?, ?)');
    await env.DB.batch(enriched.actors.map(a => stmt.bind(params.id, a.name, a.imdb_id || null)));
  }

  const show = await env.DB.prepare('SELECT * FROM shows WHERE id = ?').bind(params.id).first();
  return new Response(JSON.stringify({ show }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  await env.DB.prepare('DELETE FROM shows WHERE id = ? AND member_slug = ?').bind(params.id, session.member_slug).run();
  return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

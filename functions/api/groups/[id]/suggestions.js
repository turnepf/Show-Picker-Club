// The group's recommendation board.
//
//   GET  /api/groups/:id/suggestions  — every card, shaped for the viewer
//   POST /api/groups/:id/suggestions  — "Recommend to group": put your own
//                                       copy of a show on the board
//
// Group-mates only, both verbs — the standard group tier, re-checked here
// like every other group route. The real rules live in
// _shared/group-suggestions.js; scripts/group-suggestions-test.mjs pins them.

import { getSession } from '../../../_shared/auth.js';
import { isGroupMember, suggestionsForGroup, createSuggestion } from '../../../_shared/group-suggestions.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

async function gate(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return { response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() }) };
  }
  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return { response: new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() }) };
  }
  if (!(await isGroupMember(env, groupId, session.member_slug))) {
    return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() }) };
  }
  return { session, groupId };
}

export async function onRequestGet(context) {
  const { env } = context;
  const { response, session, groupId } = await gate(context);
  if (response) return response;

  const suggestions = await suggestionsForGroup(env, groupId, session.member_slug);
  return new Response(JSON.stringify({ suggestions }), { headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const { response, session, groupId } = await gate(context);
  if (response) return response;

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const showId = parseInt(body.show_id, 10);
  if (!Number.isInteger(showId)) {
    return new Response(JSON.stringify({ error: 'show_id is required' }), { status: 400, headers: corsHeaders() });
  }
  // The button lives on your own copy — recommending is vouching, and your
  // copy is also the enrichment source every "Add to Next Up" clones.
  const show = await env.DB.prepare(
    'SELECT * FROM shows_v WHERE id = ? AND member_slug = ?'
  ).bind(showId, session.member_slug).first();
  if (!show) {
    return new Response(JSON.stringify({ error: 'Show not found' }), { status: 404, headers: corsHeaders() });
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
  const result = await createSuggestion(env, { groupId, memberSlug: session.member_slug, show, note });
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: corsHeaders() });
  }
  return new Response(JSON.stringify({ suggestion: result.suggestion }), { status: result.status, headers: corsHeaders() });
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

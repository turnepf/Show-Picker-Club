// One card on a group's recommendation board.
//
//   POST   /api/groups/:id/suggestions/:sid  { response: 'dismiss' | 'add' }
//            — answer the pop-up. Dismiss marks it seen for YOU only; Add
//              puts the title on YOUR OWN Next Up (or finds the copy you
//              already have) and records that you're in.
//   DELETE /api/groups/:id/suggestions/:sid
//            — take the card down for everyone. The recommender retracting
//              their own, or the group's creator tidying the board — the same
//              two hands allowed to remove anything else group-owned.
//
// Group-mates only. Logic in _shared/group-suggestions.js.

import { getSession } from '../../../../_shared/auth.js';
import { isGroupMember, respondToSuggestion } from '../../../../_shared/group-suggestions.js';

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
  const suggestionId = parseInt(params.sid, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(suggestionId)) {
    return { response: new Response(JSON.stringify({ error: 'Invalid ID' }), { status: 400, headers: corsHeaders() }) };
  }
  if (!(await isGroupMember(env, groupId, session.member_slug))) {
    return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() }) };
  }
  return { session, groupId, suggestionId };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const { response, session, groupId, suggestionId } = await gate(context);
  if (response) return response;

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const answer = body.response === 'dismiss' ? 'dismissed' : body.response === 'add' ? 'added' : null;
  if (!answer) {
    return new Response(JSON.stringify({ error: "response must be 'dismiss' or 'add'" }), { status: 400, headers: corsHeaders() });
  }

  const result = await respondToSuggestion(env, {
    groupId, suggestionId,
    memberSlug: session.member_slug, memberEmail: session.email,
    response: answer,
  });
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: corsHeaders() });
  }
  return new Response(JSON.stringify({ suggestion: result.suggestion, ...(result.show ? { show: result.show } : {}) }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const { response, session, groupId, suggestionId } = await gate(context);
  if (response) return response;

  const suggestion = await env.DB.prepare(
    'SELECT id, suggested_by FROM group_suggestions WHERE id = ? AND group_id = ?'
  ).bind(suggestionId, groupId).first();
  if (!suggestion) {
    return new Response(JSON.stringify({ error: 'Suggestion not found' }), { status: 404, headers: corsHeaders() });
  }
  const group = await env.DB.prepare('SELECT creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  const allowed = suggestion.suggested_by === session.member_slug || group?.creator_slug === session.member_slug;
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Only the recommender or the group creator can remove this' }), { status: 403, headers: corsHeaders() });
  }

  await env.DB.prepare('DELETE FROM group_suggestions WHERE id = ?').bind(suggestionId).run();
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

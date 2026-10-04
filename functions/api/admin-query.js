import { getConnectorAdminSession } from '../_shared/admin.js';
import { runShowQuery, QueryError } from '../_shared/show-query.js';

// POST /api/admin-query — club-wide questions about shows in one call: counts,
// unique titles, averages, breakdowns by network / year / genre / member, or
// the matching rows themselves. The body is a query spec, never SQL; the
// fields, operators and limits live in _shared/show-query.js.
//
// Admin session, or an admin's AI connection holding the members:admin scope
// (the admin_query tool). The only admin endpoint a connection may reach, and
// it is read-only. Private memos are presence-only and login emails are not a
// field, so it reveals nothing about a library that admin_list_member_shows
// doesn't already show an admin one member at a time. See docs/INVARIANTS.md
// §27.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getConnectorAdminSession(request, env);
  if (!session) return json({ error: 'Forbidden' }, 403);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'The body is a JSON query spec.' }, 400);
  }
  try {
    return json(await runShowQuery(env, body));
  } catch (e) {
    if (e instanceof QueryError) return json({ error: e.message }, 400);
    throw e;
  }
}

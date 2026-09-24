// The AI apps a member has connected through /mcp, and the way to cut one off.
//
//   GET    /api/connected-apps           your live connections, newest use first
//   DELETE /api/connected-apps?id=<n>    revoke one (body {id} works too)
//
// Owner-only in both directions: you see and revoke your own grants and
// nobody else's, and a foreign or unknown id is the same 404. Session-cookie
// only — a connected app can't list or revoke connections, which is what
// keeps "disconnect" something the member does rather than something an AI
// can be talked into. Read by public/connected-apps.html and the iOS/iPad/Mac
// ConnectedAppsView (account menu → Connected Apps…).

import { getSession, isDelegated } from '../_shared/auth.js';
import { revokeGrant, redirectLabel, parseScope } from '../_shared/oauth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function gate(request, env) {
  if (isDelegated(request)) return null;
  const session = await getSession(request, env);
  return session && session.member_slug ? session : null;
}

export async function onRequestGet({ request, env }) {
  const session = await gate(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    `SELECT g.id, g.scope, g.created_at, g.last_used_at, c.client_name, c.redirect_uris
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE g.member_slug = ? AND g.revoked_at IS NULL
      ORDER BY COALESCE(g.last_used_at, g.created_at) DESC`
  ).bind(session.member_slug).all().catch(() => ({ results: [] }));

  return json({
    apps: (results || []).map((r) => {
      let uris = [];
      try { uris = JSON.parse(r.redirect_uris); } catch { /* none */ }
      const scopes = parseScope(r.scope);
      return {
        id: r.id,
        name: r.client_name,
        // Where the app lives, so two entries both called "Claude" can be
        // told apart (and a lookalike spotted).
        host: uris.length ? redirectLabel(uris[0]) : null,
        can_write: scopes.includes('shows:write'),
        connected_at: r.created_at,
        last_used_at: r.last_used_at,
      };
    }),
  });
}

export async function onRequestDelete({ request, env }) {
  const session = await gate(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let id = parseInt(new URL(request.url).searchParams.get('id'), 10);
  if (!Number.isInteger(id)) {
    try { id = parseInt((await request.json()).id, 10); } catch { /* no body */ }
  }
  if (!Number.isInteger(id)) return json({ error: 'id required' }, 400);

  const grant = await env.DB.prepare(
    'SELECT id FROM oauth_grants WHERE id = ? AND member_slug = ? AND revoked_at IS NULL'
  ).bind(id, session.member_slug).first();
  if (!grant) return json({ error: 'Not found' }, 404);
  await revokeGrant(env, grant.id);
  return json({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

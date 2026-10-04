import { getSession, isDelegated, hasDelegatedAdminScope } from './auth.js';

// Admin rights live in the database (members.is_admin, migration 029), not
// in source. Admin tools (member setup, URL cleanup, vibe fill, SMS test,
// watch-URL backfill) are gated to a logged-in session whose member row has
// is_admin = 1, so admins can be added/removed with an UPDATE instead of a
// deploy, and renaming a member can't silently break authorization.

// Returns the session when it belongs to an admin member, else null.
// Use this when the endpoint also needs to know WHICH admin is acting
// (e.g. to stamp reviewed_by).
export async function getAdminSession(request, env) {
  // An AI app acting through /mcp never carries admin rights, even for an
  // admin's own token (docs/INVARIANTS.md §27).
  if (isDelegated(request)) return null;
  const session = await getSession(request, env);
  if (!session || !session.member_slug) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT is_admin FROM members WHERE slug = ?'
    ).bind(session.member_slug).first();
    return row?.is_admin ? session : null;
  } catch (e) {
    // Pre-migration database (no is_admin column yet): fail closed.
    return null;
  }
}

// getAdminSession, plus an AI connection carrying the members:admin scope.
// For read-only admin endpoints that an admin's connection may reach — today
// only /api/admin-query (docs/INVARIANTS.md §27). The admin bit is re-read
// here rather than trusted from the token, so a demotion closes it at once.
export async function getConnectorAdminSession(request, env) {
  if (!isDelegated(request)) return getAdminSession(request, env);
  if (!hasDelegatedAdminScope(request)) return null;
  const session = await getSession(request, env);
  if (!session || !session.member_slug) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT is_admin, COALESCE(disabled, 0) AS disabled FROM members WHERE slug = ?'
    ).bind(session.member_slug).first();
    return row?.is_admin && !row.disabled ? session : null;
  } catch (e) {
    return null;
  }
}

export async function isAdmin(request, env) {
  return !!(await getAdminSession(request, env));
}

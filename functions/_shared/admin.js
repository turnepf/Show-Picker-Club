import { getSession } from './auth.js';

// Admin rights live in the database (members.is_admin, migration 029), not
// in source. Admin tools (member setup, URL cleanup, vibe fill, SMS test,
// watch-URL backfill) are gated to a logged-in session whose member row has
// is_admin = 1, so admins can be added/removed with an UPDATE instead of a
// deploy, and renaming a member can't silently break authorization.

// Returns the session when it belongs to an admin member, else null.
// Use this when the endpoint also needs to know WHICH admin is acting
// (e.g. to stamp reviewed_by).
export async function getAdminSession(request, env) {
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

export async function isAdmin(request, env) {
  return !!(await getAdminSession(request, env));
}

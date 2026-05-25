import { getSession } from './auth.js';

// The single operator slug. Admin tools (member setup, URL cleanup, vibe
// fill, SMS test, watch-URL backfill) are gated to this member's logged-in
// session rather than a separate ADMIN_SECRET — simpler for a single-admin
// app, and it gets stronger automatically once login moves to SMS codes.
export const ADMIN_SLUG = 'patrick';

export async function isAdmin(request, env) {
  const session = await getSession(request, env);
  return !!session && session.member_slug === ADMIN_SLUG;
}

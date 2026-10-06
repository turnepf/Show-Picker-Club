import { platformOf, recordPlatformUsage } from './platform.js';

// Requests the MCP endpoint builds to call an existing handler on a member's
// behalf (functions/mcp.js). The session rides on the Request object itself,
// in a WeakMap nothing outside this module can write, so there is no header
// or cookie a caller on the network could forge to land here. It exists so an
// AI app gets exactly the permissions the member has in the app — every
// handler's own owner/group checks run unchanged — rather than a second copy
// of those rules. See docs/INVARIANTS.md §27.
const delegated = new WeakMap();
// Requests from a connection holding the members:admin scope, built by the
// one tool that may reach an admin endpoint (admin_query). Only
// getConnectorAdminSession() in _shared/admin.js reads this; every other
// admin gate refuses a delegated request outright.
const adminScoped = new WeakSet();

export function actingAs(request, session, { adminScope = false } = {}) {
  delegated.set(request, { ...session, via: 'mcp' });
  if (adminScope) adminScoped.add(request);
  return request;
}

export function hasDelegatedAdminScope(request) {
  return adminScoped.has(request);
}

// The SQL value a show write assigns to updated_at. That column means member
// intent (docs/INVARIANTS.md §5), and an admin fixing a member's row through
// the members:admin tools is neither the member nor intent, so the row keeps
// its timestamp. Only asMember() in mcp-tools.js sets acting_admin, on a
// session that rides the WeakMap above, so nothing on the network can. Adds
// and ratings an admin makes for a member still count: those carry what the
// member told them.
export function updatedAtFor(session) {
  return session && session.acting_admin ? 'updated_at' : "datetime('now')";
}

// True for a request built by actingAs(). Admin gates refuse these: an
// OAuth token is a member's lists, never the operator's tools.
export function isDelegated(request) {
  return delegated.has(request);
}

export async function getSession(request, env) {
  const onBehalf = delegated.get(request);
  if (onBehalf) return onBehalf;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  try {
    // A disabled (banned) member's sessions are refused at the gate, so a
    // ban takes effect immediately even if a session row survives. If the
    // disabled column doesn't exist yet (pre-migration 030), fall back to
    // the plain lookup so logins keep working mid-rollout.
    const withDisabled = env.DB.prepare(
      `SELECT s.email, s.member_slug, s.expires_at
         FROM sessions s
         LEFT JOIN members m ON m.slug = s.member_slug
        WHERE s.id = ? AND COALESCE(m.disabled, 0) = 0`
    ).bind(match[1]);
    const plain = env.DB.prepare(
      'SELECT email, member_slug, expires_at FROM sessions WHERE id = ?'
    ).bind(match[1]);
    const session = await withDisabled.first().catch(() => plain.first());
    if (session && new Date(session.expires_at) > new Date()) {
      // Native apps send this on every request, so this is the reliable
      // catch-all for platform usage -- including watchOS, which relays its
      // session from the phone and never calls /auth/check itself. Not
      // awaited: getSession() gates every authenticated endpoint, and this
      // write is best-effort analytics, not worth blocking every response on.
      const platform = platformOf(request);
      if (platform) recordPlatformUsage(env, session.member_slug, platform);
      return session;
    }
  } catch (e) {}
  return null;
}

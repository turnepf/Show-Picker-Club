import { platformOf, recordPlatformUsage } from './platform.js';

export async function getSession(request, env) {
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

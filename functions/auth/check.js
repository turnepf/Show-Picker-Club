import { platformOf, recordPlatformUsage } from '../_shared/platform.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  const platform = platformOf(request);

  if (!match) {
    return new Response(JSON.stringify({ authenticated: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await env.DB.prepare(
    'SELECT email, member_slug, expires_at FROM sessions WHERE id = ?'
  ).bind(match[1]).first();

  if (!session || new Date(session.expires_at) < new Date()) {
    return new Response(JSON.stringify({ authenticated: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Bump last_seen_at, throttled so we only write once per hour per session.
  // The WHERE clause does the throttling so we never need a read-then-write.
  // When the client tells us its platform, stamp it on the same write;
  // COALESCE keeps the last known platform if a later ping omits the header.
  //
  // The third disjunct is what keeps the throttle from stranding a session in
  // reporting's "Unknown" row. This write is the only writer of
  // sessions.platform *and* the write that makes a session visible to the
  // dashboard, so a header-less check — a bot, an old client, a page that
  // forgot the header — makes the row countable while leaving its platform
  // NULL, and then blocks the header-carrying check behind it for an hour.
  // A session that still has no platform accepts one immediately instead of
  // waiting out that hour. It can only fire while platform IS NULL, so it
  // costs at most one extra write per session, ever.
  context.waitUntil(env.DB.prepare(
    `UPDATE sessions SET last_seen_at = datetime('now'), platform = COALESCE(?2, platform)
     WHERE id = ?1 AND (last_seen_at IS NULL
                        OR last_seen_at < datetime('now', '-1 hour')
                        OR (?2 IS NOT NULL AND platform IS NULL))`
  ).bind(match[1], platform).run().catch(() => {}));
  if (platform) context.waitUntil(recordPlatformUsage(env, session.member_slug, platform));

  // Admin flag comes from the database (members.is_admin), not a hardcoded
  // slug. Fail closed if the column doesn't exist yet (pre-migration).
  const memberRow = await env.DB.prepare(
    'SELECT is_admin FROM members WHERE slug = ?'
  ).bind(session.member_slug).first().catch(() => null);

  // Sliding expiry: a session used inside its 30-day window gets another 30
  // days, so an active member is never logged out for being active. Only
  // slides once a day (the row is already >1 day from a full window), so a
  // chatty client doesn't rewrite the row and the cookie on every launch.
  // Both halves have to move together — the DB row decides whether a request
  // is authorized, the cookie's own Expires decides whether the client still
  // sends it — so the refreshed Set-Cookie rides along on this response.
  const headers = { 'Content-Type': 'application/json' };
  const fullWindowMs = 30 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(session.expires_at);
  if (expiresAt.getTime() - Date.now() < fullWindowMs - 24 * 60 * 60 * 1000) {
    const renewed = new Date(Date.now() + fullWindowMs);
    context.waitUntil(env.DB.prepare(
      'UPDATE sessions SET expires_at = ? WHERE id = ?'
    ).bind(renewed.toISOString(), match[1]).run().catch(() => {}));
    headers['Set-Cookie'] =
      `session=${match[1]}; Path=/; Expires=${renewed.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
  }

  return new Response(JSON.stringify({
    authenticated: true,
    email: session.email,
    member: session.member_slug,
    is_admin: !!memberRow?.is_admin,
  }), { headers });
}

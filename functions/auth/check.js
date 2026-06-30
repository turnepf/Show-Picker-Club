import { ADMIN_SLUG } from '../_shared/admin.js';

// Platform usage tracking. Clients self-identify with X-Client-Platform; we
// only accept a known value so a stray header can't pollute the breakdown.
const KNOWN_PLATFORMS = new Set(['ios', 'tvos', 'web-small', 'web-large']);

function platformOf(request) {
  const p = (request.headers.get('X-Client-Platform') || '').toLowerCase();
  return KNOWN_PLATFORMS.has(p) ? p : null;
}

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
  context.waitUntil(env.DB.prepare(
    `UPDATE sessions SET last_seen_at = datetime('now'), platform = COALESCE(?2, platform)
     WHERE id = ?1 AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour'))`
  ).bind(match[1], platform).run().catch(() => {}));

  return new Response(JSON.stringify({
    authenticated: true,
    email: session.email,
    member: session.member_slug,
    is_admin: session.member_slug === ADMIN_SLUG,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

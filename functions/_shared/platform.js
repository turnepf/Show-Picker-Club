// Platform usage tracking. Clients self-identify with an X-Client-Platform
// header; we only accept a known value so a stray header can't pollute the
// breakdown. iphone/ipad/mac come from the iOS app (device idiom + Mac
// Catalyst detection), tvos/watchos from their respective apps, web-small/
// web-large from the website (split by viewport width — see
// clientPlatformHeader() in public/index.html).
export const KNOWN_PLATFORMS = new Set([
  'iphone', 'ipad', 'mac', 'watchos', 'tvos', 'web-small', 'web-large',
]);

export function platformOf(request) {
  const p = (request.headers.get('X-Client-Platform') || '').toLowerCase();
  return KNOWN_PLATFORMS.has(p) ? p : null;
}

// Durable record that `memberSlug` has used `platform` from, for the Manage
// Members admin page -- unlike sessions.platform, this survives logout,
// disable, and session expiry.
export async function recordPlatformUsage(env, memberSlug, platform) {
  if (!memberSlug || !platform) return;
  try {
    await env.DB.prepare(
      `INSERT INTO member_platforms (member_slug, platform, first_seen_at, last_seen_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(member_slug, platform) DO UPDATE SET last_seen_at = datetime('now')`
    ).bind(memberSlug, platform).run();
  } catch (e) {
    // Pre-migration database or a transient D1 error: never break auth over
    // a usage-tracking write.
  }
}

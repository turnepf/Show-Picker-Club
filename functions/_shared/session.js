// Session issuance, shared by every auth path (email code, SMS code, Apple,
// Google, email enrollment). One place for the cookie shape and the
// disabled-member refusal.

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// `extra` is spread into the success JSON — enrollment paths pass
// { enrolled: true } so the web client can fire its signup conversion event;
// plain logins omit it. Native clients ignore unknown keys.
//
// `authMethod` ('apple' | 'google' | 'email' | 'sms' | 'demo') is stamped on
// the session row so reporting can say which channels members actually use.
// Every caller passes it; it's the last argument so the extra-less callers
// read the same as before.
export async function issueSession(env, memberSlug, extra = {}, authMethod = null) {
  // disabled = banned (migration 030): refuse to mint a session. Falls back
  // to the column-less select mid-rollout.
  const m = await env.DB.prepare(
    'SELECT first_name, name, disabled FROM members WHERE slug = ?'
  ).bind(memberSlug).first().catch(() =>
    env.DB.prepare('SELECT first_name, name FROM members WHERE slug = ?').bind(memberSlug).first()
  );
  if (m?.disabled) {
    return new Response(JSON.stringify({ error: 'account_disabled' }), { status: 403, headers: corsHeaders() });
  }
  const editorName = m?.first_name || m?.name || memberSlug;

  const sessionId = crypto.randomUUID();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Falls back to the column-less insert if the migration hasn't landed yet,
  // the same way the disabled-member read above does — a login must never
  // fail on a schema race.
  await env.DB.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at, auth_method) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(sessionId, editorName, memberSlug, sessionExpires.toISOString(), new Date().toISOString(), authMethod)
    .run()
    .catch(() => env.DB.prepare(
      'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(sessionId, editorName, memberSlug, sessionExpires.toISOString(), new Date().toISOString()).run());

  // Durable login timestamp + method (migrations 013, 059). Best-effort —
  // never break login. Falls back to the timestamp alone pre-migration.
  await env.DB.prepare(
    "UPDATE members SET last_login_at = datetime('now'), last_login_method = ? WHERE slug = ?"
  ).bind(authMethod, memberSlug).run().catch(() =>
    env.DB.prepare("UPDATE members SET last_login_at = datetime('now') WHERE slug = ?")
      .bind(memberSlug).run().catch(() => {})
  );

  return new Response(JSON.stringify({ success: true, slug: memberSlug, ...extra }), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Set-Cookie': `session=${sessionId}; Path=/; Expires=${sessionExpires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

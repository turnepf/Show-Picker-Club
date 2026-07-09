// Session issuance, shared by every auth path (email code, SMS code, Apple,
// Google, email enrollment). One place for the cookie shape and the
// disabled-member refusal.

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function issueSession(env, memberSlug) {
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

  await env.DB.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(sessionId, editorName, memberSlug, sessionExpires.toISOString(), new Date().toISOString()).run();

  // Durable login timestamp (migration 013). Best-effort — never break login.
  await env.DB.prepare("UPDATE members SET last_login_at = datetime('now') WHERE slug = ?")
    .bind(memberSlug).run().catch(() => {});

  return new Response(JSON.stringify({ success: true, slug: memberSlug }), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Set-Cookie': `session=${sessionId}; Path=/; Expires=${sessionExpires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

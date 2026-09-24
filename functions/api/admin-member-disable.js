import { getAdminSession } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// POST { slug, action: 'disable' | 'enable' }
//
// The ban hammer. Disabling a member flips members.disabled (migration 030)
// and deletes every session they hold, so the lockout is immediate — getSession
// refuses disabled members' cookies and login/apple refuse to mint new ones.
// Their rows (shows, contacts) stay put so an enable restores them intact.
export async function onRequestPost(context) {
  const { request, env } = context;
  const adminSession = await getAdminSession(request, env);
  if (!adminSession) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const slug = String(body.slug || '').trim();
  const action = body.action === 'enable' ? 'enable' : body.action === 'disable' ? 'disable' : null;
  if (!slug || !action) return json({ error: 'slug and action (disable|enable) required' }, 400);

  if (slug === adminSession.member_slug) {
    return json({ error: 'cannot_disable_self' }, 400);
  }

  const member = await env.DB.prepare(
    'SELECT slug, is_admin, disabled FROM members WHERE slug = ?'
  ).bind(slug).first();
  if (!member) return json({ error: 'not_found' }, 404);
  // Admins are demoted with an UPDATE first, deliberately — one admin
  // shouldn't be able to lock out another in a single unlogged call.
  if (member.is_admin && action === 'disable') {
    return json({ error: 'cannot_disable_admin' }, 400);
  }

  if (action === 'disable') {
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET disabled = 1 WHERE slug = ?').bind(slug),
      env.DB.prepare('DELETE FROM sessions WHERE member_slug = ?').bind(slug),
    ]);
    // Connected AI apps too (migration 071). Token checks already refuse a
    // disabled member; revoking means re-enabling doesn't quietly bring the
    // connections back.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE member_slug = ?)').bind(slug),
      env.DB.prepare("UPDATE oauth_grants SET revoked_at = datetime('now') WHERE member_slug = ? AND revoked_at IS NULL").bind(slug),
    ]).catch(() => {});
    return json({ ok: true, slug, disabled: true });
  }

  await env.DB.prepare('UPDATE members SET disabled = 0 WHERE slug = ?').bind(slug).run();
  return json({ ok: true, slug, disabled: false });
}

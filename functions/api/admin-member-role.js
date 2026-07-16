import { getAdminSession } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// POST { slug, action: 'promote' | 'demote' }
//
// Admin hand-off. Promote flips members.is_admin on; demote flips it off.
// Guards: the club must always keep at least one admin (so a full hand-off
// is promote-the-other-member first, then demote yourself), and a disabled
// member can't be promoted. Demoting yourself is allowed when another admin
// remains — that's the second half of the hand-off, and what the
// admin_must_demote_first branch of account deletion has always pointed at.
export async function onRequestPost(context) {
  const { request, env } = context;
  const adminSession = await getAdminSession(request, env);
  if (!adminSession) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const slug = String(body.slug || '').trim();
  const action = body.action === 'promote' ? 'promote' : body.action === 'demote' ? 'demote' : null;
  if (!slug || !action) return json({ error: 'slug and action (promote|demote) required' }, 400);

  const member = await env.DB.prepare(
    'SELECT slug, is_admin, disabled FROM members WHERE slug = ?'
  ).bind(slug).first();
  if (!member) return json({ error: 'not_found' }, 404);

  if (action === 'promote') {
    if (member.disabled) return json({ error: 'cannot_promote_disabled' }, 400);
    if (!member.is_admin) {
      await env.DB.prepare('UPDATE members SET is_admin = 1 WHERE slug = ?').bind(slug).run();
    }
    return json({ ok: true, slug, is_admin: true });
  }

  if (member.is_admin) {
    const { n } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM members WHERE is_admin = 1 AND slug != ?'
    ).bind(slug).first();
    if (!n) return json({ error: 'last_admin' }, 400);
    await env.DB.prepare('UPDATE members SET is_admin = 0 WHERE slug = ?').bind(slug).run();
  }
  return json({ ok: true, slug, is_admin: false });
}

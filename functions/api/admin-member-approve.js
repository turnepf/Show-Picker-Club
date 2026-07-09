import { getAdminSession } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// POST { slug, action: 'approve' | 'hold' }
//
// Self-enrolled members start held (members.approved = 0, migration 031):
// full personal use, but hidden from the home roster, vibe pages,
// cross-library search, activity feed, and trending. Approving flips them
// visible; 'hold' reverses it (e.g. a name change that needs another look).
export async function onRequestPost(context) {
  const { request, env } = context;
  const adminSession = await getAdminSession(request, env);
  if (!adminSession) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const slug = String(body.slug || '').trim();
  const action = body.action === 'approve' ? 'approve' : body.action === 'hold' ? 'hold' : null;
  if (!slug || !action) return json({ error: 'slug and action (approve|hold) required' }, 400);

  const member = await env.DB.prepare('SELECT slug FROM members WHERE slug = ?').bind(slug).first();
  if (!member) return json({ error: 'not_found' }, 404);

  await env.DB.prepare('UPDATE members SET approved = ? WHERE slug = ?')
    .bind(action === 'approve' ? 1 : 0, slug).run();
  return json({ ok: true, slug, approved: action === 'approve' });
}

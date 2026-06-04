import { isAdmin, ADMIN_SLUG } from '../_shared/admin.js';
import { createMember } from './admin-create-member.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET — list every request grouped by status. Pending first because that's
// the queue the operator is actually working from.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) return json({ error: 'forbidden' }, 403);

  const { results } = await env.DB.prepare(`
    SELECT id, full_name, email, phone, source, status,
           created_at, reviewed_at, reviewed_by, notes
      FROM signup_requests
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       created_at DESC
  `).all();
  return json({ requests: results || [] });
}

// POST — actions on a request:
//   { id, action: 'approve' }              → run create-member, mark approved
//   { id, action: 'reject', notes: '...' } → mark rejected
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'missing_id' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, full_name, email, phone, status FROM signup_requests WHERE id = ?'
  ).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);
  if (row.status !== 'pending') {
    return json({ error: `Already ${row.status}` }, 409);
  }

  if (body.action === 'approve') {
    const created = await createMember(env, {
      full_name: row.full_name,
      phone: row.phone,
      emails: row.email,
    });
    if (!created.ok) {
      return json({ error: created.error }, created.status || 400);
    }
    await env.DB.prepare(
      `UPDATE signup_requests
          SET status = 'approved',
              reviewed_at = datetime('now'),
              reviewed_by = ?
        WHERE id = ?`
    ).bind(ADMIN_SLUG, id).run();
    return json({ ok: true, action: 'approve', created });
  }

  if (body.action === 'reject') {
    const notes = String(body.notes || '').trim() || null;
    await env.DB.prepare(
      `UPDATE signup_requests
          SET status = 'rejected',
              reviewed_at = datetime('now'),
              reviewed_by = ?,
              notes = ?
        WHERE id = ?`
    ).bind(ADMIN_SLUG, notes, id).run();
    return json({ ok: true, action: 'reject' });
  }

  return json({ error: 'unknown_action' }, 400);
}

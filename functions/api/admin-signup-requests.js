import { isAdmin, getAdminSession } from '../_shared/admin.js';
import { createMember } from './admin-create-member.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET — list every request grouped by status. Pending first because that's
// the queue the operator is actually working from. Hidden rows (operator
// dismissed a processed request, migration 035) never leave the server, so
// every client's queue empties out without its own filtering. Column-less
// retry keeps the page working mid-rollout.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) return json({ error: 'forbidden' }, 403);

  const query = (withHidden) => env.DB.prepare(`
    SELECT id, full_name, email, phone, source, status,
           created_at, reviewed_at, reviewed_by, notes,
           created_member_slug
      FROM signup_requests
     ${withHidden ? 'WHERE hidden_at IS NULL' : ''}
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       created_at DESC
  `).all();
  const { results } = await query(true).catch(() => query(false));
  return json({ requests: results || [] });
}

// POST — actions on a request:
//   { id, action: 'approve' }              → run create-member, mark approved
//   { id, action: 'reject', notes: '...' } → mark rejected
//   { id, action: 'hide' }                 → dismiss a processed row from the queue
export async function onRequestPost(context) {
  const { request, env } = context;
  // reviewed_by stamps the acting admin's slug, so we need the session, not
  // just a yes/no.
  const adminSession = await getAdminSession(request, env);
  if (!adminSession) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'missing_id' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, full_name, email, phone, status FROM signup_requests WHERE id = ?'
  ).bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404);
  // Allow approve on pending OR rejected — operator may change their mind.
  // Reject only makes sense from pending.
  if (body.action === 'reject' && row.status !== 'pending') {
    return json({ error: `Already ${row.status}` }, 409);
  }
  if (body.action === 'approve' && row.status === 'approved') {
    return json({ error: 'Already approved' }, 409);
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
              reviewed_by = ?,
              created_member_slug = ?
        WHERE id = ?`
    ).bind(adminSession.member_slug, created.slug, id).run();
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
    ).bind(adminSession.member_slug, notes, id).run();
    return json({ ok: true, action: 'reject' });
  }

  if (body.action === 'hide') {
    // Only processed rows can be dismissed — a pending request still needs
    // a decision, so hiding it would silently lose someone's signup.
    if (row.status === 'pending') {
      return json({ error: 'Decide on it first — approve or reject, then hide' }, 409);
    }
    await env.DB.prepare(
      "UPDATE signup_requests SET hidden_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
    return json({ ok: true, action: 'hide' });
  }

  return json({ error: 'unknown_action' }, 400);
}

import { getSession } from '../../_shared/auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LISTS = new Set(['watching', 'waiting', 'recommending', 'next']);

// Persist a member's manual drag-order for one list ("My order" sort).
// Body: { list, ids: [showId, ...] } in the desired top-to-bottom order.
// Each row gets sort_order = its position. Scoped hard to the session
// member's own active rows on that list, so stray or malicious ids are
// ignored rather than reordering someone else's library.
//
// Deliberately does NOT bump updated_at: reordering is presentation, not a
// content edit, and bumping would mark the whole list "active" in the
// reporting rollups (updated_at is how member intent is distinguished —
// see docs/ARCHITECTURE.md "Conventions").
export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session || !session.member_slug) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const list = String(body.list || '');
  if (!LISTS.has(list)) return json({ error: 'invalid list' }, 400);

  const ids = Array.isArray(body.ids) ? body.ids.map(n => parseInt(n, 10)) : [];
  if (!ids.length || ids.some(n => !Number.isInteger(n))) {
    return json({ error: 'ids required' }, 400);
  }
  if (ids.length > 500) return json({ error: 'too many ids' }, 400);

  const stmt = env.DB.prepare(
    'UPDATE shows SET sort_order = ? WHERE id = ? AND member_slug = ? AND list = ? AND archived = 0'
  );
  const results = await env.DB.batch(
    ids.map((id, pos) => stmt.bind(pos, id, session.member_slug, list))
  );
  const updated = results.reduce((n, r) => n + (r.meta?.changes || 0), 0);

  return json({ ok: true, updated });
}

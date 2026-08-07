// The member's own passkeys. Session required, and scoped to the session's
// member — there is no way to ask about anybody else's.
//
// Public keys are not returned. They aren't secret, but nothing in the UI
// needs them and a list endpoint should hand back what it's for.

import { getSession } from '../_shared/auth.js';
import { json } from '../_shared/passkeys.js';

export async function onRequestGet({ env, request }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    `SELECT credential_id, label, created_at, last_used_at
       FROM member_passkeys
      WHERE member_slug = ?
      ORDER BY created_at DESC`
  ).bind(session.member_slug).all().catch(() => ({ results: [] }));

  return json({ passkeys: results || [] });
}

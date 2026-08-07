// Remove one of the member's own passkeys — a lost phone, or a device they no
// longer want holding a key to the account.
//
// The WHERE clause carries member_slug as well as the credential id, so a
// guessed or harvested credential id from another account matches nothing.
// Removing every passkey is allowed: a passkey is always an addition to the
// account's original sign-in method (Apple, Google or an email code), never
// the only way in, so this can't lock anybody out.

import { getSession } from '../../_shared/auth.js';
import { json } from '../../_shared/passkeys.js';

export async function onRequestDelete({ env, request, params }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const credentialId = decodeURIComponent(params.id || '');
  if (!credentialId) return json({ error: 'missing_id' }, 400);

  const result = await env.DB.prepare(
    'DELETE FROM member_passkeys WHERE credential_id = ? AND member_slug = ?'
  ).bind(credentialId, session.member_slug).run();

  if (!result?.meta?.changes) return json({ error: 'not_found' }, 404);
  return json({ deleted: true });
}

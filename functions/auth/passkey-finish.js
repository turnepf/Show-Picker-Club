// Step 2 of signing in with a passkey: verify the assertion and issue the
// session.
//
// The credential id resolves the member — not the user handle the client
// sends, which is attacker-controlled on the wire. The signature has to check
// out against the public key we stored for that credential, so possession of
// the private key is what proves who this is.
//
// A passkey never creates an account. An unrecognized credential is simply
// refused; enrollment stays with Apple/Google/email, and a passkey is added
// afterwards from inside a signed-in session.

import { issueSession } from '../_shared/session.js';
import { consumeChallenge, rpId, allowedOrigins, json, corsHeaders } from '../_shared/passkeys.js';
import { verifyAssertion } from '../_shared/webauthn.js';

const MAX_FAILS = 10;
const WINDOW_MIN = 15;

async function failureCount(env, ip) {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first().catch(() => ({ cnt: 0 }));
  return row?.cnt || 0;
}

async function recordFailure(env, ip, member) {
  await env.DB.prepare(
    'INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, ?, ?)'
  ).bind(ip, member || null, new Date().toISOString()).run().catch(() => {});
}

export async function onRequestPost({ env, request }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (await failureCount(env, ip) >= MAX_FAILS) {
    return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(WINDOW_MIN * 60) });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid_body' }, 400);
  }

  const {
    challenge,
    credential_id: credentialId,
    authenticator_data: authenticatorData,
    client_data_json: clientDataJSON,
    signature,
  } = body;
  if (!challenge || !credentialId || !authenticatorData || !clientDataJSON || !signature) {
    return json({ error: 'missing_fields' }, 400);
  }

  const stored = await consumeChallenge(env, challenge, 'authenticate');
  if (!stored) {
    await recordFailure(env, ip, null);
    return json({ error: 'challenge_expired' }, 400);
  }

  const credential = await env.DB.prepare(
    `SELECT p.credential_id, p.member_slug, p.public_key, p.sign_count
       FROM member_passkeys p
       JOIN members m ON m.slug = p.member_slug
      WHERE p.credential_id = ? AND COALESCE(m.disabled, 0) = 0`
  ).bind(credentialId).first().catch(() => null);
  if (!credential) {
    await recordFailure(env, ip, null);
    return json({ error: 'unrecognized' }, 401);
  }

  let result;
  try {
    result = await verifyAssertion({
      authenticatorData,
      clientDataJSON,
      signature,
      publicKey: credential.public_key,
      // The stored value, not the echoed one — see passkey-register-finish.
      expectedChallenge: stored.challenge,
      rpId: rpId(env),
      allowedOrigins: allowedOrigins(env),
      storedSignCount: credential.sign_count || 0,
    });
  } catch (e) {
    await recordFailure(env, ip, credential.member_slug);
    return json({ error: 'verification_failed' }, 401);
  }

  // Best-effort: a failed bookkeeping write must not cost a valid sign-in.
  await env.DB.prepare(
    'UPDATE member_passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?'
  ).bind(result.signCount, new Date().toISOString(), credentialId).run().catch(() => {});

  return await issueSession(env, credential.member_slug, {}, 'passkey');
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      ...corsHeaders(),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

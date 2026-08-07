// Step 2 of adding a passkey: verify what the authenticator produced and
// store the public key against the member.
//
// Session required, and the challenge must be the one minted for this same
// member in passkey-register-begin — so a credential can only ever be
// attached to the account that asked for it.

import { getSession } from '../_shared/auth.js';
import { consumeChallenge, rpId, allowedOrigins, cleanLabel, json, corsHeaders } from '../_shared/passkeys.js';
import { verifyRegistration } from '../_shared/webauthn.js';

// How many passkeys one member may keep. High enough for every device a
// person owns plus a hardware key, low enough that a loop can't fill the
// table on our dime.
const MAX_PASSKEYS_PER_MEMBER = 10;

export async function onRequestPost({ env, request }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const slug = session.member_slug;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid_body' }, 400);
  }

  const { challenge, attestation_object: attestationObject, client_data_json: clientDataJSON } = body;
  if (!challenge || !attestationObject || !clientDataJSON) {
    return json({ error: 'missing_fields' }, 400);
  }

  const stored = await consumeChallenge(env, challenge, 'register', slug);
  if (!stored) return json({ error: 'challenge_expired' }, 400);

  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM member_passkeys WHERE member_slug = ?'
  ).bind(slug).first().catch(() => ({ cnt: 0 }))) || { cnt: 0 };
  if (cnt >= MAX_PASSKEYS_PER_MEMBER) return json({ error: 'too_many_passkeys' }, 409);

  let credential;
  try {
    credential = await verifyRegistration({
      attestationObject,
      clientDataJSON,
      // The stored value, not the echoed one. They're equal — the lookup was
      // by exact match — but comparing against what we minted is the thing
      // that's obviously right, and stays right if the lookup ever loosens.
      expectedChallenge: stored.challenge,
      rpId: rpId(env),
      allowedOrigins: allowedOrigins(env),
    });
  } catch (e) {
    // The reason is deliberately not echoed back: a failure here is either a
    // bug in our client or somebody probing, and neither is helped by a
    // precise description of which check failed.
    return json({ error: 'verification_failed' }, 400);
  }

  // A credential id is globally unique, so a collision means this passkey is
  // already registered — to this member (harmless, refresh it) or to another
  // (refuse; re-pointing an existing credential at a new account would be an
  // account-takeover primitive).
  const owner = await env.DB.prepare(
    'SELECT member_slug FROM member_passkeys WHERE credential_id = ?'
  ).bind(credential.credentialId).first().catch(() => null);
  if (owner && owner.member_slug !== slug) return json({ error: 'credential_in_use' }, 409);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO member_passkeys
       (credential_id, member_slug, public_key, sign_count, aaguid, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET
       public_key = excluded.public_key,
       sign_count = excluded.sign_count,
       label = excluded.label`
  ).bind(
    credential.credentialId,
    slug,
    credential.publicKey,
    credential.signCount,
    credential.aaguid,
    cleanLabel(body.label),
    now
  ).run();

  return json({ success: true, credential_id: credential.credentialId });
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

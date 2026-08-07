// Step 1 of adding a passkey: hand the already-signed-in member a challenge
// and the parameters their device needs to create a credential.
//
// Registration requires a session by design — a passkey is added to an
// account that already exists, by someone who has already proved they own it.
// The passkey then becomes a way back in; it is never the thing that creates
// the account.

import { getSession } from '../_shared/auth.js';
import {
  RP_NAME, rpId, createChallenge, json, corsHeaders,
} from '../_shared/passkeys.js';
import { bytesToB64url } from '../_shared/webauthn.js';

export async function onRequestPost({ env, request }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const slug = session.member_slug;
  const member = await env.DB.prepare(
    'SELECT slug, name, first_name FROM members WHERE slug = ?'
  ).bind(slug).first();
  if (!member) return json({ error: 'Unauthorized' }, 401);

  // Credentials this member already has. Passing them as excludeCredentials
  // makes the authenticator refuse to enroll the same device twice, so a
  // member who taps "Add a passkey" again gets "you already have one here"
  // from the OS instead of a duplicate row.
  const existing = await env.DB.prepare(
    'SELECT credential_id FROM member_passkeys WHERE member_slug = ?'
  ).bind(slug).all().catch(() => ({ results: [] }));

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const challenge = await createChallenge(env, 'register', slug, ip);
  if (!challenge) return json({ error: 'rate_limited' }, 429);

  return json({
    challenge,
    rp: { id: rpId(env), name: RP_NAME },
    user: {
      // The user handle is the member slug: stable, already the app's
      // identifier for a person, and not a secret. It comes back on an
      // assertion, though credential_id is what we actually resolve against.
      id: bytesToB64url(new TextEncoder().encode(slug)),
      name: member.slug,
      displayName: member.first_name || member.name || member.slug,
    },
    // ES256 first (what Apple's platform authenticator uses), RS256 as the
    // fallback a hardware key might need.
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    excludeCredentials: (existing.results || []).map((r) => ({
      type: 'public-key',
      id: r.credential_id,
    })),
    authenticatorSelection: {
      // Discoverable so signing in needs no email address first — the whole
      // point is that the member taps once and Face ID does the rest.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    timeout: 120000,
  });
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

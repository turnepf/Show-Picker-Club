// Step 1 of signing in with a passkey: hand out a challenge.
//
// No session, and — deliberately — no identifier either. The credentials are
// discoverable, so the device already knows which passkeys it holds for this
// relying party; asking for an email first would leak whether an address is a
// member and buy nothing. That means this response is the same for everyone
// and reveals nothing.

import { createChallenge, rpId, json, corsHeaders } from '../_shared/passkeys.js';

export async function onRequestPost({ env, request }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const challenge = await createChallenge(env, 'authenticate', null, ip);
  if (!challenge) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '300' });

  return json({
    challenge,
    rpId: rpId(env),
    userVerification: 'required',
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

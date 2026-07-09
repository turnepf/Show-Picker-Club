// Public, non-secret auth configuration for the login/signup UI: which
// buttons to render and which public keys to hand the widgets. Everything
// here is safe to expose — site keys and OAuth client ids are public by
// design; the corresponding secrets never appear.

import { selfEnrollEnabled } from '../_shared/enroll.js';

export async function onRequestGet(context) {
  const { env } = context;
  const googleClientIds = (env.GOOGLE_CLIENT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return new Response(JSON.stringify({
    self_enroll: selfEnrollEnabled(env),
    // The web GIS widget wants exactly one client id — first configured wins.
    google_client_id: googleClientIds[0] || null,
    turnstile_site_key: (env.TURNSTILE_SITE_KEY || '').trim() || null,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

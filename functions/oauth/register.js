// POST /oauth/register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
//
// How an AI app introduces itself before a member has done anything: Claude
// registers the first time someone pastes the club's MCP URL, receives a
// client_id, and only then sends the member to /oauth/authorize. It is
// unauthenticated by design — there is no developer portal to hand out ids —
// so a registration grants nothing on its own. It names a client and the
// places its codes may be delivered, and a member still has to sign in and
// say yes. What's bounded here is the part an anonymous caller controls:
// redirect URIs must be ones a browser won't execute, and one address can
// only register so many clients an hour.

import {
  acceptableRedirectUri, randomToken, sha256Hex, oauthJson, oauthError, preflight,
  REGISTRATIONS_PER_IP_PER_HOUR,
} from '../_shared/oauth.js';

const AUTH_METHODS = new Set(['none', 'client_secret_post', 'client_secret_basic']);

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return oauthError('invalid_client_metadata', 'Body must be JSON'); }
  if (!body || typeof body !== 'object') return oauthError('invalid_client_metadata', 'Body must be a JSON object');

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!uris.length || uris.length > 10) {
    return oauthError('invalid_redirect_uri', 'Between one and ten redirect_uris are required');
  }
  const bad = uris.find((u) => u.length > 500 || !acceptableRedirectUri(u));
  if (bad) return oauthError('invalid_redirect_uri', `Redirect URI not allowed: ${bad.slice(0, 100)}`);

  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
  if (!grantTypes.includes('authorization_code')) {
    return oauthError('invalid_client_metadata', 'authorization_code is the only supported flow');
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code'];
  if (responseTypes.some((t) => t !== 'code')) {
    return oauthError('invalid_client_metadata', "Only response_type 'code' is supported");
  }
  const authMethod = body.token_endpoint_auth_method || 'none';
  if (!AUTH_METHODS.has(authMethod)) {
    return oauthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${String(authMethod).slice(0, 40)}`);
  }

  // Self-declared and shown on the consent screen, so it is length-bounded,
  // stripped of control characters and escaped where it's rendered.
  const name = String(body.client_name || 'An AI app').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'An AI app';

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { cnt } = (await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM oauth_clients WHERE registered_ip = ? AND created_at > datetime('now', '-1 hour')"
  ).bind(ip).first()) || { cnt: 0 };
  if (cnt >= REGISTRATIONS_PER_IP_PER_HOUR) {
    return oauthError('slow_down', 'Too many registrations from this address. Try again later.', 429);
  }

  const clientId = `spc_${randomToken(16)}`;
  const secret = authMethod === 'none' ? null : randomToken(32);
  await env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, registered_ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(clientId, secret ? await sha256Hex(secret) : null, name, JSON.stringify(uris), authMethod, ip).run();

  return oauthJson({
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
  }, 201);
}

export const onRequestOptions = () => preflight('POST');

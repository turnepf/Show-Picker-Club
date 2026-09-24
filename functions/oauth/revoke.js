// POST /oauth/revoke — token revocation (RFC 7009), for an app disconnecting
// itself. Either token kills the whole grant: a member who removes the
// connector in their AI app expects it gone, not merely one token shorter.
// Always 200 for a well-formed request, whether or not the token existed, so
// the endpoint can't be used to test tokens.

import { authenticateClient, sha256Hex, revokeGrant, oauthError, oauthJson, preflight, readParams } from '../_shared/oauth.js';

export async function onRequestPost({ request, env }) {
  const params = await readParams(request);
  const client = await authenticateClient(request, params, env);
  if (!client) return oauthError('invalid_client', 'Unknown client or bad credentials', 401);
  const token = params.get('token') || '';
  if (!token) return oauthError('invalid_request', 'token is required');

  const row = await env.DB.prepare(
    `SELECT t.grant_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ? AND g.client_id = ?`
  ).bind(await sha256Hex(token), client.client_id).first();
  if (row) await revokeGrant(env, row.grant_id);
  return oauthJson({});
}

export const onRequestOptions = () => preflight('POST');

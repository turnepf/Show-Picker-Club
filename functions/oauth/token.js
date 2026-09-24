// POST /oauth/token — trade an authorization code, or a refresh token, for
// tokens (RFC 6749 §4.1.3 and §6, OAuth 2.1 rules).
//
//   authorization_code  single use, ten minutes, PKCE S256, same client and
//                       redirect_uri as the authorization request. A code
//                       presented twice is treated as stolen: the grant it
//                       minted is revoked (RFC 6749 §4.1.2).
//   refresh_token       rotated on every use. Presenting a refresh token that
//                       was already rotated means two parties hold it, so the
//                       whole grant is revoked rather than guessing which of
//                       them is the member (OAuth 2.1 §6.1).
//
// One grant per member per client: reconnecting the same app replaces its
// scope rather than stacking a second entry on the Connected apps screen.

import {
  authenticateClient, pkceMatches, sha256Hex, issueTokens, revokeGrant, parseScope,
  scopeString, oauthError, oauthJson, preflight, readParams, pruneExpired,
} from '../_shared/oauth.js';

async function fromCode(env, client, params) {
  const code = params.get('code') || '';
  if (!code) return oauthError('invalid_request', 'code is required');
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare(
    `SELECT code_hash, client_id, member_slug, redirect_uri, code_challenge, scope, used_at, grant_id,
            (datetime(expires_at) > datetime('now')) AS live
       FROM oauth_codes WHERE code_hash = ?`
  ).bind(hash).first();
  if (!row || row.client_id !== client.client_id) return oauthError('invalid_grant', 'Unknown code');
  if (row.used_at) {
    if (row.grant_id) await revokeGrant(env, row.grant_id);
    return oauthError('invalid_grant', 'Code already used');
  }
  if (!row.live) return oauthError('invalid_grant', 'Code expired');
  if ((params.get('redirect_uri') || row.redirect_uri) !== row.redirect_uri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!(await pkceMatches(params.get('code_verifier'), row.code_challenge))) {
    return oauthError('invalid_grant', 'PKCE verification failed');
  }

  // Claim the code before minting anything, so two concurrent redemptions
  // can't both succeed.
  const claim = await env.DB.prepare(
    "UPDATE oauth_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL"
  ).bind(hash).run();
  if (!claim.meta || claim.meta.changes === 0) return oauthError('invalid_grant', 'Code already used');

  const member = await env.DB.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM members WHERE slug = ?')
    .bind(row.member_slug).first();
  if (!member || member.disabled) return oauthError('invalid_grant', 'Account unavailable');

  let grant = await env.DB.prepare(
    'SELECT id FROM oauth_grants WHERE member_slug = ? AND client_id = ? AND revoked_at IS NULL'
  ).bind(row.member_slug, client.client_id).first();
  if (grant) {
    await env.DB.prepare("UPDATE oauth_grants SET scope = ?, last_used_at = datetime('now') WHERE id = ?")
      .bind(row.scope, grant.id).run();
  } else {
    const res = await env.DB.prepare(
      "INSERT INTO oauth_grants (member_slug, client_id, scope, last_used_at) VALUES (?, ?, ?, datetime('now'))"
    ).bind(row.member_slug, client.client_id, row.scope).run();
    grant = { id: res.meta.last_row_id };
  }
  await env.DB.prepare('UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?').bind(grant.id, hash).run();
  return oauthJson(await issueTokens(env, grant.id, row.scope));
}

async function fromRefresh(env, client, params) {
  const token = params.get('refresh_token') || '';
  if (!token) return oauthError('invalid_request', 'refresh_token is required');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT t.grant_id, t.rotated_at, (datetime(t.expires_at) > datetime('now')) AS live,
            g.client_id, g.scope, g.revoked_at, COALESCE(m.disabled, 0) AS disabled
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN members m ON m.slug = g.member_slug
      WHERE t.token_hash = ? AND t.kind = 'refresh'`
  ).bind(hash).first();
  if (!row || row.client_id !== client.client_id || row.revoked_at || row.disabled) {
    return oauthError('invalid_grant', 'Unknown refresh token');
  }
  if (row.rotated_at) {
    await revokeGrant(env, row.grant_id);
    return oauthError('invalid_grant', 'Refresh token reused; the connection has been revoked');
  }
  if (!row.live) return oauthError('invalid_grant', 'Refresh token expired');

  const claim = await env.DB.prepare(
    "UPDATE oauth_tokens SET rotated_at = datetime('now') WHERE token_hash = ? AND rotated_at IS NULL"
  ).bind(hash).run();
  if (!claim.meta || claim.meta.changes === 0) {
    await revokeGrant(env, row.grant_id);
    return oauthError('invalid_grant', 'Refresh token reused; the connection has been revoked');
  }
  // A refresh may narrow the scope, never widen it.
  const held = parseScope(row.scope);
  const asked = params.get('scope') ? parseScope(params.get('scope')).filter((s) => held.includes(s)) : held;
  await env.DB.prepare("UPDATE oauth_grants SET last_used_at = datetime('now') WHERE id = ?").bind(row.grant_id).run();
  return oauthJson(await issueTokens(env, row.grant_id, scopeString(asked)));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const params = await readParams(request);
  const client = await authenticateClient(request, params, env);
  if (!client) return oauthError('invalid_client', 'Unknown client or bad credentials', 401);

  context.waitUntil?.(pruneExpired(env));
  const type = params.get('grant_type');
  if (type === 'authorization_code') return fromCode(env, client, params);
  if (type === 'refresh_token') return fromRefresh(env, client, params);
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

export const onRequestOptions = () => preflight('POST');

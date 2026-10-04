// The club's OAuth 2.1 authorization server, shared by /oauth/* and /mcp.
//
// An AI app reaches a member's lists through /mcp, and remote MCP clients
// authenticate with OAuth: the app registers itself (RFC 7591), sends the
// member to /oauth/authorize to sign in and consent, trades the code for
// tokens at /oauth/token (PKCE, S256 only), and presents the access token as
// a Bearer header. Tokens are opaque random strings; only their SHA-256 is
// stored, so a database snapshot holds nothing that can call the API.
//
// The rules that keep this narrow are pinned by scripts/mcp-test.mjs and
// written down in docs/INVARIANTS.md §27.

// members:admin is the operator's: an admin who ticks it on the consent
// screen lets the connection list every member and add, rate and archive
// shows on their lists. It is never ticked by default, never granted to a
// member who isn't an admin, and dropped from a live token the moment its
// member stops being one (authenticateBearer). See docs/INVARIANTS.md §27.
export const SCOPES = ['shows:read', 'shows:write', 'members:admin'];
export const SCOPE_LABELS = {
  'shows:read': 'See your lists, notes and groups',
  'shows:write': 'Add, edit, move and remove shows, and act in your groups',
  'members:admin': 'See every member, and add, rate and archive shows on their lists. Admins only',
};

export const ACCESS_TTL_SECONDS = 60 * 60;
// Idle lifetime: every refresh mints a new refresh token with a fresh 90
// days, so a connection used at least once a quarter never has to sign in
// again, and one left alone dies on its own.
export const REFRESH_TTL_DAYS = 90;
export const CODE_TTL_MINUTES = 10;
// Dynamic registration is unauthenticated by design (that is how Claude
// connects without a developer portal), so it is capped per source address.
export const REGISTRATIONS_PER_IP_PER_HOUR = 20;

export function issuerFor(request) {
  return new URL(request.url).origin;
}

export function resourceFor(request) {
  return `${issuerFor(request)}/mcp`;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge.
export async function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest)) === challenge;
}

// A requested scope string, narrowed to what exists. An empty or absent
// request means everything the club offers — that is what clients send when
// they don't know the scopes, and the consent screen still lets the member
// grant read-only. Read is implied by write: nothing can edit a list it
// cannot see.
export function parseScope(raw) {
  const asked = String(raw || '').split(/\s+/).filter(Boolean);
  const known = asked.filter((s) => SCOPES.includes(s));
  const set = new Set(known.length ? known : SCOPES);
  set.add('shows:read');
  return SCOPES.filter((s) => set.has(s));
}

export const scopeString = (list) => SCOPES.filter((s) => list.includes(s)).join(' ');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);

// What a client may register as a redirect: https anywhere, plain http only
// to the member's own machine (a desktop client listening on a loopback port,
// RFC 8252 §7.3), or an app's own private-use scheme (RFC 8252 §7.1). Never a
// fragment, and never a scheme a browser would execute.
export function acceptableRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

// Exact string match against what the client registered, with the single
// exception RFC 8252 §7.3 requires: a loopback redirect may arrive on any
// port, because a desktop client picks a free one at runtime.
export function redirectMatches(registered, uri) {
  if (registered.includes(uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return false;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && v.hostname === u.hostname &&
        v.pathname === u.pathname && v.search === u.search;
    } catch { return false; }
  });
}

// The host a redirect lands on, for the consent screen. A client's name is
// whatever it chose to call itself at registration; where the code goes is
// the part a member can actually check.
export function redirectLabel(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return u.hostname;
    if (u.protocol === 'http:') return 'an app on this computer';
    return `the ${u.protocol.replace(/:$/, '')} app`;
  } catch { return 'an unknown destination'; }
}

export async function getClient(env, clientId) {
  if (!clientId || typeof clientId !== 'string') return null;
  const row = await env.DB.prepare(
    'SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?'
  ).bind(clientId).first();
  if (!row) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris); } catch { /* corrupt row: no redirects */ }
  return { ...row, redirect_uris: Array.isArray(uris) ? uris : [] };
}

// Mints an access token and a refresh token for a grant and returns the
// token-endpoint response body (RFC 6749 §5.1).
export async function issueTokens(env, grantId, scope) {
  const access = randomToken();
  const refresh = randomToken();
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
     VALUES (?, ?, 'access', datetime('now', ?))`
  ).bind(await sha256Hex(access), grantId, `+${ACCESS_TTL_SECONDS} seconds`).run();
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
     VALUES (?, ?, 'refresh', datetime('now', ?))`
  ).bind(await sha256Hex(refresh), grantId, `+${REFRESH_TTL_DAYS} days`).run();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  };
}

// Kills a grant and everything it minted. Revocation, a replayed code, a
// replayed refresh token and a ban all end here.
export async function revokeGrant(env, grantId) {
  await env.DB.prepare(
    "UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?"
  ).bind(grantId).run();
  await env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').bind(grantId).run();
}

// The Bearer token on a request, resolved to the member it acts for. Null
// for a missing, unknown, expired or refresh token, a revoked grant, or a
// disabled member — the ban takes effect on the next call, the same way
// getSession() refuses a banned member's cookie.
export async function authenticateBearer(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT g.id AS grant_id, g.member_slug, g.client_id, g.scope, g.last_used_at,
            m.first_name, m.name, COALESCE(m.is_admin, 0) AS is_admin
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN members m ON m.slug = g.member_slug
      WHERE t.token_hash = ? AND t.kind = 'access'
        AND datetime(t.expires_at) > datetime('now')
        AND g.revoked_at IS NULL
        AND COALESCE(m.disabled, 0) = 0`
  ).bind(await sha256Hex(m[1])).first().catch(() => null);
  if (!row) return null;
  return {
    grant_id: row.grant_id,
    client_id: row.client_id,
    member_slug: row.member_slug,
    // Same value issueSession() stores as sessions.email — the display name
    // handlers stamp into added_by.
    email: row.first_name || row.name || row.member_slug,
    // An admin grant outlives nothing: demote the member and the next call
    // sees no admin tools.
    scopes: parseScope(row.scope).filter((sc) => sc !== 'members:admin' || row.is_admin),
  };
}

// Housekeeping, run opportunistically from the token endpoint: expired codes
// and tokens have no further use, and a table nobody prunes is a table that
// grows forever.
export async function pruneExpired(env) {
  await env.DB.prepare("DELETE FROM oauth_codes WHERE datetime(expires_at) < datetime('now', '-1 day')").run().catch(() => {});
  await env.DB.prepare("DELETE FROM oauth_tokens WHERE datetime(expires_at) < datetime('now')").run().catch(() => {});
  // mcp_usage drives the daily caps (only today's row is read for that) and
  // the Reporting page's 30-day and all-time AI-app usage, so it's kept a
  // year — one small row per member per active day.
  await env.DB.prepare("DELETE FROM mcp_usage WHERE day < date('now', '-365 days')").run().catch(() => {});
}

export function oauthJson(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      // Bearer credentials are never ambient, so a browser-based MCP client
      // (the MCP Inspector, say) may call these from any origin.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export function oauthError(error, description, status = 400) {
  return oauthJson({ error, ...(description ? { error_description: description } : {}) }, status);
}

export function preflight(methods) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// Token and revocation requests arrive form-encoded (RFC 6749 §4.1.3), but
// some clients send JSON; accept both.
export async function readParams(request) {
  const type = request.headers.get('Content-Type') || '';
  try {
    if (type.includes('application/json')) {
      const body = await request.json();
      return new Map(Object.entries(body || {}).map(([k, v]) => [k, v == null ? '' : String(v)]));
    }
    const text = await request.text();
    return new Map(new URLSearchParams(text));
  } catch {
    return new Map();
  }
}

// Client authentication at the token endpoint: public clients (the common
// case, and what Claude registers as) send only client_id and rely on PKCE;
// a client that registered for a secret must present it, in the body or as
// HTTP Basic.
export async function authenticateClient(request, params, env) {
  let clientId = params.get('client_id') || '';
  let secret = params.get('client_secret') || '';
  const basic = (request.headers.get('Authorization') || '').match(/^Basic\s+(.+)$/i);
  if (basic) {
    try {
      const [id, pw] = atob(basic[1]).split(':');
      clientId = decodeURIComponent(id || '');
      secret = decodeURIComponent(pw || '');
    } catch { return null; }
  }
  const client = await getClient(env, clientId);
  if (!client) return null;
  if (client.client_secret_hash) {
    if (!secret || (await sha256Hex(secret)) !== client.client_secret_hash) return null;
  }
  return client;
}

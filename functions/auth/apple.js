// Sign in with Apple. The native app sends Apple's identity token (a JWT signed
// by Apple); we verify the signature against Apple's published keys, then map
// the token to an existing member — first by the email Apple shares (against
// member_emails), thereafter by the stable Apple user id (`sub`). No public
// sign-up: an unrecognized identity is rejected, never auto-created.

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

const MAX_FAILS = 5;
const WINDOW_MIN = 15;

// The token audience is the native app's bundle id, OR — for "Sign in with
// Apple" on the website — the web Services ID. APPLE_CLIENT_ID may be a
// comma-separated list to allow both; defaults to the native bundle id.
const DEFAULT_CLIENT_IDS = ['net.patrickturner.showpickerios'];
const APPLE_ISS = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

function allowedClientIds(env) {
  const configured = (env.APPLE_CLIENT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_CLIENT_IDS;
}

async function failureCount(env, ip) {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first();
  return row?.cnt || 0;
}

async function recordFailure(env, ip, member) {
  await env.DB.prepare(
    'INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, ?, ?)'
  ).bind(ip, member || null, new Date().toISOString()).run();
}

// ---- JWT verification helpers ----

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// Cache Apple's signing keys per-isolate for an hour — they rotate slowly.
let _appleKeys = { fetchedAt: 0, keys: [] };

async function getAppleKey(kid) {
  if (!_appleKeys.keys.length || Date.now() - _appleKeys.fetchedAt > 3600 * 1000) {
    const resp = await fetch(APPLE_KEYS_URL);
    if (resp.ok) {
      const json = await resp.json();
      _appleKeys = { fetchedAt: Date.now(), keys: json.keys || [] };
    }
  }
  return _appleKeys.keys.find((k) => k.kid === kid);
}

// Returns the verified payload, or throws on any failure.
async function verifyAppleToken(token, allowedAuds) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');

  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));
  if (header.alg !== 'RS256') throw new Error('bad_alg');

  const jwk = await getAppleKey(header.kid);
  if (!jwk) throw new Error('unknown_key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const sig = b64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) throw new Error('bad_signature');

  if (payload.iss !== APPLE_ISS) throw new Error('bad_iss');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.some((a) => allowedAuds.includes(a))) throw new Error('bad_aud');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('expired');

  return payload;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (await failureCount(env, ip) >= MAX_FAILS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...corsHeaders(), 'Retry-After': String(WINDOW_MIN * 60) },
    });
  }

  let identityToken;
  try {
    const body = await request.json();
    identityToken = body.identity_token || body.identityToken;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400, headers: corsHeaders() });
  }
  if (!identityToken) {
    return new Response(JSON.stringify({ error: 'missing' }), { status: 400, headers: corsHeaders() });
  }

  const clientIds = allowedClientIds(env);

  let payload;
  try {
    payload = await verifyAppleToken(identityToken, clientIds);
  } catch (e) {
    await recordFailure(env, ip, null);
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: corsHeaders() });
  }

  const sub = payload.sub;
  const email = (payload.email || '').trim().toLowerCase();

  // 1) Already-linked Apple id wins — works even behind a relay email.
  let memberSlug = (await env.DB.prepare(
    'SELECT member_slug FROM member_apple_ids WHERE apple_sub = ?'
  ).bind(sub).first())?.member_slug;

  // 2) First sign-in: match the shared email to a seeded member, then link.
  if (!memberSlug && email) {
    const er = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(email).first();
    if (er) {
      memberSlug = er.member_slug;
      await env.DB.prepare(
        'INSERT OR REPLACE INTO member_apple_ids (apple_sub, member_slug, email, created_at) VALUES (?, ?, ?, ?)'
      ).bind(sub, memberSlug, email, new Date().toISOString()).run();
    }
  }

  if (!memberSlug) {
    await recordFailure(env, ip, null);
    return new Response(JSON.stringify({ error: 'unrecognized' }), { status: 401, headers: corsHeaders() });
  }

  return await issueSession(env, memberSlug);
}

async function issueSession(env, memberSlug) {
  const m = await env.DB.prepare(
    'SELECT first_name, name FROM members WHERE slug = ?'
  ).bind(memberSlug).first();
  const editorName = m?.first_name || m?.name || memberSlug;

  const sessionId = crypto.randomUUID();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await env.DB.prepare(
    'INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(sessionId, editorName, memberSlug, sessionExpires.toISOString(), new Date().toISOString()).run();

  // Durable login timestamp (migration 013). Best-effort — never break login.
  await env.DB.prepare("UPDATE members SET last_login_at = datetime('now') WHERE slug = ?")
    .bind(memberSlug).run().catch(() => {});

  return new Response(JSON.stringify({ success: true, slug: memberSlug }), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Set-Cookie': `session=${sessionId}; Path=/; Expires=${sessionExpires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

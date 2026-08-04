// Sign in with Google (web). The Google Identity Services button gives the
// browser an ID token (a JWT signed by Google); we verify it against
// Google's published keys, then map it to a member — first by the stable
// Google user id (`sub`, via member_google_ids), then by verified email.
// An unrecognized identity becomes a new member — Google tokens carry the
// person's name, so no extra screen needed.
//
// Inert unless GOOGLE_CLIENT_ID is configured (comma-separated list allowed,
// e.g. a web client id plus a future iOS client id).

import { issueSession } from '../_shared/session.js';
import { enrollmentThrottled, enrollMember } from '../_shared/enroll.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

const MAX_FAILS = 5;
const WINDOW_MIN = 15;

const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

function allowedClientIds(env) {
  return (env.GOOGLE_CLIENT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

async function failureCount(env, ip) {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first();
  return row?.cnt || 0;
}

async function recordFailure(env, ip) {
  await env.DB.prepare(
    'INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, NULL, ?)'
  ).bind(ip, new Date().toISOString()).run();
}

// ---- JWT verification (same shape as auth/apple.js) ----

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

// Cache Google's signing keys per-isolate for an hour — they rotate slowly.
let _googleKeys = { fetchedAt: 0, keys: [] };

async function getGoogleKey(kid) {
  if (!_googleKeys.keys.length || Date.now() - _googleKeys.fetchedAt > 3600 * 1000) {
    const resp = await fetch(GOOGLE_KEYS_URL);
    if (resp.ok) {
      const json = await resp.json();
      _googleKeys = { fetchedAt: Date.now(), keys: json.keys || [] };
    }
  }
  return _googleKeys.keys.find((k) => k.kid === kid);
}

// Returns the verified payload, or throws on any failure.
async function verifyGoogleToken(token, allowedAuds) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');

  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));
  if (header.alg !== 'RS256') throw new Error('bad_alg');

  const jwk = await getGoogleKey(header.kid);
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

  if (!GOOGLE_ISS.includes(payload.iss)) throw new Error('bad_iss');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.some((a) => allowedAuds.includes(a))) throw new Error('bad_aud');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('expired');

  return payload;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const clientIds = allowedClientIds(env);
  if (!clientIds.length) {
    return new Response(JSON.stringify({ error: 'google_not_configured' }), { status: 501, headers: corsHeaders() });
  }

  if (await failureCount(env, ip) >= MAX_FAILS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...corsHeaders(), 'Retry-After': String(WINDOW_MIN * 60) },
    });
  }

  let credential, fullName;
  try {
    const body = await request.json();
    credential = body.credential || body.id_token;
    fullName = String(body.full_name || '').trim();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400, headers: corsHeaders() });
  }
  if (!credential) {
    return new Response(JSON.stringify({ error: 'missing' }), { status: 400, headers: corsHeaders() });
  }

  let payload;
  try {
    payload = await verifyGoogleToken(credential, clientIds);
  } catch (e) {
    await recordFailure(env, ip);
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: corsHeaders() });
  }

  const sub = payload.sub;
  // Only trust the email claim when Google says it's verified.
  const email = payload.email_verified ? (payload.email || '').trim().toLowerCase() : '';

  // 1) Already-linked Google id wins.
  let memberSlug = (await env.DB.prepare(
    'SELECT member_slug FROM member_google_ids WHERE google_sub = ?'
  ).bind(sub).first().catch(() => null))?.member_slug;

  // 2) First sign-in: match the verified email to a member, then link.
  if (!memberSlug && email) {
    const er = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(email).first();
    if (er) {
      memberSlug = er.member_slug;
      await env.DB.prepare(
        'INSERT OR REPLACE INTO member_google_ids (google_sub, member_slug, email, created_at) VALUES (?, ?, ?, ?)'
      ).bind(sub, memberSlug, email, new Date().toISOString()).run().catch(() => {});
    }
  }

  // 3) Self-enrollment. Google tokens carry the display name, so the extra
  // name screen is only needed if the claim is somehow absent.
  if (!memberSlug) {
    if (!email) {
      await recordFailure(env, ip);
      return new Response(JSON.stringify({ error: 'unrecognized' }), { status: 401, headers: corsHeaders() });
    }
    const name = fullName || String(payload.name || '').trim();
    if (!name) {
      return new Response(JSON.stringify({ needs_name: true }), { status: 200, headers: corsHeaders() });
    }
    const throttled = await enrollmentThrottled(env, ip);
    if (throttled) {
      return new Response(JSON.stringify({ error: throttled }), { status: 429, headers: corsHeaders() });
    }
    const created = await enrollMember(env, context, {
      full_name: name,
      email,
      via: 'google',
      googleSub: sub,
      ip,
    });
    if (!created.ok) {
      return new Response(JSON.stringify({ error: created.error }), { status: created.status || 400, headers: corsHeaders() });
    }
    return await issueSession(env, created.slug, { enrolled: true }, 'google');
  }

  if (!memberSlug) {
    await recordFailure(env, ip);
    return new Response(JSON.stringify({ error: 'unrecognized' }), { status: 401, headers: corsHeaders() });
  }

  return await issueSession(env, memberSlug, {}, 'google');
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

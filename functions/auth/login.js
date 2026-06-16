import { checkVerification, normalizePhone } from '../_shared/twilio-verify.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

const MAX_FAILS = 5;
const WINDOW_MIN = 15;

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

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (await failureCount(env, ip) >= MAX_FAILS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...corsHeaders(), 'Retry-After': String(WINDOW_MIN * 60) },
    });
  }

  // `member` is resolved server-side from the email below — it is never taken
  // from the request. The old static per-member codes are gone; login is phone
  // (Twilio Verify) or email (login_otps) only.
  let code, member, email, phone;
  try {
    const body = await request.json();
    code = body.code;
    email = (body.email || '').trim().toLowerCase();
    phone = (body.phone || '').trim();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400, headers: corsHeaders() });
  }

  if (!code || (!member && !email && !phone)) {
    return new Response(JSON.stringify({ error: 'missing' }), { status: 400, headers: corsHeaders() });
  }

  // ---- SMS path: validate the code through Twilio Verify ----
  if (phone) {
    const e164 = normalizePhone(phone);
    if (!e164) {
      return new Response(JSON.stringify({ error: 'invalid_phone' }), { status: 400, headers: corsHeaders() });
    }
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_phones WHERE phone = ? LIMIT 1'
    ).bind(e164).first();
    if (!row) {
      await recordFailure(env, ip, null);
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
    }
    const check = await checkVerification(env, { to: e164, code });
    if (!check.ok || !check.approved) {
      await recordFailure(env, ip, row.member_slug);
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
    }
    return await issueSession(env, row.member_slug);
  }

  // ---- Email path: lookup our locally-stored OTP ----
  if (!member && email) {
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(email).first();
    if (!row) {
      await recordFailure(env, ip, null);
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
    }
    member = row.member_slug;
  }

  const nowISO = new Date().toISOString();
  const otp = await env.DB.prepare(
    `SELECT id FROM login_otps
       WHERE member_slug = ? AND code = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(member, code, nowISO).first();

  if (!otp) {
    await recordFailure(env, ip, member);
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
  }

  await env.DB.prepare('UPDATE login_otps SET used_at = ? WHERE id = ?')
    .bind(nowISO, otp.id).run();
  return await issueSession(env, member);
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

  // Durable login timestamp (migration 013). Best-effort: never let a missing
  // column or write error break the login itself.
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

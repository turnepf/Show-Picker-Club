import { checkVerification, normalizePhone } from '../_shared/twilio-verify.js';
import { issueSession } from '../_shared/session.js';
import { noteDemoLogin } from '../_shared/demo.js';
import { selfEnrollEnabled } from '../_shared/enroll.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

const MAX_FAILS = 5;
const WINDOW_MIN = 15;
// Per-ACCOUNT cap, on top of the per-IP one: the IP cap alone doesn't stop a
// distributed guesser who knows a member's email/phone and rotates addresses.
// Ten wrong codes against one member inside the window locks that member's
// code login until the window rolls over, whatever IPs the guesses came from.
const MAX_MEMBER_FAILS = 10;

async function failureCount(env, ip) {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first();
  return row?.cnt || 0;
}

async function memberFailureCount(env, member) {
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE member_slug = ? AND created_at > ?'
  ).bind(member, since).first();
  return row?.cnt || 0;
}

function rateLimited() {
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: { ...corsHeaders(), 'Retry-After': String(WINDOW_MIN * 60) },
  });
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
  // from the request. Login is phone (Twilio Verify) or email (login_otps) only.
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

  // ---- Reviewer / demo login ----
  // A single pre-provisioned account can sign in with a fixed code, gated
  // entirely on two Cloudflare secrets: DEMO_LOGIN_EMAIL and DEMO_LOGIN_CODE.
  // With either secret unset this branch is inert, so it is not a general
  // backdoor — it only ever unlocks the one configured email, and the IP
  // rate-limit above still applies. Used to give App Review a way past the
  // invite-only login wall without a real SMS/email round-trip.
  const demoEmail = (env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase();
  const demoCode = env.DEMO_LOGIN_CODE || '';
  if (demoEmail && demoCode && email && email === demoEmail && code === demoCode) {
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(demoEmail).first();
    if (row) {
      // Restore the baseline if a previous visitor's hour is up, then arm
      // the next auto-reset for one hour from now.
      await noteDemoLogin(env, row.member_slug);
      return await issueSession(env, row.member_slug);
    }
    // Secret set but no matching member — fall through to the normal flow
    // rather than silently succeeding on a misconfiguration.
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
    if (await memberFailureCount(env, row.member_slug) >= MAX_MEMBER_FAILS) {
      return rateLimited();
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
      // Unknown email: with self-enroll on, the code may be a signup code
      // (enroll_otps). If it checks out, tell the client to collect a name
      // and finish via POST /auth/enroll — the code is NOT consumed here,
      // so the two-step stays within the code's 10-minute TTL.
      if (selfEnrollEnabled(env)) {
        const pending = await env.DB.prepare(
          `SELECT id FROM enroll_otps
             WHERE email = ? AND code = ? AND used_at IS NULL AND expires_at > ?
             ORDER BY created_at DESC LIMIT 1`
        ).bind(email, code, new Date().toISOString()).first().catch(() => null);
        if (pending) {
          return new Response(JSON.stringify({ needs_name: true }), { status: 200, headers: corsHeaders() });
        }
      }
      await recordFailure(env, ip, null);
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
    }
    member = row.member_slug;
  }

  if (await memberFailureCount(env, member) >= MAX_MEMBER_FAILS) {
    return rateLimited();
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

  // Consume the code atomically. Two requests can both observe the same
  // unused row above; without the used_at predicate each could mint a
  // session before the other writes. Only the request that changes the row
  // owns this OTP.
  const consumed = await env.DB.prepare(
    'UPDATE login_otps SET used_at = ? WHERE id = ? AND used_at IS NULL'
  ).bind(nowISO, otp.id).run();
  if (!consumed.meta?.changes) {
    await recordFailure(env, ip, member);
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: corsHeaders() });
  }
  return await issueSession(env, member);
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

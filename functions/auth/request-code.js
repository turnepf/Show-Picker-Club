import { sendEmail, loginCodeEmail } from '../_shared/email.js';
import { sendVerification, normalizePhone } from '../_shared/twilio-verify.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_PER_HOUR = 5;
const TTL_MIN = 10;

function makeCode() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  // 6-digit numeric, zero-padded.
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const memberInput = (body.member || '').trim().toLowerCase();
  const emailInput = (body.email || '').trim().toLowerCase();
  const phoneInput = (body.phone || '').trim();
  const channel = body.channel === 'sms' ? 'sms' : 'email';

  if (!memberInput && !emailInput && !phoneInput) {
    return json({ error: 'missing' }, 400);
  }

  // ---- SMS path: Twilio Verify ----
  // Verify holds the code on its side, so we don't insert into login_otps.
  // We still log a row with channel='sms' and code='' so the per-member
  // rate limit covers both delivery channels uniformly.
  if (channel === 'sms') {
    const e164 = normalizePhone(phoneInput);
    if (!e164) {
      return json({ error: 'invalid_phone' }, 400);
    }
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_phones WHERE phone = ? LIMIT 1'
    ).bind(e164).first();
    if (!row) {
      // Don't reveal whether the phone is known.
      return json({ success: true });
    }
    const memberSlug = row.member_slug;

    if (await overRateLimit(env, memberSlug)) {
      return json({ error: 'rate_limited' }, 429);
    }

    const result = await sendVerification(env, { to: e164 });
    if (!result.ok) {
      return json({ error: 'send_failed' }, 502);
    }
    // Marker row for rate-limiting; code stays empty since Twilio holds it.
    await env.DB.prepare(
      'INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(memberSlug, '', 'sms',
           new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString()).run();
    return json({ success: true });
  }

  // ---- Email path: our own OTP table, Resend delivery ----
  let memberSlug;
  let recipients = [];
  if (emailInput) {
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(emailInput).first();
    if (!row) {
      return json({ success: true });
    }
    memberSlug = row.member_slug;
    recipients = [emailInput];
  } else {
    memberSlug = memberInput;
    const { results } = await env.DB.prepare(
      'SELECT email FROM member_emails WHERE member_slug = ? ORDER BY is_primary DESC'
    ).bind(memberSlug).all();
    recipients = (results || []).map(r => r.email);
    if (recipients.length === 0) {
      return json({ success: true });
    }
  }

  if (await overRateLimit(env, memberSlug)) {
    return json({ error: 'rate_limited' }, 429);
  }

  const code = makeCode();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(memberSlug, code, 'email', expiresAt).run();

  const { subject, text, html } = loginCodeEmail(code);
  const result = await sendEmail(env, { to: recipients, subject, text, html });
  if (!result.ok) {
    return json({ error: 'send_failed' }, 502);
  }
  return json({ success: true });
}

async function overRateLimit(env, memberSlug) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM login_otps WHERE member_slug = ? AND created_at > ?'
  ).bind(memberSlug, since).first()) || { cnt: 0 };
  return cnt >= MAX_PER_HOUR;
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

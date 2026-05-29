import { sendEmail, loginCodeEmail } from '../_shared/email.js';

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

  // Accept either a member slug ("brad") or an email address.
  const memberInput = (body.member || '').trim().toLowerCase();
  const emailInput = (body.email || '').trim().toLowerCase();
  const channel = body.channel === 'sms' ? 'sms' : 'email';

  if (!memberInput && !emailInput) {
    return json({ error: 'missing' }, 400);
  }

  // Resolve to a member slug + recipient emails.
  let memberSlug;
  let recipients = [];
  if (emailInput) {
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(emailInput).first();
    if (!row) {
      // Don't reveal whether the email is known — TCR-style account-enumeration
      // hardening. Pretend we sent it.
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

  // Per-member rate limit so a stuck client can't spam someone's inbox.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM login_otps WHERE member_slug = ? AND created_at > ?'
  ).bind(memberSlug, since).first()) || { cnt: 0 };
  if (cnt >= MAX_PER_HOUR) {
    return json({ error: 'rate_limited' }, 429);
  }

  const code = makeCode();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(memberSlug, code, channel, expiresAt).run();

  if (channel === 'email') {
    const { subject, text, html } = loginCodeEmail(code);
    const result = await sendEmail(env, { to: recipients, subject, text, html });
    if (!result.ok) {
      return json({ error: 'send_failed' }, 502);
    }
  } else {
    // SMS path lights up once Twilio campaign is approved; for now treat as
    // success silently — operator can still see the code in login_otps to
    // help during the transition.
    console.warn('[request-code] sms requested but not yet wired:', memberSlug);
  }

  return json({ success: true });
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

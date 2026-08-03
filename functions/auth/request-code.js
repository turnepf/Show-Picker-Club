import { sendEmail, loginCodeEmail, signupCodeEmail } from '../_shared/email.js';
import { sendVerification, normalizePhone } from '../_shared/twilio-verify.js';
import { turnstileOk, enrollmentThrottled } from '../_shared/enroll.js';

// Only browsers on our own site send this Origin on a POST; native apps
// (URLSession) never do. We use that to require a Turnstile challenge on the
// WEB login form without breaking iOS/tvOS email/phone login, which can't
// produce a Turnstile token.
const WEB_ORIGIN = 'https://showpicker.club';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_PER_HOUR = 5;
// Per-IP cap, separate from the per-member cap above: that one throttles
// repeated codes to the SAME account; this one throttles a single source
// hammering the endpoint (any member's email/phone) with a spoofed or
// scripted client. Set well above normal shared-network use (two or three
// members behind one home router each requesting a code) so it only bites
// a real flood.
const MAX_PER_IP_PER_HOUR = 10;
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

  // Who asked — logged on every OTP row so a repeat of unrequested codes can be
  // traced to a source and blocked at the edge.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = request.headers.get('User-Agent') || '';
  const isWeb = (request.headers.get('Origin') || '') === WEB_ORIGIN;
  // Turnstile is only enforceable on the web form (native can't mint a token),
  // and only when the secret is configured; otherwise it's inert.
  const requireCaptcha = isWeb && !!env.TURNSTILE_SECRET_KEY;

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

    if (await overRateLimit(env, memberSlug) || await overIpRateLimit(env, ip)) {
      return json({ error: 'rate_limited' }, 429);
    }

    const result = await sendVerification(env, { to: e164 });
    if (!result.ok) {
      return json({ error: 'send_failed' }, 502);
    }
    // Marker row for rate-limiting; code stays empty since Twilio holds it.
    await env.DB.prepare(
      'INSERT INTO login_otps (member_slug, code, channel, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(memberSlug, '', 'sms',
           new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString(), ip, userAgent).run();
    return json({ success: true });
  }

  // ---- Email path: our own OTP table, Resend delivery ----
  // Verify the web Turnstile token up front — BEFORE any membership lookup — so
  // a failed/missing challenge returns the same 403 whether or not the email
  // belongs to a member (checking it later would leak membership: unknown =>
  // success, known => captcha-error). Native requests (no Origin) skip this.
  let captchaVerified = false;
  if (requireCaptcha) {
    if (!(await turnstileOk(env, body.turnstile_token, ip))) {
      return json({ error: 'captcha' }, 403);
    }
    captchaVerified = true;
  }

  let memberSlug;
  let recipients = [];
  if (emailInput) {
    const row = await env.DB.prepare(
      'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
    ).bind(emailInput).first();
    if (!row) {
      // Unknown email — this is a signup: send a signup code instead. Either
      // way the response is the same { success: true }, so callers can't
      // probe which emails belong to members.
      await maybeSendSignupCode(context, emailInput, ip, body.turnstile_token, captchaVerified);
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

  if (await overRateLimit(env, memberSlug) || await overIpRateLimit(env, ip)) {
    return json({ error: 'rate_limited' }, 429);
  }

  const code = makeCode();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO login_otps (member_slug, code, channel, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(memberSlug, code, 'email', expiresAt, ip, userAgent).run();

  const { subject, text, html } = loginCodeEmail(code);
  const result = await sendEmail(env, { to: recipients, subject, text, html });
  if (!result.ok) {
    return json({ error: 'send_failed' }, 502);
  }
  return json({ success: true });
}

// Signup-code path for unknown emails. All failures are
// silent — the caller already returned { success: true } shape regardless,
// and every guard here (Turnstile, global circuit breaker, per-IP and
// per-email caps) exists to stop abuse, not to inform the abuser.
async function maybeSendSignupCode(context, email, ip, turnstileToken, captchaVerified = false) {
  const { env } = context;
  // The web caller already verified the (single-use) token upstream; re-checking
  // here would consume it a second time and always fail. Native callers (no
  // Origin, captchaVerified=false) still get their own check.
  if (!captchaVerified && !(await turnstileOk(env, turnstileToken, ip))) return;
  if (await enrollmentThrottled(env, ip)) return;
  // Per-email cap: 3 signup codes per hour.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM enroll_otps WHERE email = ? AND created_at > ?'
  ).bind(email, hourAgo).first().catch(() => ({ cnt: 99 }))) || { cnt: 99 };
  if (cnt >= 3) return;

  const code = makeCode();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO enroll_otps (email, code, ip, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(email, code, ip, expiresAt).run();
  const { subject, text, html } = signupCodeEmail(code);
  await sendEmail(env, { to: [email], subject, text, html });
}

async function overRateLimit(env, memberSlug) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM login_otps WHERE member_slug = ? AND created_at > ?'
  ).bind(memberSlug, since).first()) || { cnt: 0 };
  return cnt >= MAX_PER_HOUR;
}

// 'unknown' (missing CF-Connecting-IP — shouldn't happen behind Cloudflare,
// but defensively) is never enforced: every such request would share one
// bucket and could lock out unrelated members, which is worse than skipping
// the check for that sliver of traffic. The per-member cap above still
// applies regardless.
async function overIpRateLimit(env, ip) {
  if (ip === 'unknown') return false;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM login_otps WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first()) || { cnt: 0 };
  return cnt >= MAX_PER_IP_PER_HOUR;
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

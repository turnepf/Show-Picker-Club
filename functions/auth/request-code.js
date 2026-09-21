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
  // This is the ONLY Turnstile check on the email path — the token is
  // single-use, and the branches downstream must not re-check it.
  if (requireCaptcha && !(await turnstileOk(env, body.turnstile_token, ip))) {
    return json({ error: 'captcha' }, 403);
  }

  // ---- Reviewer / demo account: nothing to send ----
  // The demo login signs in with a fixed code (DEMO_LOGIN_CODE, checked in
  // /auth/login), so there is no code to mail — and mailing one is actively
  // harmful: DEMO_LOGIN_EMAIL is a throwaway address, and Resend rejects
  // reserved domains like example.com outright (422). That 422 became a 502
  // here, the apps showed "Couldn't send the code", and App Review never
  // reached the screen where the fixed code would have worked — which is
  // exactly how tvOS 1.2 was rejected on 2026-08-08. Answering success with
  // an empty mailbox is the honest reply: the code the reviewer already has
  // is the code that works. Gated on both secrets AND a real member row, the
  // same three conditions /auth/login requires, so a half-configured demo
  // falls through to the normal flow instead of dead-ending here.
  const demoEmail = demoLoginAddress(env);
  if (emailInput && emailInput === demoEmail && await hasMemberEmail(env, demoEmail)) {
    return json({ success: true });
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
      // probe which emails belong to members. A delivery failure is the one
      // thing worth reporting, and it's safe to: whether Resend accepts an
      // address doesn't depend on whether it's a member, so both branches
      // 502 alike.
      //
      // The per-IP budget is checked HERE rather than only at the shared
      // check below, because this branch returns before reaching it. Leaving
      // it outside meant one source could mint unlimited signup codes to
      // addresses of its choosing. The reply stays { success: true } so a
      // throttled caller still can't tell a member from a stranger.
      if (await overIpRateLimit(env, ip)) {
        return json({ success: true });
      }
      const sent = await maybeSendSignupCode(context, emailInput, ip);
      return sent === 'send_failed' ? json({ error: 'send_failed' }, 502) : json({ success: true });
    }
    memberSlug = row.member_slug;
    recipients = [emailInput];
  } else {
    memberSlug = memberInput;
    const { results } = await env.DB.prepare(
      'SELECT email FROM member_emails WHERE member_slug = ? ORDER BY is_primary DESC'
    ).bind(memberSlug).all();
    // Same rule as the email branch above, for the by-slug caller: the demo
    // address is never mailed. A demo member with a second, real address
    // still gets a code there.
    recipients = (results || []).map(r => r.email)
      .filter(e => String(e).trim().toLowerCase() !== demoEmail);
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

// The demo/reviewer address, or null when the demo login isn't fully
// configured — mirroring /auth/login, which needs BOTH secrets before it will
// honor the fixed code. With one of them missing there is no fixed code to
// sign in with, so the address has to keep receiving real ones.
function demoLoginAddress(env) {
  const email = (env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase();
  return email && env.DEMO_LOGIN_CODE ? email : null;
}

// /auth/login's demo branch also falls through when the address belongs to no
// member (it has no session to issue), so the short-circuit here checks the
// same thing rather than dead-ending a misconfigured demo.
async function hasMemberEmail(env, email) {
  const row = await env.DB.prepare(
    'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
  ).bind(email).first();
  return !!row;
}

// Signup-code path for unknown emails. The abuse guards here (global circuit
// breaker, per-IP and per-email caps) fail silently — they exist to stop an
// abuser, not to inform one, and the caller returns { success: true }
// regardless. A failed *delivery* is different: it says nothing about who is
// a member, and swallowing it is what leaves someone staring at a code screen
// that will never fill. Returns 'send_failed' in that one case.
async function maybeSendSignupCode(context, email, ip) {
  const { env } = context;
  // No Turnstile check here. It belongs to the WEB form, and the caller has
  // already resolved it (verified, or 403 before we ever got here). Repeating
  // it fails closed for every native client — iOS and tvOS can't mint a token
  // — which silently dropped every signup code the apps asked for until
  // 2026-08. Enumeration is unaffected: a caller that got past the front door
  // gets the same reply for a member and a stranger.
  if (await enrollmentThrottled(env, ip)) return;
  // Per-email cap: 3 signup codes per hour. datetime() on BOTH sides — see
  // the note on overRateLimit below; enroll_otps.created_at is written by the
  // column default, the bound is a JavaScript ISO string, and compared raw
  // this counted zero for every row minted on the same UTC day.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM enroll_otps WHERE email = ? AND datetime(created_at) > datetime(?)'
  ).bind(email, hourAgo).first().catch(() => ({ cnt: 99 }))) || { cnt: 99 };
  if (cnt >= 3) return;

  const code = makeCode();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO enroll_otps (email, code, ip, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(email, code, ip, expiresAt).run();
  const { subject, text, html } = signupCodeEmail(code);
  const result = await sendEmail(env, { to: [email], subject, text, html });
  return result.ok ? undefined : 'send_failed';
}

async function overRateLimit(env, memberSlug) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // datetime() on BOTH sides. login_otps.created_at carries SQLite's own
  // 'YYYY-MM-DD HH:MM:SS' from the column default, while `since` is a
  // JavaScript ISO-8601 string with a 'T' separator. SQLite compares TEXT
  // byte-wise, and ' ' (0x20) sorts below 'T' (0x54), so `created_at > since`
  // was unsatisfiable for every row written on the same UTC day — this cap
  // counted zero and never fired for roughly 23 hours out of every 24.
  // Normalizing both sides is correct for rows written in either format and
  // needs no migration; changing the column default would leave every
  // existing row behind.
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM login_otps WHERE member_slug = ? AND datetime(created_at) > datetime(?)'
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
  // Counts BOTH mint paths. The signup branch writes enroll_otps, so counting
  // login_otps alone let one source spend the whole hourly allowance twice —
  // once on member codes and again on signup codes. datetime() on both sides
  // for the same reason as overRateLimit.
  const { cnt } = (await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM login_otps
               WHERE ip = ?1 AND datetime(created_at) > datetime(?2))
          + (SELECT COUNT(*) FROM enroll_otps
               WHERE ip = ?1 AND datetime(created_at) > datetime(?2)) AS cnt`
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

// Self-enrollment machinery shared by the email, Apple, and Google signup
// paths. Signing up is the only way to become a member — there is no
// operator-created path and no approval step: enrolling makes you a full
// member immediately, visible on the roster, in search, activity, and
// trending like anyone else.

import { sendEmail } from './email.js';
import { createMember } from './create-member.js';

export const OPERATOR_EMAIL = 'patrick@patrickturner.net';

// Circuit breaker: max self-enrolled accounts per rolling 24h, across all
// channels. Far above organic growth for a friends-of-friends club; a botnet
// hitting the ceiling just gets "try later" while existing members are
// untouched. Raise via env var if a real wave of signups is expected.
const DEFAULT_MAX_SIGNUPS_PER_DAY = 20;

// Per-IP enrollments per day.
const MAX_PER_IP_PER_DAY = 3;

// Instant operator emails are capped per hour; the /members admin page is
// the source of truth when the cap bites during a flood.
const MAX_NOTIFY_EMAILS_PER_HOUR = 10;

// Cloudflare Turnstile server-side check. Fail-open when the secret isn't
// configured (so a deployment without Turnstile still works — the circuit
// breaker and per-IP caps remain); fail-closed on a bad token.
export async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return !!data.success;
  } catch (e) {
    // Turnstile outage shouldn't brick signups; other caps still apply.
    return true;
  }
}

// Global + per-IP throughput checks. Returns null when OK, else an error key.
// Both counts come off the members table itself (enroll_ip, migration 058) —
// a completed enrollment is the thing being rate-limited.
export async function enrollmentThrottled(env, ip) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const maxPerDay = parseInt(env.SELF_ENROLL_MAX_PER_DAY, 10) || DEFAULT_MAX_SIGNUPS_PER_DAY;
  const { cnt: globalCnt } = (await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM members WHERE enrolled_via IS NOT NULL AND created_at > ?`
  ).bind(dayAgo).first().catch(() => ({ cnt: 0 }))) || { cnt: 0 };
  if (globalCnt >= maxPerDay) return 'signups_paused';

  const { cnt: ipCnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM members WHERE enroll_ip = ? AND created_at > ?'
  ).bind(ip, dayAgo).first().catch(() => ({ cnt: 0 }))) || { cnt: 0 };
  if (ipCnt >= MAX_PER_IP_PER_DAY) return 'too_many_from_ip';
  return null;
}

// True when a name has a first *and* last token. Enrollment requires this
// before creating anything — createMember()'s token split
// (_shared/create-member.js) otherwise leaves last_name NULL on a
// single-word name, which is how one member registered without a last name.
export function hasFirstAndLast(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 2;
}

export function validFullName(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 60) return null;
  // Must contain at least one letter (any script); no control chars or
  // angle brackets (names render into member-facing HTML and emails).
  if (!/\p{L}/u.test(n)) return null;
  if (/[<>\x00-\x1f]/.test(n)) return null;
  if (!hasFirstAndLast(n)) return null;
  return n;
}

// Create the member, link the external identity if any, and fire the
// operator notification. Returns createMember's result shape
// ({ ok: true, slug, ... } | { ok: false, status, error }).
export async function enrollMember(env, ctx, { full_name, email, via, appleSub, googleSub, ip }) {
  const name = validFullName(full_name);
  if (!name) return { ok: false, status: 400, error: 'Enter your first and last name (2–60 characters).' };

  const created = await createMember(env, {
    full_name: name,
    emails: email || '',
    allowNoContact: !!(appleSub || googleSub),
    enrolledVia: via,
    enrollIp: ip || null,
  });
  if (!created.ok) return created;

  const now = new Date().toISOString();
  if (appleSub) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO member_apple_ids (apple_sub, member_slug, email, created_at) VALUES (?, ?, ?, ?)'
    ).bind(appleSub, created.slug, email || null, now).run();
  }
  if (googleSub) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO member_google_ids (google_sub, member_slug, email, created_at) VALUES (?, ?, ?, ?)'
    ).bind(googleSub, created.slug, email || null, now).run();
  }

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(notifySignup(env, { full_name: name, email, via, slug: created.slug }));
  }
  return created;
}

async function notifySignup(env, { full_name, email, via, slug }) {
  // Cap instant emails so a flood can't weaponize the notifier.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM members WHERE enrolled_via IS NOT NULL AND created_at > ?'
  ).bind(hourAgo).first().catch(() => ({ cnt: 0 }))) || { cnt: 0 };
  if (cnt > MAX_NOTIFY_EMAILS_PER_HOUR) return;

  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  // The button has to be the member page, not /members: member pages are
  // claimed by the app's associated domains, so tapping this on iPhone/iPad
  // opens Show Picker on the new member. /members is excluded from the AASA
  // file (it's the web admin tool), so a button pointing there could only
  // ever land in Safari — which is what this email used to do.
  const subject = `Show Picker Club: ${full_name} just joined (via ${via})`;
  const text = `New member.

Name:  ${full_name}
Email: ${email || '(none — external identity only)'}
Via:   ${via}

Open their page (opens in the app on iPhone/iPad):
https://showpicker.club/${slug}

Roster (web admin): https://showpicker.club/members
`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">New member: ${esc(full_name)}</h2>
    <p style="font-size:14px;">Joined via <strong>${esc(via)}</strong>${email ? ` (${esc(email)})` : ''} — <a href="https://showpicker.club/${esc(slug)}" style="color:#E67E22;">/${esc(slug)}</a></p>
    <p style="margin-top:18px;"><a href="https://showpicker.club/${esc(slug)}" style="display:inline-block;background:#E67E22;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open ${esc(full_name.split(' ')[0])}'s page</a></p>
    <p style="font-size:12px;color:#888;margin-top:10px;">Opens in Show Picker on iPhone or iPad; in the browser everywhere else.</p>
    <p style="font-size:13px;margin-top:18px;"><a href="https://showpicker.club/members" style="color:#888;">Roster (web admin)</a></p>
  </div>`;
  await sendEmail(env, { to: OPERATOR_EMAIL, subject, text, html });
}

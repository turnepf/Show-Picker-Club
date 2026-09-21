// Self-service account deletion — immediate hard delete, re-verified with a
// fresh emailed code so a stolen session cookie alone can't destroy an
// account. Required by App Store Guideline 5.1.1(v) once in-app signup
// exists; available to every member either way.
//
//   POST {}               → sends a deletion code to the primary email
//   POST { code: '...' }  → verifies, then deletes EVERYTHING: shows (and
//                           their actors), subscriptions, emails, phones,
//                           Apple/Google links, sessions, codes, member row.
//                           PII in the signup audit trail is scrubbed.
//
// Members with no email on file (rare: Apple-relay-only accounts whose relay
// was removed) get 'no_email' — the operator deletes those by hand. Admins
// must demote themselves first, so the club can't lose its last admin to a
// stray tap.

import { getSession } from '../_shared/auth.js';
import { sendEmail, deleteCodeEmail } from '../_shared/email.js';
import { forgetMemberAsWatcher } from '../_shared/watchers.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TTL_MIN = 10;
const MAX_CODES_PER_HOUR = 3;
const MAX_FAILS = 5;
const WINDOW_MIN = 15;

function makeCode() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const session = await getSession(request, env);
  if (!session || !session.member_slug) return json({ error: 'unauthorized' }, 401);
  const slug = session.member_slug;

  const member = await env.DB.prepare(
    'SELECT slug, is_admin FROM members WHERE slug = ?'
  ).bind(slug).first();
  if (!member) return json({ error: 'not_found' }, 404);
  if (member.is_admin) return json({ error: 'admin_must_demote_first' }, 400);

  let body = {};
  try { body = await request.json(); } catch {}
  const code = String(body.code || '').trim();

  // ---- Step 1: no code → send one ----
  if (!code) {
    const emailRow = await env.DB.prepare(
      'SELECT email FROM member_emails WHERE member_slug = ? ORDER BY is_primary DESC LIMIT 1'
    ).bind(slug).first();
    if (!emailRow) return json({ error: 'no_email' }, 400);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { cnt } = (await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM login_otps WHERE member_slug = ? AND channel = 'delete' AND datetime(created_at) > datetime(?)"
    ).bind(slug, hourAgo).first()) || { cnt: 0 };
    if (cnt >= MAX_CODES_PER_HOUR) return json({ error: 'rate_limited' }, 429);

    const newCode = makeCode();
    const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
    // channel='delete' keeps these out of the login flow's reach and
    // vice versa — a login code can't authorize deletion.
    await env.DB.prepare(
      'INSERT INTO login_otps (member_slug, code, channel, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(slug, newCode, 'delete', expiresAt).run();

    const { subject, text, html } = deleteCodeEmail(newCode);
    const sent = await sendEmail(env, { to: [emailRow.email], subject, text, html });
    if (!sent.ok) return json({ error: 'send_failed' }, 502);
    return json({ sent: true });
  }

  // ---- Step 2: code supplied → verify and delete ----
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const { cnt: fails } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first()) || { cnt: 0 };
  if (fails >= MAX_FAILS) return json({ error: 'rate_limited' }, 429);

  const nowISO = new Date().toISOString();
  const otp = await env.DB.prepare(
    `SELECT id FROM login_otps
       WHERE member_slug = ? AND code = ? AND channel = 'delete'
         AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(slug, code, nowISO).first();
  if (!otp) {
    await env.DB.prepare(
      'INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, ?, ?)'
    ).bind(ip, slug, nowISO).run();
    return json({ error: 'invalid' }, 401);
  }

  // Take the departing member's name off every row that named them, before
  // the rows that would identify those rows are gone. This path deletes
  // explicitly rather than leaning on cascades, and the display string isn't
  // a foreign key at all — so without this, "watching Severance with Whitt"
  // outlives Whitt's account on somebody else's list.
  try {
    await forgetMemberAsWatcher(env, slug);
  } catch (e) { /* a database without migration 064 has nothing to forget */ }

  const statements = [
    env.DB.prepare('DELETE FROM actors WHERE show_id IN (SELECT id FROM shows WHERE member_slug = ?)').bind(slug),
    env.DB.prepare('DELETE FROM shows WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM member_subscriptions WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM member_emails WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM member_phones WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM member_apple_ids WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM login_otps WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM sessions WHERE member_slug = ?').bind(slug),
    // The members row carries the signup's origin IP (enroll_ip), so deleting
    // it takes the last of the enrollment record with it — there is no
    // separate audit table to scrub any more (migration 058).
    env.DB.prepare('DELETE FROM members WHERE slug = ?').bind(slug),
  ];
  // member_google_ids (migration 031), member_passkeys (062) and
  // show_watchers (064) postdate the original delete path — include them, and
  // retry without on a database that hasn't taken those migrations yet (batch
  // is all-or-nothing, so one missing table would otherwise fail the whole
  // deletion rather than just its own line).
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM member_google_ids WHERE member_slug = ?').bind(slug),
      env.DB.prepare('DELETE FROM member_passkeys WHERE member_slug = ?').bind(slug),
      env.DB.prepare('DELETE FROM webauthn_challenges WHERE member_slug = ?').bind(slug),
      env.DB.prepare('DELETE FROM show_watchers WHERE member_slug = ?').bind(slug),
      env.DB.prepare('DELETE FROM show_watchers WHERE show_id IN (SELECT id FROM shows WHERE member_slug = ?)').bind(slug),
      // Group boards (065): their recommendations go with them; their
      // dismissed/added marks on other cards only ever shaped their own view.
      env.DB.prepare('DELETE FROM group_suggestions WHERE suggested_by = ?').bind(slug),
      env.DB.prepare('DELETE FROM group_suggestion_responses WHERE member_slug = ?').bind(slug),
      ...statements,
    ]);
  } catch (e) {
    await env.DB.batch(statements);
  }

  return new Response(JSON.stringify({ deleted: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Clear the (now dangling) session cookie.
      'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    },
  });
}

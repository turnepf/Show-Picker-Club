// Completes an email self-enrollment: the client verified a signup code via
// POST /auth/login (which answered { needs_name: true } without consuming
// the code), collected the person's name, and now finishes here. The code is
// consumed, the member is created, and a session is issued in one step.

import { issueSession } from '../_shared/session.js';
import { enrollmentThrottled, enrollMember } from '../_shared/enroll.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

const MAX_FAILS = 5;
const WINDOW_MIN = 15;

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Same per-IP failure window as /auth/login — this endpoint also takes a
  // guessable code.
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first()) || { cnt: 0 };
  if (cnt >= MAX_FAILS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...corsHeaders(), 'Retry-After': String(WINDOW_MIN * 60) },
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_body' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const fullName = String(body.full_name || '').trim();
  if (!email || !code || !fullName) return json({ error: 'missing' }, 400);

  // The email must still be unknown — if it got attached to a member between
  // the code being sent and now, this is a login, not a signup.
  const existing = await env.DB.prepare(
    'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
  ).bind(email).first();
  if (existing) return json({ error: 'already_member' }, 409);

  const nowISO = new Date().toISOString();
  const otp = await env.DB.prepare(
    `SELECT id FROM enroll_otps
       WHERE email = ? AND code = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(email, code, nowISO).first();
  if (!otp) {
    await env.DB.prepare(
      'INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, NULL, ?)'
    ).bind(ip, nowISO).run();
    return json({ error: 'invalid' }, 401);
  }

  const throttled = await enrollmentThrottled(env, ip);
  if (throttled) return json({ error: throttled }, 429);

  const created = await enrollMember(env, context, {
    full_name: fullName,
    email,
    via: 'email',
    ip,
  });
  if (!created.ok) return json({ error: created.error }, created.status || 400);

  await env.DB.prepare('UPDATE enroll_otps SET used_at = ? WHERE id = ?')
    .bind(nowISO, otp.id).run();

  return await issueSession(env, created.slug, { enrolled: true });
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

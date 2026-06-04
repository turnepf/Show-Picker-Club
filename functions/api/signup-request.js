import { sendEmail } from '../_shared/email.js';
import { normalizePhone } from '../_shared/twilio-verify.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Cap submissions per IP per day so a leaked URL can't be used to spam.
const MAX_PER_IP_PER_DAY = 3;

const OPERATOR_EMAIL = 'patrick@patrickturner.net';

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const full_name = String(body.full_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phoneRaw = String(body.phone || '').trim();
  const source = String(body.source || '').trim();

  if (!full_name) return json({ error: 'Name is required.' }, 400);
  if (full_name.length > 100) return json({ error: 'Name is too long.' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Enter a valid email address.' }, 400);
  }
  if (email.length > 200) return json({ error: 'Email is too long.' }, 400);
  if (source.length > 1000) return json({ error: 'Answer is too long.' }, 400);

  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    return json({ error: 'Enter a valid phone number.' }, 400);
  }

  // Per-IP daily cap.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { cnt } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM signup_requests WHERE ip = ? AND created_at > ?'
  ).bind(ip, since).first()) || { cnt: 0 };
  if (cnt >= MAX_PER_IP_PER_DAY) {
    return json({ error: 'Too many requests today. Try again tomorrow.' }, 429);
  }

  const insert = await env.DB.prepare(
    `INSERT INTO signup_requests (full_name, email, phone, source, ip)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(full_name, email, phone, source || null, ip).run();
  const id = insert.meta.last_row_id;

  // Notify the operator. Use waitUntil so the user gets a response even
  // if the email send is slow.
  context.waitUntil(notifyOperator(env, { id, full_name, email, phone, source }));

  return json({ ok: true });
}

async function notifyOperator(env, req) {
  const subject = `Show Picker Club: membership request from ${req.full_name}`;
  const text = `New request to join Show Picker Club.

Name:    ${req.full_name}
Email:   ${req.email}
Phone:   ${req.phone}
Source:  ${req.source || '(none)'}

Manage at https://showpicker.club/members
(Request id ${req.id})
`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">Show Picker Club — membership request</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 12px 6px 0;color:#888;white-space:nowrap;">Name</td><td style="padding:6px 0;">${escapeHtml(req.full_name)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888;white-space:nowrap;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(req.email)}" style="color:#E67E22;">${escapeHtml(req.email)}</a></td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888;white-space:nowrap;">Phone</td><td style="padding:6px 0;"><a href="tel:${escapeHtml(req.phone)}" style="color:#E67E22;">${escapeHtml(req.phone)}</a></td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888;white-space:nowrap;vertical-align:top;">Source</td><td style="padding:6px 0;">${req.source ? escapeHtml(req.source).replace(/\n/g, '<br>') : '<span style="color:#888;">(none)</span>'}</td></tr>
    </table>
    <p style="margin-top:18px;font-size:13px;color:#888;">Request id ${req.id} &middot; <a href="https://showpicker.club/members" style="color:#E67E22;">Members admin</a></p>
  </div>`;
  await sendEmail(env, { to: OPERATOR_EMAIL, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

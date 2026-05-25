import { sendSms } from '../_shared/sms.js';
import { isAdmin } from '../_shared/admin.js';

// One-shot test for the Twilio integration. Admin-secret gated so it can't
// be abused for spam. Use to confirm credentials, From-number, and that a
// real handset receives the message — before wiring SMS into login/alerts.
//
// Gated by the operator's session — pass the session cookie (grab it from
// the browser: DevTools > Application > Cookies > session).
// Example:
//   curl -X POST https://showpicker.club/api/admin-sms-test \
//     -H 'Content-Type: application/json' \
//     -H 'Cookie: session=YOUR_SESSION_ID' \
//     -d '{"to":"+13366927470","body":"hello from showpicker"}'

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdmin(request, env))) {
    return json({ error: 'Forbidden — log in as the operator' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.to || !body.body) {
    return json({ error: 'to and body required' }, 400);
  }

  const result = await sendSms(env, body.to, body.body);
  return json(result, result.ok ? 200 : 502);
}

import { sendSms } from '../_shared/sms.js';

// One-shot test for the Twilio integration. Admin-secret gated so it can't
// be abused for spam. Use to confirm credentials, From-number, and that a
// real handset receives the message — before wiring SMS into login/alerts.
//
// Example:
//   curl -X POST https://showpicker.club/api/admin-sms-test \
//     -H 'Content-Type: application/json' \
//     -d '{"secret":"...","to":"+15555550100","body":"hello from showpicker"}'

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ADMIN_SECRET) {
    return json({ error: 'ADMIN_SECRET not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Invalid secret' }, 401);
  }
  if (!body.to || !body.body) {
    return json({ error: 'to and body required' }, 400);
  }

  const result = await sendSms(env, body.to, body.body);
  return json(result, result.ok ? 200 : 502);
}

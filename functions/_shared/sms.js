// Twilio Messages API wrapper. One env-aware helper that the rest of the app
// uses for every outbound SMS — login codes, signup verification, recommendation
// alerts. Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
// TWILIO_MESSAGING_SERVICE_SID (preferred — routes through the registered
// A2P 10DLC campaign) or TWILIO_PHONE_NUMBER (fallback). If any required
// var is missing, returns a useful error instead of throwing so callers can
// degrade gracefully (e.g. recommendation alerts shouldn't block a share
// if SMS is misconfigured).

export async function sendSms(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!sid || !token) {
    return { ok: false, error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set' };
  }
  if (!messagingServiceSid && !from) {
    return { ok: false, error: 'Either TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER must be set' };
  }
  if (!to || !body) {
    return { ok: false, error: 'to and body required' };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, Body: body });
  // MessagingServiceSid takes precedence — it pins the message to the
  // registered 10DLC campaign and lets Twilio pick the right sender from
  // the pool. Falls back to From when not configured.
  if (messagingServiceSid) {
    params.set('MessagingServiceSid', messagingServiceSid);
  } else {
    params.set('From', from);
  }

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: 'Twilio fetch failed: ' + e.message };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.message || JSON.stringify(data),
      code: data?.code,
      more_info: data?.more_info,
    };
  }
  return { ok: true, sid: data.sid, status: data.status, to: data.to };
}

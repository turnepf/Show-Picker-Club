// Twilio Verify wrapper. Verify is Twilio's purpose-built 2FA API:
// it generates and stores the code on Twilio's side, we just ask it
// to send and later ask it to validate. No A2P 10DLC campaign needed
// because Verify uses Twilio's own pre-approved sending infrastructure.
//
// Required Pages secrets:
//   TWILIO_ACCOUNT_SID         — starts with AC...
//   TWILIO_AUTH_TOKEN          — Twilio account auth token
//   TWILIO_VERIFY_SERVICE_SID  — starts with VA..., the Service we created
//                                in the Verify console.

function authHeader(env) {
  // Twilio uses HTTP basic auth: <SID>:<Token>, base64.
  const creds = `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`;
  return 'Basic ' + btoa(creds);
}

function form(data) {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// Send a verification code to a phone number. Twilio holds the code;
// our /auth/login route asks Twilio to confirm it on submit.
//
// Returns { ok: true } if Twilio accepted the send, { ok: false, error }
// otherwise. In the no-secret case (dev/test), logs and pretends success
// so the rest of the flow doesn't break.
export async function sendVerification(env, { to }) {
  if (!env.TWILIO_VERIFY_SERVICE_SID || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.warn('[verify] Twilio Verify env not set; would have sent to', to);
    return { ok: true, stub: true };
  }
  const url = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({ To: to, Channel: 'sms' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[verify] send failed', res.status, body);
    return { ok: false, error: `twilio_${res.status}` };
  }
  return { ok: true };
}

// Check a code the user submitted. Returns { ok: true, approved: bool }.
// approved=true is the only success case; everything else (expired, wrong
// code, too many attempts) returns approved=false.
export async function checkVerification(env, { to, code }) {
  if (!env.TWILIO_VERIFY_SERVICE_SID || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.warn('[verify] Twilio Verify env not set; would have checked', to);
    return { ok: true, approved: false };
  }
  const url = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({ To: to, Code: code }),
  });
  if (!res.ok) {
    // Twilio returns 404 when the verification has expired or been used.
    // Treat as "not approved" rather than a hard error so the user just
    // sees "invalid code" and can request a fresh one.
    if (res.status === 404) return { ok: true, approved: false };
    const body = await res.text().catch(() => '');
    console.error('[verify] check failed', res.status, body);
    return { ok: false, error: `twilio_${res.status}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, approved: data.status === 'approved' };
}

// Normalise to E.164 the same way admin-create-member does, so a phone
// the user types into the login modal matches the format we stored.
export function normalizePhone(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length >= 7 && digits.length <= 15) return '+' + digits;
  return null;
}

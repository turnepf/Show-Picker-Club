// Resend wrapper. RESEND_API_KEY is a Pages secret; if it's missing we
// log the email body and return success so dev/test envs don't break,
// but production must have the key set.

const FROM = 'Show Picker Club <noreply@showpicker.club>';
const REPLY_TO = 'patrick@patrickturner.net';

export async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set; would have sent:', { to, subject });
    return { ok: true, stub: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      reply_to: REPLY_TO,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[email] send failed', res.status, body);
    return { ok: false, error: `resend_${res.status}` };
  }
  return { ok: true };
}

export function loginCodeEmail(code) {
  const text = `Your Show Picker Club login code is ${code}.\n\nIt's good for 10 minutes. If you didn't request this, you can ignore this email.\n\n— Show Picker Club`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">Your login code</h2>
    <p style="font-size:15px;line-height:1.5;">Enter this code on Show Picker Club to sign in:</p>
    <div style="font-size:34px;letter-spacing:6px;font-weight:600;color:#E67E22;background:#FBF5EB;border-radius:8px;padding:18px 24px;text-align:center;margin:18px 0;">${code}</div>
    <p style="font-size:13px;color:#888;">Good for 10 minutes. If you didn't request this, ignore this email.</p>
  </div>`;
  return { subject: `Your Show Picker Club login code: ${code}`, text, html };
}

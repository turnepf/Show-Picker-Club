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

export function signupCodeEmail(code) {
  const text = `Your Show Picker Club signup code is ${code}.\n\nEnter it to finish creating your account. It's good for 10 minutes. If you didn't try to join Show Picker Club, you can ignore this email.\n\n— Show Picker Club`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">Welcome to Show Picker Club</h2>
    <p style="font-size:15px;line-height:1.5;">Enter this code to finish creating your account:</p>
    <div style="font-size:34px;letter-spacing:6px;font-weight:600;color:#E67E22;background:#FBF5EB;border-radius:8px;padding:18px 24px;text-align:center;margin:18px 0;">${code}</div>
    <p style="font-size:13px;color:#888;">Good for 10 minutes. If you didn't try to join, ignore this email.</p>
  </div>`;
  return { subject: `Your Show Picker Club signup code: ${code}`, text, html };
}

export function deleteCodeEmail(code) {
  const text = `Your Show Picker Club account-deletion code is ${code}.\n\nEntering it will permanently delete your account and all your lists. This cannot be undone. It's good for 10 minutes; if you didn't request this, you can ignore this email — nothing happens without the code.\n\n— Show Picker Club`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#C0392B;margin:0 0 12px;">Confirm account deletion</h2>
    <p style="font-size:15px;line-height:1.5;">Enter this code to <strong>permanently delete</strong> your Show Picker Club account and all your lists. This cannot be undone.</p>
    <div style="font-size:34px;letter-spacing:6px;font-weight:600;color:#C0392B;background:#FDF0EE;border-radius:8px;padding:18px 24px;text-align:center;margin:18px 0;">${code}</div>
    <p style="font-size:13px;color:#888;">Good for 10 minutes. If you didn't request this, ignore this email — nothing happens without the code.</p>
  </div>`;
  return { subject: `Confirm Show Picker Club account deletion: ${code}`, text, html };
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

// After a list import: the titles the show catalog (TMDB) couldn't match, so
// they weren't added. Every show is a TMDB entry, so these need adding by
// hand, picked from search. Sent to the member's own address; replies reach
// Patrick (REPLY_TO).
export function importUnmatchedEmail({ added, titles }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = titles.length;
  const addedLine = added > 0
    ? `We added ${added} show${added === 1 ? '' : 's'} to your lists.`
    : `We couldn't add any shows from that list.`;
  const these = n === 1 ? 'this one' : `these ${n}`;
  const text = `Thanks for importing your list into Show Picker Club!\n\n${addedLine} We couldn't find ${these} in the show catalog, so ${n === 1 ? "it wasn't" : "they weren't"} added:\n\n${titles.map((t) => `  - ${t}`).join('\n')}\n\nTo add one, search for it in the app and pick it from the suggestions. A different spelling, the full title, or the year it came out (like "Shogun 2024") usually turns it up.\n\nIf something still won't show up, just reply to this email and I'll take a look.\n\nThanks for being part of the club,\nPatrick\nShow Picker Club`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">Thanks for importing your list</h2>
    <p style="font-size:15px;line-height:1.5;">${esc(addedLine)} We couldn't find ${esc(these)} in the show catalog, so ${n === 1 ? "it wasn't" : "they weren't"} added:</p>
    <ul style="font-size:15px;line-height:1.6;background:#FBF5EB;border-radius:8px;padding:14px 14px 14px 34px;margin:16px 0;">
      ${titles.map((t) => `<li>${esc(t)}</li>`).join('\n      ')}
    </ul>
    <p style="font-size:15px;line-height:1.5;">To add one, search for it in the app and pick it from the suggestions. A different spelling, the full title, or the year it came out (like “Shogun 2024”) usually turns it up.</p>
    <p style="font-size:15px;line-height:1.5;">If something still won't show up, just reply to this email and I'll take a look.</p>
    <p style="font-size:15px;line-height:1.5;margin-top:20px;">Thanks for being part of the club,<br>Patrick<br><span style="color:#888;">Show Picker Club</span></p>
  </div>`;
  return { subject: `Your Show Picker Club import: ${n} show${n === 1 ? '' : 's'} to add by hand`, text, html };
}

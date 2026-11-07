import { verifyUnsubscribeToken } from '../_shared/winback.js';

// /api/unsubscribe?m=<slug>&t=<token> — the link at the foot of every
// marketing email (functions/_shared/winback.js). PUBLIC on purpose: the
// person clicking is usually not signed in, so the signed token is the gate
// (scripts/check-static.sh, PUBLIC_ENDPOINTS). It sits under /api/ because
// the app-site association already excludes /api/*, so iOS opens it in the
// browser instead of handing it to the app.
//
// GET only shows a confirm button. Mail scanners and link previewers fetch
// every link in a message, and a GET that unsubscribed would opt people out
// who never clicked. The write is the POST: the button, or a mail client's
// built-in one-click unsubscribe (RFC 8058), which POSTs
// "List-Unsubscribe=One-Click" to the same URL, query string included.
//
// A bad token answers the same page whether or not the slug exists, so the
// endpoint can't be used to find out who's a member.

function page(title, body, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#F4F1EC; color:#2C2C2C; }
  main { max-width:460px; margin:48px auto; background:#fff; border-radius:14px; padding:28px 24px; }
  h1 { font-size:22px; color:#2C3E50; margin:0 0 12px; }
  p { font-size:16px; line-height:1.5; }
  button { background:#E67E22; color:#fff; border:0; border-radius:999px; font-size:16px; font-weight:600; padding:12px 22px; cursor:pointer; }
  a { color:#E67E22; }
  @media (max-width: 500px) { main { margin:16px; } }
</style></head>
<body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const invalid = () => page('Link not valid',
  '<h1>This link isn\'t valid</h1><p>It may have been copied incompletely. To stop these emails, reply to any of them and Patrick will take you off the list.</p>', 400);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const m = url.searchParams.get('m') || '';
  const t = url.searchParams.get('t') || '';
  if (!(await verifyUnsubscribeToken(env, m, t))) return invalid();
  return page('Unsubscribe',
    `<h1>Unsubscribe from Show Picker Club emails?</h1>
<p>You won't get any more emails like this one. Sign-in codes and anything else you ask for will still arrive.</p>
<form method="post" action="/api/unsubscribe?m=${esc(encodeURIComponent(m))}&amp;t=${esc(encodeURIComponent(t))}">
<button type="submit">Unsubscribe</button>
</form>`);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  let m = url.searchParams.get('m') || '';
  let t = url.searchParams.get('t') || '';
  if (!m || !t) {
    const form = await request.formData().catch(() => null);
    m = m || String(form?.get('m') || '');
    t = t || String(form?.get('t') || '');
  }
  if (!(await verifyUnsubscribeToken(env, m, t))) return invalid();
  await env.DB.prepare('UPDATE members SET email_opt_out = 1 WHERE slug = ?').bind(m).run();
  return page('Unsubscribed',
    `<h1>You're unsubscribed</h1>
<p>You won't get any more emails like that one. Your lists are still here whenever you want them.</p>
<p><a href="https://showpicker.club/">Back to Show Picker Club</a></p>`);
}

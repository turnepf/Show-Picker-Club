// A small, self-contained HTML page for the server-rendered OAuth screens
// (sign-in prompt, consent, errors). Pages Functions responses don't pick up
// public/_headers, so each response carries its own security headers, and
// the CSP is built per page: the consent form must be allowed to hand the
// member back to the app that asked (form-action governs the redirect that
// follows a form POST), and nothing else.

import { escapeHtml } from './og-page.js';

export { escapeHtml };

const STYLE = `
:root{--body:oklch(0.86 0.025 50);--surface:oklch(0.985 0.003 50);--surface-2:oklch(0.955 0.014 50);
--border:oklch(0.78 0.020 50);--ink:oklch(0.22 0.025 50);--ink-muted:oklch(0.40 0.018 50);
--accent:oklch(0.69 0.15 50);--accent-hover:oklch(0.60 0.16 50);--danger-soft:oklch(0.95 0.04 25);
--danger-deep:oklch(0.38 0.18 25);--font-display:ui-serif,'New York','Iowan Old Style',Georgia,serif;
--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--body:oklch(0.165 0.010 50);--surface:oklch(0.215 0.011 50);
--surface-2:oklch(0.255 0.013 50);--border:oklch(0.38 0.012 50);--ink:oklch(0.93 0.010 50);
--ink-muted:oklch(0.74 0.012 50);--accent:oklch(0.72 0.15 50);--accent-hover:oklch(0.78 0.15 50);
--danger-soft:oklch(0.30 0.06 25);--danger-deep:oklch(0.85 0.08 25)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--body);color:var(--ink);font:16px/1.5 var(--font-sans);
display:flex;align-items:flex-start;justify-content:center;padding:48px 16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;max-width:440px;width:100%;
padding:28px 24px}
h1{font-family:var(--font-display);font-size:1.5rem;line-height:1.25;margin:0 0 12px}
p{margin:0 0 14px}.muted{color:var(--ink-muted);font-size:.875rem}
.brand{font-family:var(--font-display);color:var(--ink-muted);font-size:.875rem;margin-bottom:18px}
ul.scopes{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--border);border-radius:10px;
background:var(--surface-2)}
ul.scopes li{padding:12px 14px;display:flex;gap:10px;align-items:flex-start}
ul.scopes li+li{border-top:1px solid var(--border)}
ul.scopes input{margin-top:4px;width:18px;height:18px;accent-color:var(--accent)}
.actions{display:flex;gap:10px;margin-top:6px}
.btn{flex:1;display:inline-block;text-align:center;border-radius:10px;padding:12px 16px;font:600 1rem var(--font-sans);
border:1px solid var(--border);background:var(--surface);color:var(--ink);text-decoration:none;cursor:pointer}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.error{background:var(--danger-soft);color:var(--danger-deep);border-radius:8px;padding:10px 12px}
code{font-family:ui-monospace,Menlo,monospace;font-size:.875em}
a{color:var(--accent)}
`;

export function renderPage({ title, body, status = 200, formTargets = [] }) {
  const formAction = ["'self'", ...formTargets].join(' ');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Show Picker Club</title>
<style>${STYLE}</style></head>
<body><main class="card"><div class="brand">Show Picker Club</div>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    },
  });
}

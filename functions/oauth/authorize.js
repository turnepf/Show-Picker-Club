// /oauth/authorize — where a member says yes (or no) to an AI app.
//
//   GET   validates the request, then shows one of three pages: an error (a
//         request that can't safely be sent back to the app), a sign-in
//         prompt (no session), or the consent screen.
//   POST  the consent form. Same-origin only, bound to the session that
//         rendered it, and re-validates everything GET did — the form's
//         hidden fields are the client's parameters coming back through the
//         member's browser, not something this server remembered.
//
// Two rules decide whether an error may be redirected (RFC 6749 §4.1.2.1):
// until the client_id and redirect_uri have both checked out, the page says
// what's wrong and sends the browser nowhere, because an unverified redirect
// is how an authorization endpoint becomes an open redirector.
//
// The consent screen names the client the way it named itself AND the host
// the code will be delivered to. Registration is open, so anybody can
// register a client called "Claude"; only the host is evidence.

import { getSession } from '../_shared/auth.js';
import {
  getClient, redirectMatches, redirectLabel, parseScope, scopeString, randomToken,
  sha256Hex, issuerFor, resourceFor, SCOPE_LABELS, CODE_TTL_MINUTES,
} from '../_shared/oauth.js';
import { renderPage, escapeHtml } from '../_shared/plain-page.js';

const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge',
  'code_challenge_method', 'state', 'scope', 'resource'];

function errorPage(message, status = 400) {
  return renderPage({
    title: 'Can’t connect',
    status,
    body: `<h1>This connection can’t continue</h1><p class="error">${escapeHtml(message)}</p>
<p class="muted">Go back to the app you came from and try connecting again. If it keeps happening, remove Show Picker Club there and add it again.</p>`,
  });
}

function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return new Response(null, {
    status: 303,
    headers: { Location: u.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

// form-action source for the page that will redirect to this URI.
function formTarget(redirectUri) {
  const u = new URL(redirectUri);
  return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : u.protocol;
}

// Everything both verbs check. Returns { page } for an error that must not
// redirect, { redirect } for one that may, or { req } when all is well.
async function validate(request, env, p) {
  const client = await getClient(env, p.get('client_id'));
  if (!client) return { page: errorPage('The app asking to connect isn’t registered with Show Picker Club.') };

  let redirectUri = p.get('redirect_uri') || '';
  if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) {
    return { page: errorPage('The app asked to be sent somewhere it didn’t register.') };
  }

  const state = p.get('state') || '';
  const iss = issuerFor(request);
  const fail = (error, description) => ({ redirect: redirectWith(redirectUri, { error, error_description: description, state, iss }) });

  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', "Only response_type=code is supported");
  const challenge = p.get('code_challenge') || '';
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge)) return fail('invalid_request', 'A PKCE code_challenge is required');
  if (p.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const resource = p.get('resource') || '';
  if (resource && resource.replace(/\/$/, '') !== resourceFor(request)) {
    return fail('invalid_target', 'Unknown resource');
  }

  return {
    req: {
      client, redirectUri, state, iss, challenge,
      scopes: parseScope(p.get('scope')),
    },
  };
}

function sessionIdFrom(request) {
  const m = (request.headers.get('Cookie') || '').match(/session=([^;]+)/);
  return m ? m[1] : '';
}

// Binds the form to the session that rendered it and the request it was
// rendered for. The session id is an HttpOnly secret, so no other site can
// compute this, and it needs no server-side state.
async function csrfToken(sessionId, req) {
  return sha256Hex(`oauth-consent:${sessionId}:${req.client.client_id}:${req.redirectUri}:${req.challenge}`);
}

function paramsOf(request) {
  return new URL(request.url).searchParams;
}

export async function onRequestGet({ request, env }) {
  const p = paramsOf(request);
  const v = await validate(request, env, p);
  if (v.page) return v.page;
  if (v.redirect) return v.redirect;
  const { req } = v;

  const session = await getSession(request, env);
  if (!session || !session.member_slug) {
    const here = new URL(request.url);
    const returnTo = `${here.pathname}${here.search}`;
    return renderPage({
      title: 'Sign in',
      body: `<h1>Sign in to connect ${escapeHtml(req.client.client_name)}</h1>
<p>${escapeHtml(req.client.client_name)} wants to use your Show Picker Club account. Sign in first, then you’ll choose what it can do.</p>
<div class="actions"><a class="btn btn-primary" href="/?login=1&amp;return_to=${escapeHtml(encodeURIComponent(returnTo))}">Sign in</a></div>
<p class="muted" style="margin-top:14px">New to Show Picker Club? Signing in with email, Apple or Google creates your free account.</p>`,
    });
  }

  const member = await env.DB.prepare('SELECT first_name, name FROM members WHERE slug = ?')
    .bind(session.member_slug).first();
  const who = member?.first_name || member?.name || session.member_slug;
  const csrf = await csrfToken(sessionIdFrom(request), req);
  const hidden = FIELDS.map((f) => {
    const val = f === 'redirect_uri' ? req.redirectUri : (p.get(f) || '');
    return `<input type="hidden" name="${f}" value="${escapeHtml(val)}">`;
  }).join('');
  const wantsWrite = req.scopes.includes('shows:write');

  return renderPage({
    title: 'Connect an app',
    formTargets: [formTarget(req.redirectUri)],
    body: `<h1>Connect ${escapeHtml(req.client.client_name)}?</h1>
<p><strong>${escapeHtml(req.client.client_name)}</strong> will be sent back to <strong>${escapeHtml(redirectLabel(req.redirectUri))}</strong> and will act as <strong>${escapeHtml(who)}</strong>, with the same access you have in the app.</p>
<form method="post" action="/oauth/authorize">
${hidden}<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<ul class="scopes">
<li><input type="checkbox" checked disabled aria-label="Read"><div><strong>Read</strong><div class="muted">${escapeHtml(SCOPE_LABELS['shows:read'])}</div></div></li>
${wantsWrite ? `<li><input type="checkbox" name="grant_write" value="1" id="gw" checked><label for="gw"><strong>Make changes</strong><div class="muted">${escapeHtml(SCOPE_LABELS['shows:write'])}. Untick to connect read-only.</div></label></li>` : ''}
</ul>
<p class="muted">It can’t join groups for you, change your household, or touch your account settings. You can disconnect it any time from <a href="/connected-apps">Connected apps</a>.</p>
<div class="actions">
<button class="btn" type="submit" name="decision" value="deny">Cancel</button>
<button class="btn btn-primary" type="submit" name="decision" value="allow">Allow</button>
</div>
</form>`,
  });
}

export async function onRequestPost({ request, env }) {
  // A consent POST from anywhere but this site's own page is refused before
  // anything else is read. Sec-Fetch-Site where the browser sends it, Origin
  // otherwise — the same rule group invites use (docs/INVARIANTS.md §26).
  const site = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  const sameOrigin = site ? site === 'same-origin' : (origin ? origin === issuerFor(request) : false);
  if (!sameOrigin) return errorPage('This approval didn’t come from the Show Picker Club page.', 403);

  let form;
  try { form = await request.formData(); } catch { return errorPage('The approval form was empty.'); }
  const p = new Map([...form.entries()].map(([k, v]) => [k, String(v)]));
  const v = await validate(request, env, p);
  if (v.page) return v.page;
  if (v.redirect) return v.redirect;
  const { req } = v;

  const session = await getSession(request, env);
  if (!session || !session.member_slug) return errorPage('Your sign-in expired. Start the connection again from the app.', 401);
  if ((p.get('csrf') || '') !== await csrfToken(sessionIdFrom(request), req)) {
    return errorPage('This approval form is out of date. Start the connection again from the app.', 403);
  }

  if (p.get('decision') !== 'allow') {
    return redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'The member declined', state: req.state, iss: req.iss });
  }

  const granted = req.scopes.filter((s) => s === 'shows:read' || (s === 'shows:write' && p.get('grant_write') === '1'));
  const code = randomToken();
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, member_slug, redirect_uri, code_challenge, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
  ).bind(await sha256Hex(code), req.client.client_id, session.member_slug, req.redirectUri,
    req.challenge, scopeString(granted), `+${CODE_TTL_MINUTES} minutes`).run();

  return redirectWith(req.redirectUri, { code, state: req.state, iss: req.iss });
}

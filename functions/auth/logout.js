async function doLogout(context) {
  const { env, request } = context;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);

  if (match) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(match[1]).run();
  }

  const referer = request.headers.get('Referer');
  let redirect = '/';
  if (referer) {
    try {
      const url = new URL(referer);
      redirect = url.pathname + url.hash;
    } catch {}
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirect,
      'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    },
  });
}

// POST is the canonical logout — the web clients use it. SameSite=Lax sends
// the session cookie on cross-site top-level GET navigations, so a GET-only
// logout can be triggered by any link the member clicks (a harmless but
// annoying forced logout).
export async function onRequestPost(context) {
  return doLogout(context);
}

// GET stays for the shipped iOS/tvOS builds, which call it without any
// custom headers. Native apps aren't reachable by cross-site links, so the
// CSRF concern above doesn't apply to them; app builds after this change can
// move to POST, and this can go once old builds age out.
export async function onRequestGet(context) {
  return doLogout(context);
}

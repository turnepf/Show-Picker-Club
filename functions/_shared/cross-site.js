// Refusing session-minting requests that a browser sent from another site.
//
// Login CSRF (security audit run-2): the auth endpoints parse the body as JSON
// whatever the Content-Type, so another site could auto-submit an
// enctype=text/plain form carrying the attacker's own email and code, and the
// response's Set-Cookie would swap the visitor into the attacker's account.
// SameSite doesn't help here: the request needs no prior cookie.
//
// A browser marks a cross-site request with Sec-Fetch-Site, and sends Origin
// on every POST. Native apps send neither, so they pass. The page's own origin
// is compared to the request's, so local `wrangler pages dev` and preview
// deployments keep working.
export function isCrossSiteBrowserRequest(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return true;
  const origin = request.headers.get('Origin');
  if (origin) {
    try { return origin !== new URL(request.url).origin; } catch { return true; }
  }
  return false;
}

export function crossSiteRefusal(headers = {}) {
  return new Response(JSON.stringify({ error: 'cross_site' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

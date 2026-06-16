const CACHE_NAME = 'shows-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only ever handle same-origin GETs. Cross-origin scripts (Apple's Sign in
  // SDK, Google Tag Manager, the Cloudflare beacon, etc.) and non-GET requests
  // must go straight to the network: intercepting them and falling back to a
  // cache miss returned `null` from respondWith, which killed those script
  // loads — and that's what broke Sign in with Apple (window.AppleID never
  // got defined).
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Don't cache API calls or auth routes.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  event.respondWith(
    fetch(req)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        return response;
      })
      // Offline / network failure: serve the cached copy if we have one, and
      // never resolve to null (which surfaces as a hard load error).
      .catch(() => caches.match(req).then(cached => cached || Response.error()))
  );
});

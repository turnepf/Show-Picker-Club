/*
 * Show Picker Club — service-worker tombstone.
 *
 * The PWA was retired once the native Apple apps shipped. This file is not a
 * service worker any more; it exists only to evict the ones already installed
 * on members' devices.
 *
 * Deleting the file instead would NOT work here. `_redirects` maps `/*` to the
 * SPA shell, so a request for `/sw.js` would come back as index.html — HTTP
 * 200, `text/html`. A 404 tells the browser to unregister the worker, but an
 * HTML 200 just fails the update check on a MIME mismatch and leaves the old
 * worker (and its cache) installed indefinitely. So we serve a worker whose
 * only job is to remove itself.
 *
 * Browsers pick this up on their next update check for the registration —
 * within 24 hours of the member's next visit, per the service-worker spec's
 * cap on reusing a cached worker script. Safe to delete this file once those
 * registrations have drained; until then, leave it in place.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
  })());
});

// Deliberately no `fetch` handler: a worker without one doesn't intercept
// requests, so pages go straight to the network while this drains.

import { networkCatalog } from '../_shared/networks.js';

// GET /api/networks — the network picker, over the wire.
//
// The Apple apps used to hardcode this list, so a network added on the server
// reached a member only when they installed a new App Store build. They now
// read it from here and cache it, which makes adding a network a one-file
// server change that lands on phones already installed.
//
// Deliberately public (named in PUBLIC_ENDPOINTS in scripts/check-static.sh).
// Three reasons, all of which have to hold for a new public endpoint:
//   1. There is no member data in it — not a slug, not a row id, not a count.
//      It is a constant table compiled into the Worker.
//   2. It is already public: public/index.html serves the same brand names in
//      its <select> to anyone who loads the page logged out.
//   3. Gating it would buy nothing and cost something — an app that hasn't
//      signed in yet could never warm its picker, and the edge couldn't cache
//      a response that varies by cookie.
//
// Cached at the edge for an hour, served stale for a day while revalidating:
// the list changes a few times a year, and a member adding a show should never
// wait on this. Clients keep their own copy anyway, so a cache miss during a
// deploy is invisible.
//
// The clients try to pull every time they show a picker rather than once per
// launch — a cached list is the fallback for a failed pull, not a reason to
// skip one — so the repeat request is made as cheap as it can be: the catalog
// version doubles as an ETag, and an unchanged list answers 304 with no body.

function headers(etag) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://showpicker.club',
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    ETag: etag,
  };
}

export async function onRequestGet({ request }) {
  const catalog = networkCatalog();
  const etag = `"${catalog.version}"`;
  // Weak-comparison tolerant: a cache upstream may have weakened it to W/"…".
  const seen = (request?.headers?.get('If-None-Match') || '').replace(/^W\//, '');
  if (seen === etag) {
    return new Response(null, { status: 304, headers: headers(etag) });
  }
  return new Response(JSON.stringify(catalog), { headers: headers(etag) });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

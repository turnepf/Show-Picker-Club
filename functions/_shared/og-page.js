// Link-preview pages.
//
// The three links the apps share — a show, a group invite, a household invite —
// are universal links that iOS already routes into the app (see
// HomeView.route(url:)). This file is not about that tap. When a link is sent
// in Messages, the device makes a plain server-side GET to build the preview
// bubble: no app is involved, and it happens whether or not the recipient has
// the app installed. The bubble is rendered entirely from the Open Graph tags
// in the HTML that GET returns.
//
// So routing is the app's job and presentation is this file's. Before these
// routes existed, every shared link fell through `_redirects`' catch-all to the
// marketing page, whose og:title is the constant "Show Picker Club" and which
// carried no og:image at all — which is why every share, of every show, looked
// identical and had no artwork.
//
// These pages stay deliberately thin. They are preview metadata plus a card for
// whoever opens one without the app; they are NOT a return of the web member
// app (docs/PRODUCT.md#web-app-status). Nothing here needs a session, so
// nothing here may render anything a session would gate — see each caller for
// what it is allowed to say.

export const APP_STORE_URL = 'https://apps.apple.com/app/id6780282764';
export const APP_STORE_ID = '6780282764';
const DEFAULT_IMAGE = 'https://showpicker.club/og-default.png';

// Titles come from TMDB and from members' own typing, so both the text and the
// attribute values are escaped. `"` and `'` matter as much as `<`: these land
// inside content="…" attributes, where an unescaped quote would break out of
// the tag.
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only ever emit an image we constructed or that came from TMDB. A stray
// javascript: or data: value in a row would otherwise be rendered into an
// href/src, and og:image is fetched by other people's clients.
export function safeImageUrl(url) {
  if (typeof url !== 'string') return null;
  return url.startsWith('https://image.tmdb.org/') || url.startsWith('https://showpicker.club/')
    ? url
    : null;
}

// TMDB stores backdrops at w780 and posters at w500 (see _shared/enrichment.js).
// A preview card is rendered large, so ask TMDB for a wider copy of the same
// image — same path, different size segment.
export function upscaleTmdb(url) {
  const safe = safeImageUrl(url);
  if (!safe) return null;
  return safe.replace(/\/t\/p\/w(500|780)\//, '/t/p/w1280/');
}

/**
 * Render a link-preview page.
 *
 * @param {object} opts
 * @param {string} opts.title       og:title — the line the recipient reads.
 * @param {string} opts.description og:description.
 * @param {string} [opts.image]     Absolute artwork URL; falls back to the site default.
 * @param {string} opts.url         Canonical URL of this link (og:url).
 * @param {string} [opts.heading]   Visible heading, when it should differ from og:title.
 * @param {number} [opts.status]    HTTP status (404 for a dead invite).
 * @param {string} [opts.webUrl]    Site-relative path that continues this link in
 *                                  the browser. Only for links the web app can
 *                                  actually finish (invites); omit it and the
 *                                  card stays App-Store-only. Never pass a value
 *                                  built from anything but our own routes.
 * @param {string} [opts.webLabel]  Wording for that link.
 */
export function ogPage({ title, description, image, url, heading, status = 200, webUrl, webLabel = 'Continue in your browser' }) {
  const art = safeImageUrl(image) || DEFAULT_IMAGE;
  // summary_large_image only makes sense with real artwork; a fallback logo
  // reads better in the small card than blown up across the full width.
  const cardType = safeImageUrl(image) ? 'summary_large_image' : 'summary';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">

<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(art)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Show Picker Club">
<meta name="twitter:card" content="${cardType}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(art)}">

<!-- Safari's Open/Get banner. Anyone who has the app taps the link and never
     sees this page; this is for everyone else. -->
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
<link rel="canonical" href="${escapeHtml(url)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #f6f6f8; color: #16161a;
  }
  .card {
    width: 100%; max-width: 460px; background: #fff; border-radius: 16px;
    overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.10);
  }
  .art { display: block; width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #e6e6ea; }
  .body { padding: 20px 22px 24px; }
  h1 { margin: 0 0 8px; font-size: 21px; line-height: 1.25; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: #56565e; }
  a.cta {
    display: block; text-align: center; text-decoration: none; font-weight: 600;
    padding: 13px 18px; border-radius: 11px; background: #16161a; color: #fff;
  }
  .foot { margin: 14px 0 0; font-size: 13px; color: #86868e; text-align: center; }
  .foot a.web { color: inherit; text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d10; color: #f2f2f5; }
    .card { background: #1a1a1f; box-shadow: none; }
    .art { background: #26262c; }
    p { color: #a0a0aa; }
    a.cta { background: #f2f2f5; color: #16161a; }
  }
</style>
</head>
<body>
  <main class="card">
    <img class="art" src="${escapeHtml(art)}" alt="">
    <div class="body">
      <h1>${escapeHtml(heading || title)}</h1>
      <p>${escapeHtml(description)}</p>
      <a class="cta" href="${APP_STORE_URL}">Get Show Picker Club</a>
      <p class="foot">Already have the app? Open this link on your iPhone or iPad.</p>${webUrl ? `
      <p class="foot"><a class="web" href="${escapeHtml(webUrl)}">${escapeHtml(webLabel)}</a></p>` : ''}
    </div>
  </main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Long enough that a link shared to a group chat isn't re-fetched by
      // every recipient's device, short enough that fixing a title doesn't
      // need a cache purge.
      'Cache-Control': 'public, max-age=300',
    },
  });
}

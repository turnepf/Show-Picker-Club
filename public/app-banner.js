/*
 * Show Picker Club — dismissible "get the app" banner.
 *
 * A smart-app-banner-style bar across the top of the web app on Apple
 * devices. iPhone/iPad/Apple TV/Mac ship as ONE universal App Store listing
 * (net.patrickturner.showpickerios), so a single apps.apple.com link is the
 * right link on every device — only the copy is tailored per device.
 * Non-Apple devices, installed-PWA windows, and anyone who has dismissed
 * the banner (localStorage) never see it.
 *
 * **Safari** never sees it either, on iPhone/iPad or the Mac: those pages
 * carry the native <meta name="apple-itunes-app"> Smart App Banner (iOS
 * only), and Safari on every Apple platform also shows its own "Open in
 * app" bar for our universal-link domain when the app is installed —
 * rendering this bar there stacked a second, redundant prompt on top of
 * Apple's. This bar only covers browsers with no native banner:
 * Chrome/Firefox/etc. on iOS, iPadOS, and the Mac.
 *
 * Include with <script src="/app-banner.js" defer></script> — on pages that
 * load shell.js it must come AFTER shell.js so the banner slots into the
 * restructured split-view layout.
 *
 * To turn the banner ON: set APP_STORE_ID to the app's numeric Apple ID
 * (App Store Connect → the app → App Information → "Apple ID"). While it's
 * empty the banner never renders, so this file is safe to deploy before the
 * listing is live.
 */
(function () {
  'use strict';

  var APP_STORE_ID = '6780282764'; // empty string keeps the banner off

  var DISMISS_KEY = 'spc-app-banner-dismissed-v1';

  if (!APP_STORE_ID) return;

  // Installed-PWA windows: no browser chrome, so the bar would collide with
  // the iOS status bar (black-translucent) — and those users already have a
  // home-screen entry point. Skip.
  if ((window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone) return;

  try { if (localStorage.getItem(DISMISS_KEY)) return; } catch (e) { /* private mode */ }

  // iPadOS 13+ reports itself as "Macintosh"; touch points tell it apart.
  var ua = navigator.userAgent || '';
  var device =
    /iPhone|iPod/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' :
    /Macintosh/.test(ua) ? 'Mac' : null;
  if (!device) return;

  // Real Safari — iPhone/iPad *or* Mac — already shows a native "Open in
  // app" bar for our universal-link domain when the app is installed (iOS
  // additionally carries the apple-itunes-app Smart App Banner), so showing
  // ours too stacks a second, redundant prompt on top of Apple's. Every
  // Chromium-family browser (Chrome, Edge, Brave, Opera) stuffs "Safari/"
  // into its UA for legacy compatibility but never sends Safari's own
  // "Version/" token, and iOS's in-app third-party browsers brand
  // themselves (CriOS, FxiOS, EdgiOS, …) — check for both to tell real
  // Safari apart from everything that merely mentions Safari.
  var isAppleSafari = /Safari\//.test(ua) && /Version\//.test(ua) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo/.test(ua);
  if (isAppleSafari) return;

  var CSS =
    '.spc-app-banner { position: relative; z-index: 200; display: flex; align-items: center; gap: 11px; padding: 10px 12px; background: var(--surface, #fff); border-bottom: 1px solid var(--border-soft, #ddd); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif); }' +
    '.spc-ab-close { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; margin-left: -6px; padding: 0; background: none; border: none; border-radius: 50%; font-size: 15px; line-height: 1; color: var(--ink-faint, #999); cursor: pointer; }' +
    '.spc-ab-close:hover { background: var(--surface-2, #eee); }' +
    '.spc-ab-icon { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 9px; border: 1px solid var(--border-soft, #ddd); }' +
    '.spc-ab-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }' +
    '.spc-ab-title { font-size: 14px; font-weight: 600; color: var(--ink, #222); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    '.spc-ab-sub { font-size: 12px; color: var(--ink-quiet, #777); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    '.spc-ab-view { flex: 0 0 auto; padding: 6px 10px; font-size: 15px; font-weight: 600; color: var(--tint, #6D63EB); text-decoration: none; }' +
    '@media (min-width: 1024px) {' +
    /* Match the letterboxed app shell's width instead of the viewport. On
       shell.js pages the banner is a grid item inside the 1180px body
       already; on index.html it's a body child, so cap and center it. */
    '  .spc-app-banner { grid-column: 1 / -1; box-sizing: border-box; width: 100%; max-width: var(--shell-max, 1180px); margin: 0 auto; }' +
    '  body.spc-has-app-banner { grid-template-rows: auto minmax(0, 1fr); }' +
    /* index.html letterboxes its own 100dvh grids — shrink them by the
       banner height so their bottom edge stays on screen. */
    '  body.spc-has-app-banner .home-shell, body.spc-has-app-banner #showPage:not(.hidden) {' +
    '    height: calc(100vh - var(--spc-ab-h, 61px)); height: calc(100dvh - var(--spc-ab-h, 61px));' +
    '  }' +
    '}';

  var el = document.createElement('div');
  el.className = 'spc-app-banner';
  el.setAttribute('role', 'complementary');
  el.setAttribute('aria-label', 'Get the app');
  el.innerHTML =
    '<button type="button" class="spc-ab-close" aria-label="Dismiss">✕</button>' +
    '<img class="spc-ab-icon" src="/favicon.svg" alt="">' +
    '<span class="spc-ab-text">' +
    '<span class="spc-ab-title">Show Picker Club</span>' +
    '<span class="spc-ab-sub">Now on the App Store for ' + device + '</span>' +
    '</span>' +
    '<a class="spc-ab-view" href="https://apps.apple.com/app/id' + APP_STORE_ID +
    '" target="_blank" rel="noopener">View</a>';

  function insert() {
    var body = document.body;
    if (!body || document.querySelector('.spc-app-banner')) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Pages with padded bodies (secondary pages on small screens): run the
    // bar full-bleed by cancelling the padding, and give the top pad back
    // below the bar so the page's own spacing is preserved.
    var cs = getComputedStyle(body);
    if (parseFloat(cs.paddingLeft) || parseFloat(cs.paddingRight)) {
      el.style.marginLeft = '-' + cs.paddingLeft;
      el.style.marginRight = '-' + cs.paddingRight;
    }
    if (parseFloat(cs.paddingTop)) {
      el.style.marginTop = '-' + cs.paddingTop;
      el.style.marginBottom = cs.paddingTop;
    }

    body.insertBefore(el, body.firstChild);
    body.classList.add('spc-has-app-banner');
    document.documentElement.style.setProperty('--spc-ab-h', el.offsetHeight + 'px');

    el.querySelector('.spc-ab-close').addEventListener('click', function () {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
      el.remove();
      body.classList.remove('spc-has-app-banner');
      if (typeof gtag === 'function') gtag('event', 'app_banner_dismiss', { platform: device });
    });
    el.querySelector('.spc-ab-view').addEventListener('click', function () {
      if (typeof gtag === 'function') gtag('event', 'app_banner_click', { platform: device });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }
})();

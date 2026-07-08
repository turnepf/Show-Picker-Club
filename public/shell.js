/*
 * Show Picker Club — shared iPad-style sidebar shell.
 *
 * Secondary pages (What's New, Subscriptions, Vibe, Reporting) include this
 * with <script src="/shell.js" defer></script>. On ≥1024px screens it wraps
 * the page in the same letterboxed split view as the main app: the sidebar
 * (My Shows lists, What's New, Trending, Members) on the left, the page
 * itself as the detail column. Small screens are untouched — the sidebar
 * stays hidden and the page keeps its own single-column layout.
 *
 * The main app (index.html) has its own built-in sidebar and does NOT load
 * this file.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SPRITE =
    '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
    '<symbol id="s-person" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="9.6" r="3.1"/><path d="M5.9 18.9C7.3 15.9 9.4 14.7 12 14.7s4.7 1.2 6.1 4.2" stroke-linecap="round"/></g></symbol>' +
    '<symbol id="s-person-plus" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20.8 13.2A8.7 8.7 0 1 1 12.6 3.3"/><circle cx="11.7" cy="10" r="3"/><path d="M5.9 18.7c1.3-2.7 3.3-3.8 5.8-3.8 2.4 0 4.4 1.1 5.7 3.7"/><path d="M18.6 3.4v5M16.1 5.9h5"/></g></symbol>' +
    '<symbol id="s-sparkles" viewBox="0 0 24 24"><g fill="currentColor"><path d="M9.5 6.5 11.1 11 15.5 12.6 11.1 14.2 9.5 18.7 7.9 14.2 3.5 12.6 7.9 11Z"/><path d="M17.5 3 18.4 5.6 21 6.5 18.4 7.4 17.5 10 16.6 7.4 14 6.5 16.6 5.6Z"/><path d="M17.8 13.6 18.5 15.5 20.4 16.2 18.5 16.9 17.8 18.8 17.1 16.9 15.2 16.2 17.1 15.5Z"/></g></symbol>' +
    '<symbol id="s-wrench" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></symbol>' +
    '<symbol id="s-flame" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 3c.8 2.6 2.6 4.3 3.9 6.2 1.2 1.8 1.8 3.5 1.8 5.2 0 3.5-2.5 6.1-5.7 6.1s-5.7-2.6-5.7-6.1c0-2.2 1-4 2.3-5.5.4 1.1 1.1 2 2.1 2.4-.3-2.8.3-5.9 1.3-8.3z"/></symbol>' +
    '<symbol id="s-play-circle" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M10.1 8.6 15.4 12 10.1 15.4Z"/></g></symbol>' +
    '<symbol id="s-hourglass" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M7.2 3.5h9.6M7.2 20.5h9.6M8.4 3.5v2.6c0 2.4 3.6 3.5 3.6 5.9 0-2.4 3.6-3.5 3.6-5.9V3.5M8.4 20.5v-2.6c0-2.4 3.6-3.5 3.6-5.9 0 2.4 3.6 3.5 3.6 5.9v2.6"/></symbol>' +
    '<symbol id="s-thumbsup" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></symbol>' +
    '<symbol id="s-text-plus" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 6.5h9M3.5 12h13M3.5 17.5h13"/><path d="M18.5 3.9v5M16 6.4h5"/></g></symbol>' +
    '<symbol id="s-chevron-right" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M9 5.5 15.7 12 9 18.5"/></symbol>' +
    '<symbol id="s-logout" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5H7.8A1.8 1.8 0 0 0 6 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8h5.7M10.5 12h10M17 8.5 20.5 12 17 15.5"/></symbol>' +
    '<symbol id="s-creditcard" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.8" y="5.5" width="18.4" height="13" rx="2.2"/><path d="M2.8 9.8h18.4" stroke-width="2.2"/></g></symbol>' +
    '</svg>';

  var CSS =
    /* App tint fallback for pages that don't define it (admin pages). */
    ':root { --tint: #6D63EB; }' +
    '@media (prefers-color-scheme: dark) { :root { --tint: #8D87F5; } }' +
    '.shell-side { display: none; }' +
    '@media (min-width: 1024px) {' +
    '  html { background: var(--body); }' +
    /* Letterboxed split view: sidebar + this page as one centered shell. */
    '  body {' +
    '    display: grid; grid-template-columns: 300px minmax(0, 1fr);' +
    '    max-width: 1180px; margin: 0 auto; padding: 0;' +
    '    height: 100vh; height: 100dvh; overflow: hidden;' +
    '    background: var(--surface-2);' +
    '    border-left: 1px solid var(--border-soft);' +
    '    border-right: 1px solid var(--border-soft);' +
    '  }' +
    '  .shell-side { display: block; overflow-y: auto; padding: 0 14px 24px; border-right: 1px solid var(--border-soft); }' +
    '  .shell-detail { overflow-y: auto; min-width: 0; padding: var(--shell-page-pad, 0); }' +
    /* The sidebar owns navigation, so a page's own top pill nav / back
       link is redundant on the split view and bows out. */
    '  .shell-detail .admin-nav { display: none; }' +
    '  .shell-detail .topbar a.back, .shell-detail .header-top a.back { display: none; }' +
    /* The page title is absolutely positioned (an iOS-nav centering trick
       against the back link). With the back link hidden the bar has no
       in-flow content and collapses to its padding, so following content
       slides under it. Return the title to normal flow, centered, so the
       bar keeps its full height. */
    '  .shell-detail .topbar h1, .shell-detail .header-top h1 { position: static; transform: none; flex: 1; text-align: center; }' +
    /* The .topbar pages pull the sticky bar up 24px (to cancel the standalone
       body padding). Inside the padded detail column that negative margin
       offsets the painted bar from where content flows, so the row below
       tucks under it — drop it; the sticky bar still pins flush when scrolled. */
    '  .shell-detail .topbar { margin-top: 0; }' +
    '}' +
    '.shell-titlebar { display: flex; align-items: center; gap: 4px; padding: 12px 0; }' +
    '.shell-title { flex: 1; min-width: 0; font-family: var(--font-sans); font-size: 20px; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    '.shell-title a { color: inherit; text-decoration: none; }' +
    '.shell-side .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: 0 0 auto; background: none; border: none; padding: 0; color: var(--tint); cursor: pointer; border-radius: 50%; }' +
    '.shell-side .icon-btn:hover { background: color-mix(in srgb, var(--tint) 10%, transparent); }' +
    '.shell-side .ic { width: 23px; height: 23px; flex: 0 0 auto; }' +
    '.shell-side .ios-group { background: var(--surface); border-radius: 12px; overflow: hidden; margin-bottom: 22px; box-shadow: 0 1px 3px oklch(0.18 0.03 50 / 0.06); }' +
    '.shell-side .ios-group-header { font-size: 13px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-quiet); padding: 0 16px 7px; margin-top: 2px; }' +
    '.shell-side .ios-item { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 10px 14px; background: none; border: none; font-family: var(--font-sans); font-size: 16px; line-height: 1.3; text-align: left; color: var(--ink); text-decoration: none; cursor: pointer; box-sizing: border-box; }' +
    '.shell-side .ios-item + .ios-item::after { content: ""; position: absolute; left: 48px; right: 0; top: 0; height: 1px; background: var(--border-soft); }' +
    '.shell-side .ios-item.no-icon + .ios-item.no-icon::after { left: 14px; }' +
    '.shell-side .ios-item-icon { display: inline-flex; color: var(--tint); }' +
    '.shell-side .ios-item-icon .ic { width: 22px; height: 22px; }' +
    '.shell-side .ios-item-label { flex: 1; min-width: 0; }' +
    '.shell-side .ios-item-detail { color: var(--ink-quiet); font-size: 13px; white-space: nowrap; }' +
    '.shell-side .ios-item-chev { width: 15px; height: 15px; color: var(--ink-faint); }' +
    '.shell-side .ios-item.selected { background: var(--tint); color: #fff; }' +
    '.shell-side .ios-item.selected .ios-item-icon { color: #fff; }' +
    '.shell-side .shell-members { max-height: 250px; overflow-y: auto; }' +
    /* Admin accordion: the wrench row toggles an indented sub-list. */
    '.shell-side .shell-admin-toggle .ios-item-chev { transition: transform 0.15s ease-out; }' +
    '.shell-side .shell-admin-toggle.open .ios-item-chev { transform: rotate(90deg); }' +
    '.shell-admin-sub { border-top: 1px solid var(--border-soft); }' +
    '.shell-admin-sub .ios-item { padding-left: 48px; min-height: 40px; font-size: 15px; }' +
    '.shell-admin-sub .ios-item + .ios-item::after { left: 48px; }' +
    '.shell-side .ios-footnote { font-size: 12px; color: var(--ink-quiet); line-height: 1.5; padding: 0 16px; margin: -10px 0 22px; }' +
    '.shell-menu { position: fixed; z-index: 500; min-width: 180px; background: var(--surface); border-radius: 13px; box-shadow: 0 10px 40px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.12); padding: 4px 0; overflow: hidden; }' +
    '.shell-menu button { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 11px 16px; background: none; border: none; font-family: var(--font-sans); font-size: 16px; color: var(--danger); cursor: pointer; }' +
    '.shell-menu button:hover { background: var(--surface-2); }' +
    '.shell-menu .ic { width: 19px; height: 19px; }';

  var LISTS = [
    { list: 'watching', label: 'Watching', icon: 'play-circle' },
    { list: 'waiting', label: 'Awaiting', icon: 'hourglass' },
    { list: 'recommending', label: 'Recommending', icon: 'thumbsup' },
    { list: 'next', label: 'Up Next', icon: 'text-plus' },
  ];

  // Operator pages, in the same order as the old top pill nav (Reporting
  // added; it lives under Admin on iOS).
  var ADMIN_PAGES = [
    { href: '/admin', label: 'Overview' },
    { href: '/members', label: 'Members' },
    { href: '/url-cleanup', label: 'URL cleanup' },
    { href: '/vibe-admin', label: 'Vibe admin' },
    { href: '/reporting', label: 'Reporting' },
  ];

  function iconRow(href, label, icon, opts) {
    opts = opts || {};
    return '<a class="ios-item' + (opts.selected ? ' selected' : '') + '" href="' + esc(href) + '">' +
      '<span class="ios-item-icon"><svg class="ic"><use href="#s-' + icon + '"/></svg></span>' +
      '<span class="ios-item-label">' + esc(label) + '</span></a>';
  }

  function memberRow(m) {
    var label = m.display_name || m.first_name || (m.name || '').split(' ')[0];
    var active = (m.watching_count || 0) + (m.recommending_count || 0) + (m.next_count || 0);
    var detail = active > 0 ? '<span class="ios-item-detail">' + active + ' active</span>' : '';
    return '<a class="ios-item no-icon" href="/' + esc(m.slug) + '">' +
      '<span class="ios-item-label">' + esc(label) + '</span>' + detail +
      '<svg class="ic ios-item-chev"><use href="#s-chevron-right"/></svg></a>';
  }

  var authMember = null;
  var menuEl = null;

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    document.removeEventListener('click', onOutside);
  }
  function onOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

  function accountTapped(btn) {
    if (!authMember) { location.href = '/?home'; return; }
    if (menuEl) { closeMenu(); return; }
    var menu = document.createElement('div');
    menu.className = 'shell-menu';
    var item = document.createElement('button');
    item.type = 'button';
    item.innerHTML = 'Log out <svg class="ic"><use href="#s-logout"/></svg>';
    item.addEventListener('click', function () {
      closeMenu();
      fetch('/auth/logout', { redirect: 'manual' }).catch(function () {}).finally(function () { location.reload(); });
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, r.right - 180) + 'px';
    menuEl = menu;
    setTimeout(function () { document.addEventListener('click', onOutside); }, 0);
  }

  function init() {
    var body = document.body;
    if (!body || document.querySelector('.shell-side')) return;

    // Preserve the page's own body padding as the detail column's padding
    // (topbars use matching negative margins to run full-bleed).
    var pad = getComputedStyle(body).padding;
    document.documentElement.style.setProperty('--shell-page-pad', pad);

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Move the page into the detail column.
    var detail = document.createElement('div');
    detail.className = 'shell-detail';
    while (body.firstChild) detail.appendChild(body.firstChild);

    var side = document.createElement('aside');
    side.className = 'shell-side';
    side.innerHTML =
      '<div class="shell-titlebar">' +
      '<h1 class="shell-title"><a href="/?home">Show Picker Club</a></h1>' +
      '<button class="icon-btn" type="button" title="Account" aria-label="Account"><svg class="ic"><use href="#s-person"/></svg></button>' +
      '</div>' +
      '<div class="shell-groups"><div class="ios-group">' +
      iconRow('/?home', 'Log in to see your shows', 'person-plus') +
      iconRow('/whats-new', "What's New", 'sparkles', { selected: location.pathname === '/whats-new' }) +
      '</div></div>';

    var sprite = document.createElement('div');
    sprite.innerHTML = SPRITE;

    body.appendChild(sprite.firstChild);
    body.appendChild(side);
    body.appendChild(detail);
    side.querySelector('.icon-btn').addEventListener('click', function (e) { accountTapped(e.currentTarget); });

    // Fill in auth-dependent groups + the member roster.
    Promise.all([
      fetch('/auth/check').then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch('/api/members').then(function (r) { return r.json(); }).catch(function () { return {}; }),
    ]).then(function (res) {
      var auth = res[0] || {};
      var members = (res[1] && res[1].members) || [];
      if (auth.authenticated && auth.member) authMember = auth.member;

      var html = '';
      if (authMember) {
        html += '<h3 class="ios-group-header">My Shows</h3><div class="ios-group">' +
          LISTS.map(function (l) { return iconRow('/' + authMember + '#' + l.list, l.label, l.icon); }).join('') +
          iconRow('/whats-new', "What's New", 'sparkles', { selected: location.pathname === '/whats-new' }) +
          iconRow('/subscriptions', 'Subscription audit', 'creditcard', { selected: location.pathname === '/subscriptions' }) +
          '</div>';
      } else {
        html += '<div class="ios-group">' +
          iconRow('/?home', 'Log in to see your shows', 'person-plus') +
          iconRow('/whats-new', "What's New", 'sparkles', { selected: location.pathname === '/whats-new' }) +
          '</div>';
      }
      if (auth.is_admin) {
        // Accordion: expanded automatically on an admin page, with the
        // current page highlighted; the wrench row toggles it elsewhere.
        var onAdminPage = ADMIN_PAGES.some(function (p) { return p.href === location.pathname; });
        var subRows = ADMIN_PAGES.map(function (p) {
          return '<a class="ios-item no-icon' + (p.href === location.pathname ? ' selected' : '') + '" href="' + p.href + '">' +
            '<span class="ios-item-label">' + esc(p.label) + '</span></a>';
        }).join('');
        html += '<div class="ios-group">' +
          '<button class="ios-item shell-admin-toggle' + (onAdminPage ? ' open' : '') + '" type="button">' +
          '<span class="ios-item-icon"><svg class="ic"><use href="#s-wrench"/></svg></span>' +
          '<span class="ios-item-label">Admin</span>' +
          '<svg class="ic ios-item-chev"><use href="#s-chevron-right"/></svg>' +
          '</button>' +
          '<div class="shell-admin-sub"' + (onAdminPage ? '' : ' hidden') + '>' + subRows + '</div>' +
          '</div>';
      }
      html += '<div class="ios-group">' + iconRow('/?home', 'Trending', 'flame') + '</div>';
      if (members.length) {
        // Most recently active first — the sidebar roster order.
        var sorted = members.slice().sort(function (a, b) {
          var la = a.last_activity_at || '', lb = b.last_activity_at || '';
          if (la !== lb) return la > lb ? -1 : 1;
          return 0;
        });
        html += '<h3 class="ios-group-header">Members</h3><div class="ios-group shell-members">' +
          sorted.map(memberRow).join('') + '</div>';
      }
      html += '<p class="ios-footnote">Ratings and metadata from IMDb (via OMDb) and TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>';
      side.querySelector('.shell-groups').innerHTML = html;

      var adminToggle = side.querySelector('.shell-admin-toggle');
      if (adminToggle) {
        adminToggle.addEventListener('click', function () {
          var sub = side.querySelector('.shell-admin-sub');
          var open = adminToggle.classList.toggle('open');
          if (sub) sub.hidden = !open;
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

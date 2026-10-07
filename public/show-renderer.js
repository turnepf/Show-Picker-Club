/*
 * Shared show card and list rendering for the entire app.
 * Used by index.html and groups.html to ensure consistent UI everywhere.
 */

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, c => map[c]);
}

function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : '';
  } catch { return ''; }
}

function seasonsText(show) {
  if (!show || show.movie) return '';
  const n = show.seasons_released;
  if (typeof n !== 'number' || n <= 0) return '';
  const seasonsPart = `${n} Season${n === 1 ? '' : 's'}`;
  return show.full_series ? `${seasonsPart}, Complete` : seasonsPart;
}

// "2026-10-03" → a local date. `new Date('2026-10-03')` reads the string as
// UTC midnight, which is the previous evening anywhere west of Greenwich —
// every US member saw each premiere a day early.
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}

function formatSeasonRange(show) {
  if (!show || !show.next_season_date) return '';
  const date = parseYmd(show.next_season_date);
  const opts = { month: 'short', day: 'numeric' };
  return date.toLocaleDateString('en-US', opts);
}

/*
 * Render a single show card row.
 * Options:
 *   onClickId: function(showId) called when card is clicked
 *   showRating: boolean, show star rating
 *   showChevron: boolean, show right chevron (default true)
 *   showDragHandle: boolean, show drag handle instead of chevron
 *   caption: string override (otherwise built from network + context)
 *   currentTab: string, name of current tab (affects caption, e.g. 'next' shows recommender)
 *   prefixHtml: markup placed before the poster (cross-library search's "+")
 *   extraHtml: markup placed under the text lines (rate-backlog's tap-row)
 */
function renderShowCard(show, options = {}) {
  options = options || {};
  const { onClickId, showRating = true, showChevron = true, showDragHandle = false, caption, currentTab, prefixHtml = '', extraHtml = '', rowMenu = false } = options;

  const rating = (showRating && show.rating)
    ? `<span class="show-rating"><span class="star">&#9733;</span>${escapeHtml(show.rating)}</span>`
    : '';

  const series = show.full_series ? ' <span title="Series Complete">🎬</span>' : '';
  const movieTag = show.movie ? ' <span class="show-movie">(Movie)</span>' : '';

  const captionParts = caption ? [caption] : [];
  if (!caption) {
    if (show.network) captionParts.push(escapeHtml(show.network));
    if (currentTab === 'next' && show.recommended_by) captionParts.push(`rec'd by ${escapeHtml(show.recommended_by)}`);
  }
  const captionHtml = captionParts.length ? `<div class="show-sub">${captionParts.join(' · ')}</div>` : '';

  let dateLine = '';
  const seasons = seasonsText(show);
  if (show.next_season_date) {
    dateLine = `<div class="show-sub">Next episode: ${formatSeasonRange(show)}${seasons ? ` · ${seasons}` : ''}</div>`;
  } else if (seasons) {
    dateLine = `<div class="show-sub">${seasons}</div>`;
  }

  const poster = show.poster_url
    ? `<img class="row-poster" src="${safeUrl(show.poster_url)}" alt="" loading="lazy">`
    : `<div class="row-poster row-poster-empty">🎬</div>`;

  // ⋯ opens the row's quick actions (moves, Edit, Archive) — the web's
  // stand-in for iOS's swipe actions. Only on the member's own rows; the page
  // supplies openRowMenu(). stopPropagation keeps the row from opening.
  const menuButton = rowMenu
    ? `<button type="button" class="row-menu-btn" aria-label="Actions for ${escapeHtml(show.title)}" onclick="event.stopPropagation(); openRowMenu(${Number(show.id)}, this)">&#8943;</button>`
    : '';
  const rightElement = showDragHandle
    ? `<span class="drag-handle" title="Drag to reorder">&#x2630;</span>`
    : (menuButton || (showChevron ? `<span class="ios-row-chevron">&#8250;</span>` : ''));

  const clickHandler = onClickId ? `onclick="__showRendererClick(${show.id})"` : '';

  return `
    <div class="show ios-row" id="row-${show.id}" ${clickHandler}>
      <div class="ios-row-main">
        ${prefixHtml}
        ${poster}
        <div class="ios-row-text">
          <div class="ios-row-title">${escapeHtml(show.title)}${series}${movieTag}</div>
          ${captionHtml}
          ${dateLine}
          ${extraHtml}
        </div>
        ${rating}
        ${rightElement}
      </div>
    </div>`;
}

/*
 * Render a list of shows.
 * Options:
 *   onClickId: function(showId) called when a card is clicked
 *   showRating: boolean
 *   showChevron: boolean
 *   showDragHandle: boolean
 *   currentTab: string
 *   showFooter: boolean (show legend + network counts)
 *   canDrag: boolean (enables drag mode)
 *   owners: string (name for "shown in X's order" message)
 */
function renderShowList(shows, options = {}) {
  if (!shows || shows.length === 0) {
    return '<div style="text-align: center; padding: 40px 20px; color: var(--ink-muted);">No shows</div>';
  }

  options = options || {};
  const { onClickId, showRating = true, showChevron = true, showDragHandle = false, currentTab, showFooter = false, canDrag = false, owners = '', rowMenu = false } = options;

  let html = '';

  // Drag hint for manual sort
  if (canDrag) {
    html += `<div class="drag-hint">My Order — press the ☰ handle and drag a show up or down. Your order is saved.</div>`;
  } else if (showDragHandle) {
    html += `<div class="drag-hint">Shown in ${escapeHtml(owners)}'s own order.</div>`;
  }

  // Ratings callout (own Watching list only)
  if (currentTab === 'watching' && !showDragHandle) {
    html += `<div class="list-announce">★ New: tap a show to rate it.</div>`;
  }

  // Render cards
  html += shows.map(show => renderShowCard(show, {
    onClickId,
    showRating,
    showChevron: showChevron && !showDragHandle,
    showDragHandle,
    currentTab,
    rowMenu: rowMenu && !showDragHandle,
  })).join('');

  // Footer: legend + network counts
  if (showFooter) {
    const hasFullSeries = shows.some(s => s.full_series);
    const networkCounts = {};
    shows.forEach(s => {
      if (!s.network) return;
      networkCounts[s.network] = (networkCounts[s.network] || 0) + 1;
    });
    const countsHtml = Object.entries(networkCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${escapeHtml(n)} (${c})`)
      .join(' &middot; ');
    const legendParts = [];
    if (hasFullSeries) legendParts.push('🎬 Series Complete');
    const legend = legendParts.join(' | ');
    if (legend) html += `<div class="network-counts">${legend}</div>`;
    if (countsHtml) html += `<div class="network-counts">${countsHtml}</div>`;
  }

  return html;
}

/*
 * Global click handler for show cards.
 * The calling code should set window.__showRendererClickHandler
 */
function __showRendererClick(showId) {
  if (typeof window.__showRendererClickHandler === 'function') {
    window.__showRendererClickHandler(showId);
  }
}

/* ── Show detail ───────────────────────────────────────────────────
 * The detail screen is one card everywhere it appears — the main app's
 * pushed detail view and the in-page stack on the groups page (group →
 * member → show). Both call renderShowDetailBody(), so the two can't
 * drift apart. The page supplies the member-specific bits through opts;
 * the handlers the markup calls (detailChip, detailRate, and — only when
 * showActions is set — detailEdit/detailArchive) are page globals.
 */

function detailRow(k, v) {
  return `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

/* A network_url pointing at a service's search results is a placeholder,
 * not a deep link — the app treats those as missing everywhere. */
function detailRealUrl(url) {
  return !!url && !url.includes('/search') && !url.includes('/s?')
    && !url.includes('?q=') && !url.includes('?query=') && url !== '#';
}

function runtimeText(min) {
  const n = parseInt(min, 10);
  if (!n) return '';
  const h = Math.floor(n / 60), m = n % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/* 10-segment tap-row: tap a position and it saves instantly (detailRate). */
function ratingTapRow(value, season) {
  const seasonArg = season === null ? 'null' : season;
  let segs = '';
  for (let i = 1; i <= 10; i++) {
    segs += `<div class="rating-seg${value && i <= value ? ' filled' : ''}" onclick="detailRate(${i}, ${seasonArg})"></div>`;
  }
  return `<div class="rating-row">${segs}</div>`;
}

/*
 * TMDB's status as the detail card words it, or '' for no row: not stored
 * yet, or a released film (every film on a list is). Same wording as
 * Show.statusText in ShowPickerCore; an unrecognised word shows as written.
 */
function detailStatusText(raw) {
  const s = String(raw || '').trim();
  switch (s.toLowerCase()) {
    case '': case 'released': return '';
    case 'returning series': return 'Returning';
    case 'ended': return 'Ended';
    case 'canceled': case 'cancelled': return 'Canceled';
    case 'in production': return 'In production';
    case 'post production': return 'Post-production';
    case 'planned': case 'pilot': case 'rumored': return 'Planned';
    default: return s;
  }
}

/*
 * The "Also on" / "Now on" row, or null. Port of Show.streamingNote: the
 * member's network is their record and is never corrected, so this says
 * what TMDB reports today beside it. An empty or missing streaming_on says
 * nothing — "asked, none" and "never asked" must read alike.
 */
function detailStreamingRow(show) {
  const services = String(show.streaming_on || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!services.length) return null;
  const mine = String(show.network || '').trim().toLowerCase();
  if (mine && services.some(x => x.toLowerCase() === mine)) {
    const others = services.filter(x => x.toLowerCase() !== mine);
    return others.length ? { label: 'Also on', services: others.join(', ') } : null;
  }
  return { label: 'Now on', services: services.join(', ') };
}

/* Production language spelled out, only when it isn't English. */
function detailLanguageText(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c || c === 'en') return '';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c);
    if (!name || name.toLowerCase() === c) return '';
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return ''; }
}

/*
 * Share a show: the /show/<id> link whose preview card names the show
 * (functions/show/[id].js), same URL the iOS share sheet sends. Uses the
 * browser's share sheet where there is one, else copies the link.
 */
async function shareShow(id, title) {
  const url = `https://showpicker.club/show/${encodeURIComponent(id)}?title=${encodeURIComponent(title || '')}`;
  const text = `Check out ${title} — from Show Picker Club`;
  if (navigator.share) {
    try { await navigator.share({ title: `${title} on Show Picker Club`, text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert('Link copied');
  } catch {
    prompt('Copy this link:', url);
  }
}

/*
 * Recommend to group — iOS's flow: pick the group (skipped when there's only
 * one), add an optional note the whole group sees, send. Pages set
 * window.__recommendGroups to the member's groups ([{id, name}]) and pass the
 * same array as the `groups` option so the button only appears with one.
 */
function pickerDialog(title, bodyHtml, buttons) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'sp-dialog';
    d.innerHTML = `<form method="dialog"><h2>${title}</h2>${bodyHtml}<div class="sp-dialog-buttons">${
      buttons.map(b => `<button value="${escapeHtml(b.value)}"${b.primary ? ' class="primary"' : ''}>${escapeHtml(b.label)}</button>`).join('')
    }</div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const input = d.querySelector('input,textarea');
      resolve({ value: d.returnValue, text: input ? input.value : '' });
      d.remove();
    });
    d.showModal();
  });
}

async function recommendToGroup(myCopyId) {
  const groups = window.__recommendGroups || [];
  if (!groups.length) return;
  let group = groups[0];
  if (groups.length > 1) {
    const pick = await pickerDialog('Recommend to which group?', '',
      [...groups.map(g => ({ label: g.name, value: String(g.id) })), { label: 'Cancel', value: '' }]);
    group = groups.find(g => String(g.id) === pick.value);
    if (!group) return;
  }
  const ask = await pickerDialog(`Recommend to ${escapeHtml(group.name)}`,
    `<p>Everyone in ${escapeHtml(group.name)} gets a pop-up with Dismiss or Add to Next Up. The note is visible to the whole group.</p>
     <input type="text" maxlength="500" placeholder="Add a note (optional)">`,
    [{ label: 'Cancel', value: '' }, { label: 'Recommend', value: 'go', primary: true }]);
  if (ask.value !== 'go') return;
  const note = ask.text.trim();
  try {
    const res = await fetch(`/api/groups/${group.id}/suggestions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { show_id: myCopyId, note } : { show_id: myCopyId }),
    });
    if (res.status === 429) { alert('You’ve hit today’s limit for this group — try again tomorrow.'); return; }
    if (res.status === 401) { alert('Your session expired — sign in again.'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    alert(`It's on ${group.name}'s Watch Next board — everyone gets asked about it next time they visit the group.`);
  } catch (e) {
    alert('Couldn’t recommend. Please try again.');
  }
}

const DETAIL_ALL_LISTS = ['watching', 'waiting', 'recommending', 'next'];
const DETAIL_LIST_LABELS = { watching: 'Watching', waiting: 'Awaiting', recommending: 'Loved', next: 'Next Up' };
const DETAIL_CHIP_COLORS = {
  watching: 'var(--list-watching)', waiting: 'var(--list-waiting)',
  recommending: 'var(--list-recommending)', next: 'var(--accent)',
};

/*
 * Render the whole detail body for a show.
 * Options:
 *   actors:      [{ name, imdb_id, character }] cast, in billing order
 *   groupWatchers: [{ slug, name }] group-mates with it on Watching
 *   creators:    [{ name, imdb_id }] the creator/director credit as people
 *   loggedIn:    boolean — gates the My Lists card
 *   myCopy:      my own row for this title (active or archived), or null
 *   ratings:     { average, count, seasons, mine, mineSeasons, owner,
 *                  ownerSeasons, ownerName } from GET /api/shows/:id
 *   showActions: boolean — include Archive in My Lists (main app only)
 *
 * Watching With and Notes on my own active copy are edited right on the
 * card — there's no edit screen — on every page that renders one; see
 * detailMemoSave below.
 */
function renderShowDetailBody(show, options = {}) {
  const {
    actors = [], loggedIn = false, myCopy = null, ratings = null,
    listLabels = DETAIL_LIST_LABELS, allLists = DETAIL_ALL_LISTS, showActions = false,
    groupWatchers = [], creators = [], groups = [],
  } = options || {};
  if (!show) return '';

  // Title lives in the nav bar above the image — no redundant "Title" row.
  // The top card leads with who else is watching, where to watch + the
  // trailer, then Cast, then the rest of the metadata below — the same
  // order as the iOS card.
  const topRows = [];
  // Group-mates with this title on Watching, first names only (that's all
  // GET /api/shows/:id sends). Social context before the "go watch it" rows.
  if (groupWatchers.length) {
    topRows.push(detailRow('Also watching', escapeHtml(groupWatchers.map(w => w.name).join(', '))));
  }
  if (show.network) {
    // The service name itself is the link, as on iOS, so this row and the
    // "Also on" / "Now on" row under it read in parallel.
    topRows.push(detailRow('Network', detailRealUrl(show.network_url)
      ? `<a href="${safeUrl(show.network_url)}" target="_blank" rel="noopener">${escapeHtml(show.network)}</a>`
      : (show.watch_link
          ? `${escapeHtml(show.network)} · <a href="${safeUrl(show.watch_link)}" target="_blank" rel="noopener">Where to watch</a>`
          : escapeHtml(show.network))));
  } else if (show.watch_link) {
    // No service to name, but TMDB's watch page still answers the question.
    topRows.push(detailRow('Network', `<a href="${safeUrl(show.watch_link)}" target="_blank" rel="noopener">Where to watch</a>`));
  }
  // Where TMDB says it streams now, beside the member's own network rather
  // than replacing it (docs/INVARIANTS.md §20). Same rule as
  // Show.streamingNote: "Also on" when their service is among them, "Now on"
  // when it isn't, nothing when TMDB named none or was never asked.
  {
    const note = detailStreamingRow(show);
    if (note) topRows.push(detailRow(note.label, escapeHtml(note.services)));
  }
  // Free / free-with-ads services (migration 073), minus the member's own
  // network, which the row above already names. No row until enrichment has
  // stored them — '' (asked, none) and null (never asked) read alike.
  {
    const mine = String(show.network || '').trim().toLowerCase();
    const free = String(show.free_on || '').split(',').map(x => x.trim())
      .filter(x => x && x.toLowerCase() !== mine);
    if (free.length) topRows.push(detailRow('Free on', escapeHtml(free.join(', '))));
  }
  // The title's IMDb page, once its id is stored. Only the tt… shape, since
  // it goes into a URL.
  if (/^tt\d+$/.test(show.imdb_id || '')) {
    topRows.push(detailRow('IMDb', `<a href="https://www.imdb.com/title/${show.imdb_id}/" target="_blank" rel="noopener">View on IMDb</a>`));
  }
  if (show.trailer_key) {
    topRows.push(detailRow('Trailer', `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(show.trailer_key)}" target="_blank" rel="noopener">▶ Watch trailer</a>`));
  }

  // Catalog rows. The list and the member-edited fields (recommender,
  // watching-with, notes) live in the My Lists card instead — they're
  // member specific, not catalog data.
  const rows = [];
  if (show.movie) rows.push(detailRow('Type', 'Movie'));
  if (show.release_year) rows.push(detailRow('Year', escapeHtml(String(show.release_year))));
  {
    // "4 Seasons · 19 Episodes, Complete", or just "2 Seasons" while it's
    // still running (or just "Complete" when the count is unknown). Same as
    // Show.seriesText.
    const n = show.seasons_released;
    const e = show.episodes_released;
    const seriesParts = [];
    if (typeof n === 'number' && n > 0) {
      let count = `${n} Season${n === 1 ? '' : 's'}`;
      if (typeof e === 'number' && e > 0) count += ` · ${e} Episode${e === 1 ? '' : 's'}`;
      seriesParts.push(count);
    }
    if (show.full_series) seriesParts.push('Complete');
    if (seriesParts.length) rows.push(detailRow('Series', escapeHtml(seriesParts.join(', '))));
  }
  {
    const status = detailStatusText(show.tmdb_status);
    if (status) rows.push(detailRow('Status', escapeHtml(status)));
  }
  if (show.genres) rows.push(detailRow('Genres', escapeHtml(show.genres)));
  if (show.runtime) rows.push(detailRow('Runtime', escapeHtml(runtimeText(show.runtime))));
  if (show.next_season_date) {
    rows.push(detailRow('Next episode', escapeHtml(formatSeasonRange(show))));
  } else if (show.season_end_date) {
    // Mid-season: no premiere ahead, but the finale date is known.
    const end = parseYmd(show.season_end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    rows.push(detailRow('Next episode', escapeHtml(`through ${end}`)));
  }
  if (show.content_rating) rows.push(detailRow('Rated', escapeHtml(show.content_rating)));
  {
    // Only for non-English titles — a "Language: English" row on nearly
    // every card would tell nobody anything. Same as originalLanguageText.
    const lang = detailLanguageText(show.original_language);
    if (lang) rows.push(detailRow('Language', escapeHtml(lang)));
  }

  // Creator/Director is a standard label/value row grouped in the Cast card.
  // Link a single-person credit to their IMDB page (mirrors the cast links);
  // a multi-creator credit (comma in the name) stays plain so the whole list
  // doesn't point at just the first person.
  //
  // When GET /api/shows/:id resolved the credit into people (`creators`),
  // each co-creator links on their own — the one stored id belongs to the
  // first name, so linking the joined string pointed everyone at one person.
  let creatorRow = '';
  if (show.director) {
    let dirVal;
    if (creators.length) {
      dirVal = creators.map(c => c.imdb_id
        ? `<a href="https://www.imdb.com/name/${encodeURIComponent(c.imdb_id)}/" target="_blank" rel="noopener">${escapeHtml(c.name)}</a>`
        : escapeHtml(c.name)).join(', ');
    } else {
      dirVal = (show.director_imdb_id && !show.director.includes(','))
        ? `<a href="https://www.imdb.com/name/${encodeURIComponent(show.director_imdb_id)}/" target="_blank" rel="noopener">${escapeHtml(show.director)}</a>`
        : escapeHtml(show.director);
    }
    creatorRow = detailRow(show.movie ? 'Director' : 'Creator', dirVal);
  }

  let html = '';
  // One image, not two: the wide backdrop is the hero when we have one;
  // otherwise fall back to the poster.
  if (show.backdrop_url) {
    html += `<div class="detail-backdrop" style="width:100%;margin-bottom:12px;"><img src="${safeUrl(show.backdrop_url)}" alt="" loading="lazy" style="width:100%;border-radius:10px;display:block;"></div>`;
  } else if (show.poster_url) {
    html += `<div class="detail-poster"><img src="${safeUrl(show.poster_url)}" alt="" loading="lazy"></div>`;
  }
  // Tagline then overview, right under the image. The tagline is a pull
  // quote, italic and fainter, so it's never read as the plot's first line.
  if (show.tagline || show.overview) {
    let blurb = '';
    if (show.tagline) blurb += `<div class="detail-prose detail-tagline">${escapeHtml(show.tagline)}</div>`;
    if (show.overview) blurb += `<div class="detail-prose">${escapeHtml(show.overview)}</div>`;
    html += `<div class="detail-card">${blurb}</div>`;
  }
  if (topRows.length) html += `<div class="detail-card">${topRows.join('')}</div>`;
  // Cast — with the creator/director grouped underneath — directly under
  // the trailer, both as standard label/value rows (names right-aligned).
  if (actors.length || creatorRow) {
    let castInner = '';
    if (actors.length) {
      // The role follows the name, outside the link, once it's stored.
      const cast = actors.map(a => (a.imdb_id
        ? `<a href="https://www.imdb.com/name/${encodeURIComponent(a.imdb_id)}/" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>`
        : escapeHtml(a.name)) + (a.character ? ` (${escapeHtml(a.character)})` : '')).join(', ');
      castInner += detailRow('Cast', cast);
    }
    castInner += creatorRow;
    html += `<div class="detail-card">${castInner}</div>`;
  }

  // My-lists / member section. The four list chips ARE the move/add control:
  // tap a chip to put the show on that list (move an active copy, restore an
  // archived one, or add it if I don't have it).
  if (loggedIn) {
    const curList = (myCopy && !myCopy.archived) ? myCopy.list : null;
    const chips = allLists.map(l =>
      `<div class="list-chip${l === curList ? ' selected' : ''}" style="--chip-color: ${DETAIL_CHIP_COLORS[l]};" onclick="detailChip('${l}')">${escapeHtml(listLabels[l] || l)}</div>`
    ).join('');
    let memberInner = `<div class="list-chips detail-list-chips">${chips}</div>`;
    if (myCopy && myCopy.archived) memberInner += detailRow('Status', 'Archived');
    if (myCopy && myCopy.recommended_by) memberInner += detailRow('Recommended by', escapeHtml(myCopy.recommended_by));
    // An archived copy shows its memos read-only; an active one gets the
    // editable fields below.
    const editable = !!(myCopy && !myCopy.archived);
    if (!editable && myCopy && myCopy.watching_with) memberInner += detailRow('Watching with', escapeHtml(myCopy.watching_with));
    // Why a title you never added is on your list: the group-mate whose
    // Watching With tag put it there. Owner-only, absent on your own adds.
    if (myCopy && myCopy.added_by_member && myCopy.added_by_member.name) {
      memberInner += detailRow('Added by', escapeHtml(myCopy.added_by_member.name));
    }
    if (!editable && myCopy && myCopy.notes) memberInner += `<div class="detail-prose"><strong>Notes:</strong> ${escapeHtml(myCopy.notes)}</div>`;
    if (editable) memberInner += detailMemoEditorsHtml(myCopy);
    // Archive lives here in the member section (only for a copy I actively
    // have) — no separate actions card at the bottom.
    // Put this show on a group's Watch Next board. It recommends MY copy, so
    // it shows only when the title is on one of my lists and I'm in a group.
    if (myCopy && !myCopy.archived && groups.length) {
      memberInner += `<button class="detail-action" onclick="recommendToGroup(${Number(myCopy.id)})">Recommend to group</button>`;
    }
    if (showActions && myCopy && !myCopy.archived) {
      memberInner += `<button class="detail-action danger" onclick="detailArchive(${myCopy.id})">Archive</button>`;
    }
    // On a show that isn't mine (a group-mate's, Trending), say what the
    // chips do: they add it.
    const addHint = myCopy ? '' : '<span class="detail-card-hint">Pick a list to add it to yours</span>';
    html += `<div class="detail-card"><div class="detail-card-title detail-card-title-row">My Lists${addHint}</div>${memberInner}</div>`;
  }


  // The remaining catalog data (type, genres, dates, …), above Ratings: a
  // long-running show grows a rating row per season, and with Ratings in the
  // middle that pushed these facts so far down nobody scrolled to them.
  if (rows.length) html += `<div class="detail-card">${rows.join('')}</div>`;

  // Ratings — the last section of the card. Club Rating shows on every card,
  // logged in or not; a specific member's own rating shows when viewing
  // their copy; entry is gated to lists other than Next Up, matching the
  // backend's own gating in functions/api/shows/[id]/rating.js. Nothing
  // renders until the show has a tmdb_id (ratings key off that).
  if (ratings) {
    let ratingsInner = '';
    if (show.rating) ratingsInner += detailRow('TMDB Rating', `★ ${escapeHtml(show.rating)}`);
    const avgText = (ratings.average != null)
      ? `${ratings.average.toFixed(1)}/10 <span class="rating-count">(${ratings.count} rating${ratings.count === 1 ? '' : 's'})</span>`
      : 'No ratings yet';
    ratingsInner += detailRow('Show Picker Club Rating', avgText);
    if (ratings.owner != null) {
      ratingsInner += detailRow(`${escapeHtml(ratings.ownerName || '')}'s rating`, `${ratings.owner}/10`);
    }
    const eligible = loggedIn && myCopy && myCopy.list !== 'next';
    if (eligible) {
      ratingsInner += `<div class="rating-entry"><div class="rating-entry-label">Your rating${ratings.mine ? ` — ${ratings.mine}/10` : ''}</div>${ratingTapRow(ratings.mine, null)}</div>`;
      const seasonCount = show.movie ? 0 : (show.seasons_released || 0);
      for (let s = 1; s <= seasonCount; s++) {
        const seasonAvg = ratings.seasons[s];
        const mine = ratings.mineSeasons[s] || null;
        const avgPart = seasonAvg ? ` · avg ${seasonAvg.average}/10 (${seasonAvg.count})` : '';
        const minePart = mine ? ` — ${mine}/10` : '';
        ratingsInner += `<div class="rating-entry"><div class="rating-entry-label">Season ${s}${avgPart}${minePart}</div>${ratingTapRow(mine, s)}</div>`;
      }
    } else if (loggedIn && myCopy && myCopy.list === 'next') {
      ratingsInner += detailRow('Your rating', 'Start watching to rate');
    } else if (!show.movie && show.seasons_released) {
      for (let s = 1; s <= show.seasons_released; s++) {
        const seasonAvg = ratings.seasons[s];
        if (seasonAvg) ratingsInner += detailRow(`Season ${s}`, `${seasonAvg.average}/10 (${seasonAvg.count})`);
      }
    }
    html += `<div class="detail-card"><div class="detail-card-title">Ratings</div>${ratingsInner}</div>`;
  }

  // Share — the same /show/<id> link the iOS share sheet sends.
  if (show.id) {
    const args = escapeHtml(`${JSON.stringify(show.id)}, ${JSON.stringify(show.title || '')}`);
    html += `<div class="detail-card"><button class="detail-action" onclick="shareShow(${args})">Share</button></div>`;
  }

  return html;
}

// ── Watching With + Notes, edited in place ───────────────────────────────
// The only member-written fields left on a show — title, service and the
// catalog facts are TMDB's — so they're edited right on the card instead of
// in an edit screen. A text field saves when the member leaves it (the
// `change` event); a group-mate chip saves on the tap. Same rules as iOS
// ShowDetailView.saveMemos, and the same PUT /api/shows/:id the old edit
// form used, sending only the memo that changed.
let detailMemoCopy = null;        // the copy the fields on screen belong to
let detailMemoMates = null;       // [{slug, name, groups}] once fetched
let detailMemoSelected = new Set();
let detailMemoQueue = Promise.resolve();
let detailMemoInflight = null;    // {id, notes, watching_with} while saving

// The composed watching_with minus the linked names = what the member typed.
// Mirror of composeWatchingWith() in functions/_shared/watchers.js.
function detailMemoFreeText(composed, names) {
  const linked = new Set(names.map(n => String(n).trim().toLowerCase()));
  return String(composed || '').split(',').map(x => x.trim())
    .filter(x => x && !linked.has(x.toLowerCase())).join(', ');
}

function detailMemoWatchersKnown(copy) { return Array.isArray(copy && copy.watchers); }

// What the text field shows: only the typed half when the row says who it
// links (they're the chips), the whole string when it can't.
function detailMemoSavedFree(copy) {
  return detailMemoWatchersKnown(copy)
    ? detailMemoFreeText(copy.watching_with, copy.watchers.map(w => w.name))
    : (copy.watching_with || '');
}

function detailMemoEditorsHtml(copy) {
  detailMemoCopy = copy;
  detailMemoSelected = new Set((copy.watchers || []).map(w => w.slug));
  // A save still landing for this row wins over the copy we were handed —
  // a list move re-renders from a re-fetch that may predate it.
  const pending = detailMemoInflight && detailMemoInflight.id === copy.id ? detailMemoInflight : null;
  const notes = pending ? pending.notes : (copy.notes || '');
  const free = pending ? pending.watching_with : detailMemoSavedFree(copy);
  if (pending && pending.slugs) detailMemoSelected = new Set(pending.slugs);
  // Chips are filled in once the group-mates load; the markup is static.
  setTimeout(detailMemoRenderChips, 0);
  if (detailMemoMates === null) detailMemoLoadMates();
  return `<div class="detail-memo">
      <label class="detail-memo-label" for="detailMemoWatching">Watching with</label>
      <div class="detail-memo-chips hidden" id="detailMemoChips"></div>
      <input type="text" class="detail-memo-input" id="detailMemoWatching" autocomplete="off"
        value="${escapeHtml(free)}" placeholder="Who are you watching with?"
        onchange="detailMemoSave()" onkeydown="if (event.key === 'Enter') this.blur()">
      <div class="detail-memo-hint hidden" id="detailMemoHint"></div>
    </div>
    <div class="detail-memo">
      <label class="detail-memo-label" for="detailMemoNotes">Notes</label>
      <textarea class="detail-memo-input" id="detailMemoNotes" rows="3" placeholder="Add a note"
        onchange="detailMemoSave()">${escapeHtml(notes)}</textarea>
    </div>`;
}

async function detailMemoLoadMates() {
  detailMemoMates = [];
  try {
    const res = await fetch('/api/group-members');
    if (res.ok) detailMemoMates = (await res.json()).members || [];
  } catch (e) {}
  detailMemoRenderChips();
}

function detailMemoRenderChips() {
  const box = document.getElementById('detailMemoChips');
  const hint = document.getElementById('detailMemoHint');
  const input = document.getElementById('detailMemoWatching');
  if (!box || !detailMemoCopy) return;
  // Someone linked here who has since left my groups stays a chip, so the
  // next save doesn't silently unlink them.
  const mates = (detailMemoMates || []).slice();
  for (const w of detailMemoCopy.watchers || []) {
    if (!mates.some(m => m.slug === w.slug)) mates.push({ slug: w.slug, name: w.name });
  }
  if (!mates.length) { box.classList.add('hidden'); hint.classList.add('hidden'); return; }
  box.innerHTML = mates.map(m => {
    const on = detailMemoSelected.has(m.slug);
    return `<button type="button" class="detail-memo-chip${on ? ' selected' : ''}" data-slug="${escapeHtml(m.slug)}" aria-pressed="${on}">${on ? '✓ ' : ''}${escapeHtml(m.name)}</button>`;
  }).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const slug = b.dataset.slug;
    if (detailMemoSelected.has(slug)) detailMemoSelected.delete(slug); else detailMemoSelected.add(slug);
    detailMemoRenderChips();
    detailMemoSave();
  }));
  box.classList.remove('hidden');
  if (input) input.placeholder = 'Someone else';
  // Say plainly what a tap does to the other person's library.
  const picked = mates.filter(m => detailMemoSelected.has(m.slug)).map(m => m.name);
  hint.textContent = picked.length
    ? `Also on ${picked.length > 1 ? picked.slice(0, -1).join(', ') + ' and ' + picked[picked.length - 1] : picked[0]}’s ${picked.length > 1 ? 'lists' : 'list'}. If they already had it, it stays where they put it.`
    : 'Tap anyone you share a group with — it goes on their list too. Anyone else, just type.';
  hint.classList.remove('hidden');
}

// Save whatever differs from the copy. Queued, so a chip tapped while a note
// is still saving runs after it rather than racing it. A no-op when nothing
// changed, so leaving an untouched field costs nothing.
function detailMemoSave() {
  detailMemoQueue = detailMemoQueue.then(detailMemoSaveOnce, detailMemoSaveOnce);
  return detailMemoQueue;
}

async function detailMemoSaveOnce() {
  const copy = detailMemoCopy;
  const notesEl = document.getElementById('detailMemoNotes');
  const wwEl = document.getElementById('detailMemoWatching');
  if (!copy || !notesEl || !wwEl) return;
  const notes = notesEl.value.trim();
  const free = wwEl.value.trim();
  const known = detailMemoWatchersKnown(copy);
  const slugs = Array.from(detailMemoSelected);
  const linked = new Set((copy.watchers || []).map(w => w.slug));
  const watchersChanged = slugs.length !== linked.size || slugs.some(x => !linked.has(x));
  const body = {};
  if (notes !== (copy.notes || '').trim()) body.notes = notes || null;
  if (free !== detailMemoSavedFree(copy).trim() || watchersChanged) {
    body.watching_with = free || null;
    // The complete set, so un-tapping someone unlinks them — unless the row
    // can't say who it names, where [] would unlink people never shown.
    if (known || slugs.length) body.watcher_slugs = slugs;
  }
  if (!Object.keys(body).length) return;
  detailMemoInflight = { id: copy.id, notes, watching_with: free, slugs };
  const toast = (msg, opts) => (typeof showToast === 'function' ? showToast(msg, opts) : (opts ? alert(msg) : null));
  try {
    const res = await fetch(`/api/shows/${copy.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast(res.status === 401 ? 'You’re logged out — sign in again to save.' : 'Couldn’t save. Try again.', { tone: 'error' });
      return;
    }
    const saved = (await res.json()).show;
    if (saved) {
      // In place, so the page's own reference to my copy sees it too.
      Object.assign(copy, saved);
      if (typeof window.onDetailMemoSaved === 'function') window.onDetailMemoSaved(saved);
    }
    toast('Saved');
  } catch (e) {
    toast('Network error. Try again.', { tone: 'error' });
  } finally {
    detailMemoInflight = null;
  }
}

// Leaving the card with a field still focused: the field never blurs, so
// `change` never fires. Pages call this on the way out.
function detailMemoFlush() {
  const el = document.activeElement;
  if (el && (el.id === 'detailMemoNotes' || el.id === 'detailMemoWatching')) el.blur();
  return detailMemoSave();
}


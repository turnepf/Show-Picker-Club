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

function formatSeasonRange(show) {
  if (!show || !show.next_season_date) return '';
  const date = new Date(show.next_season_date);
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
  const { onClickId, showRating = true, showChevron = true, showDragHandle = false, caption, currentTab, prefixHtml = '', extraHtml = '' } = options;

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

  const rightElement = showDragHandle
    ? `<span class="drag-handle" title="Drag to reorder">&#x2630;</span>`
    : (showChevron ? `<span class="ios-row-chevron">&#8250;</span>` : '');

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
  const { onClickId, showRating = true, showChevron = true, showDragHandle = false, currentTab, showFooter = false, canDrag = false, owners = '' } = options;

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
    currentTab
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
      .map(([n, c]) => `${n} (${c})`)
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

const DETAIL_ALL_LISTS = ['watching', 'waiting', 'recommending', 'next'];
const DETAIL_LIST_LABELS = { watching: 'Watching', waiting: 'Awaiting', recommending: 'Loved', next: 'Next Up' };
const DETAIL_CHIP_COLORS = {
  watching: 'var(--list-watching)', waiting: 'var(--list-waiting)',
  recommending: 'var(--list-recommending)', next: 'var(--accent)',
};

/*
 * Render the whole detail body for a show.
 * Options:
 *   actors:      [{ name, imdb_id }] cast, in billing order
 *   loggedIn:    boolean — gates the My Lists card
 *   myCopy:      my own row for this title (active or archived), or null
 *   ratings:     { average, count, seasons, mine, mineSeasons, owner,
 *                  ownerSeasons, ownerName } from GET /api/shows/:id
 *   showActions: boolean — include Edit/Archive in My Lists (main app only;
 *                the groups page has no edit modal to open)
 */
function renderShowDetailBody(show, options = {}) {
  const {
    actors = [], loggedIn = false, myCopy = null, ratings = null,
    listLabels = DETAIL_LIST_LABELS, allLists = DETAIL_ALL_LISTS, showActions = false,
  } = options || {};
  if (!show) return '';

  // Title lives in the nav bar above the image — no redundant "Title" row.
  // The top card leads with where to watch + the trailer, then Cast, then
  // the rest of the metadata below.
  const topRows = [];
  if (show.network) {
    // Spell the affordance out — a bare network name reads as a label, not
    // a link, so nobody realized it opened the show on the service.
    topRows.push(detailRow('Network', detailRealUrl(show.network_url)
      ? `<a href="${safeUrl(show.network_url)}" target="_blank" rel="noopener">Watch on ${escapeHtml(show.network)}</a>`
      : (show.watch_link
          ? `${escapeHtml(show.network)} · <a href="${safeUrl(show.watch_link)}" target="_blank" rel="noopener">Where to watch</a>`
          : escapeHtml(show.network))));
  }
  if (show.trailer_key) {
    topRows.push(detailRow('Trailer', `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(show.trailer_key)}" target="_blank" rel="noopener">▶ Watch trailer</a>`));
  }

  // Catalog rows. The list and the member-edited fields (recommender,
  // watching-with, notes) live in the My Lists card instead — they're
  // member specific, not catalog data.
  const rows = [];
  if (show.movie) rows.push(detailRow('Type', 'Movie'));
  {
    // "4 Seasons, Complete", or just "2 Seasons" while it's still running
    // (or just "Complete" when the count is unknown).
    const n = show.seasons_released;
    const seriesParts = [];
    if (typeof n === 'number' && n > 0) seriesParts.push(`${n} Season${n === 1 ? '' : 's'}`);
    if (show.full_series) seriesParts.push('Complete');
    if (seriesParts.length) rows.push(detailRow('Series', escapeHtml(seriesParts.join(', '))));
  }
  if (show.genres) rows.push(detailRow('Genres', escapeHtml(show.genres)));
  if (show.runtime) rows.push(detailRow('Runtime', escapeHtml(runtimeText(show.runtime))));
  if (show.next_season_date) rows.push(detailRow('Next episode', escapeHtml(formatSeasonRange(show))));
  if (show.content_rating) rows.push(detailRow('Rated', escapeHtml(show.content_rating)));
  if (show.release_year) rows.push(detailRow('Year', escapeHtml(String(show.release_year))));

  // Creator/Director is a standard label/value row grouped in the Cast card.
  // Link a single-person credit to their IMDB page (mirrors the cast links);
  // a multi-creator credit (comma in the name) stays plain so the whole list
  // doesn't point at just the first person.
  let creatorRow = '';
  if (show.director) {
    const dirVal = (show.director_imdb_id && !show.director.includes(','))
      ? `<a href="https://www.imdb.com/name/${encodeURIComponent(show.director_imdb_id)}/" target="_blank" rel="noopener">${escapeHtml(show.director)}</a>`
      : escapeHtml(show.director);
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
  // Overview (plot synopsis) sits right under the title/image.
  if (show.overview) html += `<div class="detail-card"><div class="detail-prose">${escapeHtml(show.overview)}</div></div>`;
  if (topRows.length) html += `<div class="detail-card">${topRows.join('')}</div>`;
  // Cast — with the creator/director grouped underneath — directly under
  // the trailer, both as standard label/value rows (names right-aligned).
  if (actors.length || creatorRow) {
    let castInner = '';
    if (actors.length) {
      const cast = actors.map(a => a.imdb_id
        ? `<a href="https://www.imdb.com/name/${encodeURIComponent(a.imdb_id)}/" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>`
        : escapeHtml(a.name)).join(', ');
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
    if (myCopy && myCopy.watching_with) memberInner += detailRow('Watching with', escapeHtml(myCopy.watching_with));
    if (myCopy && myCopy.notes) memberInner += `<div class="detail-prose"><strong>Notes:</strong> ${escapeHtml(myCopy.notes)}</div>`;
    // Edit / Archive live here in the member section (only for a copy I
    // actively have) — no separate actions card at the bottom.
    if (showActions && myCopy && !myCopy.archived) {
      memberInner += `<button class="detail-action" onclick="detailEdit(${myCopy.id})">Edit</button>`;
      memberInner += `<button class="detail-action danger" onclick="detailArchive(${myCopy.id})">Archive</button>`;
    }
    html += `<div class="detail-card"><div class="detail-card-title">My Lists</div>${memberInner}</div>`;
  }

  // Ratings — directly below My Lists. Club Rating shows on every card,
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

  // The remaining catalog data (type, genres, dates, …), grouped below.
  if (rows.length) html += `<div class="detail-card">${rows.join('')}</div>`;

  return html;
}

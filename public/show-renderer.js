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
 */
function renderShowCard(show, options = {}) {
  options = options || {};
  const { onClickId, showRating = true, showChevron = true, showDragHandle = false, caption, currentTab } = options;

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
        ${poster}
        <div class="ios-row-text">
          <div class="ios-row-title">${escapeHtml(show.title)}${series}${movieTag}</div>
          ${captionHtml}
          ${dateLine}
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

// One Watch link per show per service (migration 089, `watch_links`).
//
// A link used to live on every member's copy, so the same show carried as
// many links as it had members — Pottery Throw Down fixed for one copy and
// still broken on the next, tracking parameters making 323 Netflix copies
// hold 169 different URLs. The link belongs to the show on a service, not to
// the member: everyone watching Hacks on HBO Max gets the same Watch button.
//
// shows_v reads `network_url` as the shared link for the copy's (TMDB entry,
// network), falling back to the copy's own column when there is none. So a
// copy's column is now only a fallback, and the table is what to write.
//
// Who may write it is INVARIANTS §24: a club-wide link needs a provider-grade
// source. Three writers qualify, and nothing a member's request body carries
// does:
//   - 'admin'     Show Cleanup and the admin fix tools. Overwrites.
//   - 'watchmode' the provider lookup. Fills only — never replaces a link an
//                 operator chose.
//   - 'copy'      the nightly lift of links already on copies. Fills only,
//                 and only a link whose host is the row's own service.
// A member's own paste stays on their copy, where it shows only when the
// show has no shared link on that service.

import { networkFromUrl, storefrontFromUrl } from './networks.js';
import { safeNetworkUrl } from './url-utils.js';
import { normalizeAmazonUrl, amazonUrlLandsOnShow } from './amazon-urls.js';
import { normalizeHboMaxUrl } from './hbomax-urls.js';

// Links that look like links and land nowhere — a service's search page, an
// info page that opens the home screen. The same list the cleanup queue and
// the Watchmode fill count as missing; they are never shared.
const PLACEHOLDER = [
  (u) => /\/search|\/s\?|[?&]q=|[?&]query=/i.test(u),
  (u) => /^https?:\/\/(www\.)?(max|hbomax)\.com\//i.test(u),
  (u) => /^https?:\/\/play\.(hbo)?max\.com\/video\/watch\//i.test(u),
  (u) => /^https?:\/\/(www\.)?themoviedb\.org\//i.test(u),
  (u) => /^https?:\/\/(www\.)?amazon\.com\/s\/?$/i.test(u),
];

export function isPlaceholderUrl(url) {
  return !url || PLACEHOLDER.some((t) => t(url));
}

// The link as it should be stored for `network`, or null when it may not be
// stored there at all: unsafe, a placeholder, or a host that belongs to some
// other service. Apple's storefront has no domain of its own (tv.apple.com is
// Apple TV+'s), so a tv.apple.com link is accepted for either.
export function shareableUrl(url, network) {
  if (!network) return null;
  const safe = safeNetworkUrl(url);
  if (!safe) return null;
  const fixed = normalizeHboMaxUrl(normalizeAmazonUrl(safe));
  if (isPlaceholderUrl(fixed)) return null;
  const host = networkFromUrl(fixed);
  if (host !== network && storefrontFromUrl(fixed) !== network) return null;
  return fixed;
}

const keyOf = (row) => ({
  type: row.tmdb_type || (row.movie ? 'movie' : 'tv'),
  id: row.tmdb_id,
});

// Store a link for (show, network). `row` is anything carrying tmdb_id and
// tmdb_type (or movie). Returns the stored URL, or null when nothing was
// stored — no TMDB pin, a link that isn't shareable for this service, or a
// fill that found a link already there. Never throws: it runs beside a
// member's save and must not fail it.
export async function setWatchLink(env, row, network, url, source) {
  try {
    const { type, id } = keyOf(row || {});
    if (!id) return null;
    const link = shareableUrl(url, network);
    if (!link) return null;
    const overwrite = source === 'admin';
    const res = await env.DB.prepare(
      overwrite
        ? `INSERT INTO watch_links (tmdb_type, tmdb_id, network, url, source, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (tmdb_type, tmdb_id, network)
             DO UPDATE SET url = excluded.url, source = excluded.source, updated_at = excluded.updated_at`
        : `INSERT OR IGNORE INTO watch_links (tmdb_type, tmdb_id, network, url, source, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(type, id, network, link, source).run();
    return res.meta.changes ? link : null;
  } catch {
    return null;
  }
}

// The one case where a machine may replace a shared link: Prime Video, where
// the shape decides whether Watch opens the show at all. Only
// watch.amazon.com/detail?gti= lands on the title; an ASIN or primevideo.com
// link opens Prime Video's home screen (amazon-urls.js). Fill-only kept the
// first link any copy carried — usually one of those — so the amazon-shape
// repair found the right link, wrote it to the copies, and members still saw
// the old one, because shows_v reads the shared row first.
//
// A link that lands on the show replaces one that doesn't. Never an admin's:
// an operator who chose a link chose it. Returns the stored URL, or null when
// nothing changed. Never throws, like setWatchLink.
export async function upgradeAmazonWatchLink(env, row, network, url) {
  try {
    const { type, id } = keyOf(row || {});
    if (!id) return null;
    const link = shareableUrl(url, network);
    if (!link || !amazonUrlLandsOnShow(link)) return null;
    const res = await env.DB.prepare(
      `UPDATE watch_links SET url = ?, source = 'watchmode', updated_at = datetime('now')
        WHERE tmdb_type = ? AND tmdb_id = ? AND network = ?
          AND source != 'admin'
          AND url NOT LIKE 'https://watch.amazon.com/%'`
    ).bind(link, type, id, network).run();
    return res.meta.changes ? link : null;
  } catch {
    return null;
  }
}

// Forget the link for (show, network) — the operator said the link is wrong
// for that service. Copies fall back to their own column until a new one is
// set.
export async function clearWatchLink(env, row, network) {
  const { type, id } = keyOf(row || {});
  if (!id || !network) return;
  await env.DB.prepare(
    'DELETE FROM watch_links WHERE tmdb_type = ? AND tmdb_id = ? AND network = ?'
  ).bind(type, id, network).run();
}

// How good a link is to share, before counting votes. An episode or an
// autoplay link is worse than the show's own page however many copies carry
// it — 23 Ted Lasso copies held one episode's link, one held the show's — and
// a link with a share-button query string is usually the same page as the
// clean one beside it.
const NOT_THE_SHOW = /\/(episode|watch)\//i;
const rank = (url) => (NOT_THE_SHOW.test(new URL(url).pathname) ? 0 : 2) + (new URL(url).search ? 0 : 1);

// The nightly lift: every (show, network) with no shared link takes the link
// its copies already carry. Fill-only and host-checked like any other
// non-admin write. Where copies disagree, the show's own page beats an
// episode or autoplay link, a clean link beats a tracked one, and then the
// link most copies carry wins, then the most recently enriched. Returns how
// many links it stored.
export async function liftWatchLinks(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.tmdb_id, COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) AS tmdb_type,
            s.network, s.network_url, s.enriched_at
       FROM shows s
      WHERE s.tmdb_id IS NOT NULL AND s.network IS NOT NULL AND s.network != ''
        AND s.network_url IS NOT NULL AND s.network_url != ''
        AND NOT EXISTS (SELECT 1 FROM watch_links w
                         WHERE w.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)
                           AND w.tmdb_id = s.tmdb_id AND w.network = s.network)`
  ).all();

  const groups = new Map();
  for (const r of results || []) {
    const link = shareableUrl(r.network_url, r.network);
    if (!link) continue;
    const k = `${r.tmdb_type}|${r.tmdb_id}|${r.network}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { row: r, votes: new Map() });
    const v = g.votes.get(link) || { n: 0, latest: '' };
    v.n++;
    if ((r.enriched_at || '') > v.latest) v.latest = r.enriched_at || '';
    g.votes.set(link, v);
  }

  // One batch per hundred links: on the free plan a Worker gets 50 D1 calls,
  // and the first run lifts the whole library at once.
  const stmts = [];
  for (const { row, votes } of groups.values()) {
    const [best] = [...votes.entries()].sort((a, b) =>
      rank(b[0]) - rank(a[0]) || b[1].n - a[1].n || (b[1].latest > a[1].latest ? 1 : -1));
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO watch_links (tmdb_type, tmdb_id, network, url, source, updated_at)
         VALUES (?, ?, ?, ?, 'copy', datetime('now'))`
    ).bind(row.tmdb_type, row.tmdb_id, row.network, best[0]));
  }
  let stored = 0;
  for (let i = 0; i < stmts.length; i += 100) {
    const out = await env.DB.batch(stmts.slice(i, i + 100));
    for (const r of out || []) stored += r?.meta?.changes || 0;
  }
  return stored;
}

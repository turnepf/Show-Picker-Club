import { canonicalNetwork, networkFromUrl, storefrontFromUrl } from '../_shared/networks.js';
import { extractUrl, safeNetworkUrl } from '../_shared/url-utils.js';
import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { fetchAvailability } from '../_shared/enrichment.js';
import { sameShowJoin, sameShowWhere, showKeySql } from '../_shared/same-show.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Operator-dismissed titles (see migrations/048) — titles that genuinely
// have no good deep link to paste, so they'd otherwise sit in the queue
// forever. /api/admin-url-cleanup creates this table on demand (identical
// statement to the migration) so deploy order doesn't matter.
const CREATE_IGNORES_TABLE = `CREATE TABLE IF NOT EXISTS url_cleanup_ignores (
  ltitle TEXT NOT NULL PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
)`;

// URL hygiene isn't taste-related — Paula and any other taste-excluded
// members still need their placeholder URLs cleaned up, so this queue
// covers every active row regardless of the taste exclusion list.
const BAD_URL = `(s.network_url IS NULL
                  OR s.network_url LIKE '%/search%'
                  OR s.network_url LIKE '%/s?%'
                  OR s.network_url LIKE '%?q=%'
                  OR s.network_url LIKE '%?query=%'
                  OR s.network_url LIKE 'https://www.max.com/%'
                  OR s.network_url LIKE 'https://www.hbomax.com/%'
                  OR s.network_url LIKE 'https://play.hbomax.com/video/watch/%'
                  -- Note: HBO Max search-fallback URLs are intentionally
                  -- not listed here. They're the best we can do for
                  -- titles Watchmode only knows as auto-play deep links.
                  OR s.network_url LIKE 'https://www.themoviedb.org/%'
                  -- Bare https://www.amazon.com/s (no query) is the Amazon
                  -- search endpoint with no search term — dumps you on the
                  -- Amazon homepage. Legacy artifact of the old cleanUrl()
                  -- query-string stripper.
                  OR s.network_url = 'https://www.amazon.com/s'
                  OR s.network_url = 'https://www.amazon.com/s/')`;
// Titles the operator dismissed. `s` is shows_v here (a copy has no title of
// its own; the name is TMDB's), kept apart from QUEUE_FILTER, whose
// subqueries read the raw table.
const NOT_DISMISSED = `LOWER(s.title) NOT IN (SELECT ltitle FROM url_cleanup_ignores)`;
const QUEUE_FILTER = `
  s.archived = 0
  AND ${BAD_URL}
  -- Exempt HBO Max search-fallback URLs: they're the best deep link we
  -- can offer for titles Watchmode only knows as auto-play URLs, so
  -- they shouldn't show up in the queue every cleanup pass. Two shapes:
  -- /search?q=... (our auto-generated fallback) and /search/result?q=...
  -- (operator-pasted from HBO Max's own search-results page).
  -- NULL-safe: NULL NOT LIKE ... is NULL in SQLite, so a bare NOT LIKE
  -- here silently dropped every missing-URL row from the queue.
  AND (s.network_url IS NULL OR (
        s.network_url NOT LIKE 'https://play.hbomax.com/search?%'
    AND s.network_url NOT LIKE 'https://play.hbomax.com/search/result?%'))
  -- A row escapes the queue only if its network is set AND another row
  -- of the same network already has a good URL (sync-urls will propagate
  -- it). Rows with NULL network always belong in the queue — they can't
  -- be auto-rescued because propagation is network-scoped now.
  AND (s.network IS NULL OR NOT EXISTS (
    SELECT 1 FROM shows s_good
    WHERE ${sameShowJoin('s_good', 's', { hasTitle: false })}
      AND s_good.archived = 0
      AND s_good.network = s.network
      AND s_good.network_url IS NOT NULL
      AND s_good.network_url NOT LIKE '%/search%'
      AND s_good.network_url NOT LIKE '%/s?%'
      AND s_good.network_url NOT LIKE '%?q=%'
      AND s_good.network_url NOT LIKE '%?query=%'
      AND s_good.network_url NOT LIKE 'https://www.max.com/%'
      AND s_good.network_url NOT LIKE 'https://www.hbomax.com/%'
      AND s_good.network_url NOT LIKE 'https://play.hbomax.com/video/watch/%'
      AND s_good.network_url NOT LIKE 'https://www.themoviedb.org/%'
      AND s_good.network_url != 'https://www.amazon.com/s'
      AND s_good.network_url != 'https://www.amazon.com/s/'
  ))
`;

// Rows with no network at all can't be rescued by URL propagation — it's
// scoped to (show, network). But when every other active copy of the show
// (same TMDB entry when both are pinned, else same title) agrees on a service, the answer is unambiguous: adopt it. Titles whose
// copies disagree are left alone; picking a winner there is the conflict
// queue's job — the one part of this that needs a human, and the reason the
// Show Cleanup page still exists.
//
// Runs nightly from watch-urls-fill.yml, ahead of the Watchmode pass in the
// same job: URL propagation is scoped by (title, network), so a row with no
// network can't be reached by it until this has given the row one. It used to
// be a button on the Show Cleanup page, clicked every time the page was
// opened — which is a description of a routine sweep, not of operator
// judgment.
async function inheritNetworks(env) {
  const result = await env.DB.prepare(`
    UPDATE shows
       SET network = (SELECT s.network FROM shows s
                       WHERE ${sameShowJoin('s', 'shows', { hasTitle: false })} AND s.archived = 0
                         AND s.network IS NOT NULL AND s.network != ''),
           enriched_at = datetime('now')
     WHERE archived = 0
       AND (network IS NULL OR network = '')
       AND (SELECT COUNT(DISTINCT s.network) FROM shows s
             WHERE ${sameShowJoin('s', 'shows', { hasTitle: false })} AND s.archived = 0
               AND s.network IS NOT NULL AND s.network != '') = 1
  `).run();
  return result.meta.changes;
}

// Re-decide the network for rows sitting on a subscription service that TMDB
// says doesn't actually stream the title. Built for the Apple TV+ backlog:
// tv.apple.com serves Apple originals and $3.99 rentals from the same URL
// shape, so every pasted Apple link used to land on "Apple TV+" and inflate
// what the Subscription Audit claimed members needed to pay for.
//
// Three outcomes per title, from TMDB's US watch/providers:
//   flatrate names a service  → that service is the real carrier; move there
//                               (a no-op when the row was already right)
//   only rent/buy             → nothing streams it; move to the storefront
//   TMDB knows neither        → leave it alone rather than guess
//
// network_url is never touched — the link still works whatever the label says.
//
// One subrequest per distinct TMDB id, capped per invocation and ordered
// oldest-enriched-first, so repeated calls walk the whole backlog. Every
// processed row gets its enriched_at stamped (including the ones left as-is)
// so it rotates to the back and the next call sees fresh work.
async function reclassifyStorefronts(env, body) {
  if (!env.TMDB_TOKEN) return json({ error: 'TMDB_TOKEN not configured' }, 500);

  const network = canonicalNetwork(String(body.network || 'Apple TV+').trim());
  const maxTitles = Math.min(parseInt(body.max_titles ?? '40', 10), 100);

  const { results: rows } = await env.DB.prepare(
    `SELECT tmdb_id, tmdb_type, MIN(title) AS title, COUNT(*) AS copies
       FROM shows_v
      WHERE archived = 0 AND network = ? AND tmdb_id IS NOT NULL
      GROUP BY tmdb_id
      ORDER BY MIN(COALESCE(enriched_at, '1970-01-01')) ASC
      LIMIT ?`
  ).bind(network, maxTitles).all();

  const moved = [];
  let kept = 0, unknown = 0, rowsChanged = 0;

  for (const row of rows) {
    const info = await fetchAvailability(row.tmdb_id, row.tmdb_type, env);

    let target = null;
    if (info.availability === 'subscription' && info.providerNetwork) {
      target = info.providerNetwork;
    } else if (info.availability === 'rent_buy') {
      // Prefer the storefront that matches the link the row already carries.
      // TMDB lists rent/buy providers in its own order, so taking the first
      // one put Apple-linked rows on Fandango at Home — both storefronts, so
      // the audit was right either way, but the label contradicted the link
      // sitting next to it.
      const linked = await env.DB.prepare(
        `SELECT network_url FROM shows
          WHERE archived = 0 AND network = ? AND tmdb_id = ? AND network_url IS NOT NULL
          LIMIT 1`
      ).bind(network, row.tmdb_id).first();
      const fromLink = linked ? storefrontFromUrl(linked.network_url) : null;
      target = (fromLink && info.storefronts.includes(fromLink))
        ? fromLink
        : (info.storefronts[0] || null);
    }

    if (!target) {
      unknown++;
    } else if (target === network) {
      kept++;
    } else {
      const res = await env.DB.prepare(
        `UPDATE shows SET network = ?, enriched_at = datetime('now')
          WHERE archived = 0 AND network = ? AND tmdb_id = ?`
      ).bind(target, network, row.tmdb_id).run();
      rowsChanged += res.meta.changes;
      moved.push({ title: row.title, to: target, copies: res.meta.changes });
      continue;
    }

    // Left where it was — still stamp it so it rotates out of the queue.
    await env.DB.prepare(
      `UPDATE shows SET enriched_at = datetime('now')
        WHERE archived = 0 AND network = ? AND tmdb_id = ?`
    ).bind(network, row.tmdb_id).run();
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tmdb_id) AS n FROM shows
      WHERE archived = 0 AND network = ? AND tmdb_id IS NOT NULL
        AND COALESCE(enriched_at, '1970-01-01') < datetime('now', '-1 hour')`
  ).bind(network).first();

  return json({
    ok: true,
    checked: rows.length,
    kept,
    unknown,
    rows_changed: rowsChanged,
    moved,
    remaining: remaining ? remaining.n : 0,
  });
}

// Copies a good link to sibling copies still on a placeholder. Nightly only
// (inherit_networks); it used to also run on every page load.
async function propagateGoodUrls(env) {
  // Before listing, push every known good URL out to any sibling row that's
  // still on a placeholder. Scoped to (show, network) because the same
  // show can live on multiple services — copying URLs across networks
  // would land members on the wrong streaming app at watch time.
  const { results: sources } = await env.DB.prepare(
    `SELECT tmdb_id, tmdb_type, movie, network, network_url FROM shows
     WHERE archived = 0
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
       AND network_url NOT LIKE '%?q=%'
       AND network_url NOT LIKE '%?query=%'
       AND network_url NOT LIKE 'https://www.max.com/%'
       AND network_url NOT LIKE 'https://www.hbomax.com/%'
       AND network_url NOT LIKE 'https://play.hbomax.com/video/watch/%'
       AND network_url NOT LIKE 'https://www.themoviedb.org/%'
       AND network_url != 'https://www.amazon.com/s'
       AND network_url != 'https://www.amazon.com/s/'
     GROUP BY ${showKeySql('shows', { hasTitle: false })}, network`
  ).all();
  let filled = 0;
  for (const src of sources) {
    // Copies of this same show only: a different film sharing the title
    // has a different link, even on the same service.
    const same = sameShowWhere('shows', src, { forWrite: true, hasTitle: false });
    const result = await env.DB.prepare(
      `UPDATE shows
         SET network_url = ?,
             enriched_at = datetime('now')
       WHERE ${same.sql} AND network = ? AND archived = 0
         AND (network_url IS NULL
              OR network_url LIKE '%/search%'
              OR network_url LIKE '%/s?%'
              OR network_url LIKE '%?q=%'
              OR network_url LIKE '%?query=%'
              OR network_url LIKE 'https://www.max.com/%'
              OR network_url LIKE 'https://www.hbomax.com/%'
              OR network_url LIKE 'https://play.hbomax.com/video/watch/%'
              OR network_url LIKE 'https://www.themoviedb.org/%'
              OR network_url = 'https://www.amazon.com/s'
              OR network_url = 'https://www.amazon.com/s/')`
    ).bind(src.network_url, ...same.binds, src.network).run();
    filled += result.meta.changes;
  }
  return filled;
}

async function fetchQueue(env) {
  // One row per show (a TMDB entry, or a title TMDB never matched), with all
  // the member labels for its copies. Three films called "The Odyssey" are
  // three rows, each with its own link to find.
  const { results } = await env.DB.prepare(`
    SELECT
      MIN(s.id) AS id,
      MIN(s.title) AS title,
      (SELECT s2.network FROM shows s2
        WHERE ${sameShowJoin('s2', 's', { hasTitle: false })} AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
        ORDER BY s2.id LIMIT 1) AS network,
      (SELECT s3.network_url FROM shows s3
        WHERE ${sameShowJoin('s3', 's', { hasTitle: false })} AND s3.archived = 0
        ORDER BY s3.id LIMIT 1) AS network_url,
      COUNT(*) AS member_count,
      GROUP_CONCAT(
        COALESCE(
          CASE WHEN m.first_name IS NOT NULL AND m.last_initial IS NOT NULL
               THEN m.first_name || ' ' || m.last_initial
               ELSE m.first_name END,
          s.member_slug),
        ', ') AS members
    FROM shows_v s
    LEFT JOIN members m ON m.slug = s.member_slug
    WHERE ${QUEUE_FILTER} AND ${NOT_DISMISSED}
    GROUP BY ${showKeySql('s')}
    ORDER BY LOWER(COALESCE(network, 'zzz')), LOWER(MIN(s.title))
  `).all();

  return results.map(r => ({
    id: r.id,
    title: r.title,
    network: r.network,
    network_url: r.network_url,
    member_count: r.member_count,
    members: r.members,
  }));
}




// Rows where the URL's domain points at a different service than the
// stored network. The url-utils helper canonicalises a URL's host to one
// of our known networks; when it matches a network *but* doesn't match
// the row's declared network, that's a mismatch worth surfacing.
async function fetchMismatches(env) {
  const { results } = await env.DB.prepare(`
    SELECT s.id, s.title, s.network, s.network_url, s.member_slug,
           m.first_name, m.last_initial
      FROM shows_v s
      LEFT JOIN members m ON m.slug = s.member_slug
     WHERE s.archived = 0
       AND s.network IS NOT NULL AND s.network != ''
       AND s.network_url IS NOT NULL AND s.network_url != ''
       -- skip the patterns we already treat as not-a-real-link
       AND s.network_url NOT LIKE '%/search%'
       AND s.network_url NOT LIKE '%/s?%'
       AND s.network_url NOT LIKE 'https://play.hbomax.com/search?%'
       AND s.network_url NOT LIKE 'https://play.hbomax.com/search/result?%'
     ORDER BY LOWER(s.title), s.member_slug
  `).all();
  // Per-row classification needs the JS helper; SQL can't tell.
  const mismatches = [];
  for (const r of results || []) {
    const derived = networkFromUrl(r.network_url);
    if (!derived) continue;                       // unknown domain — can't classify
    if (derived === r.network) continue;          // matches; skip
    // An Apple link on a row labeled something else is the intended shape,
    // not a mismatch: tv.apple.com is a storefront that also sells titles
    // streaming elsewhere, so the link and the carrier legitimately disagree.
    // Without this, every reclassified rental would report itself as broken.
    if (derived === 'Apple TV+') continue;
    const label = (r.first_name || r.member_slug) + (r.last_initial ? ' ' + r.last_initial : '');
    mismatches.push({
      id: r.id,
      title: r.title,
      network: r.network,
      network_url: r.network_url,
      url_network: derived,
      member: label,
    });
  }
  return mismatches;
}

async function fetchNetworks(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT network FROM shows WHERE network IS NOT NULL AND network != '' ORDER BY network COLLATE NOCASE"
  ).all();
  return results.map(r => r.network);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const action = body.action || 'list';

  // Admin session, or — for two actions only — a matching X-Cron-Secret, so a
  // scheduled workflow can drive them without one. Both qualify on the same
  // two counts: they are idempotent, and they decide nothing. A storefront
  // reclassification re-derives a network from what TMDB says about a title;
  // adopting a network only fills rows that have none, and only where every
  // other copy in the club already agrees on one, which is why titles whose
  // copies disagree are skipped rather than resolved.
  //
  // The narrowness is still the point. Every other action here writes
  // something an operator has to be trusted with — dismissing a title out of
  // the queue, overwriting a link, picking a winner among networks members
  // disagree about — and stays admin-session-only, so a leaked cron secret
  // cannot reach them.
  const CRON_ACTIONS = ['reclassify_storefronts', 'inherit_networks'];
  const cronOk = CRON_ACTIONS.includes(action)
    && await cronAuthorized(request, env);
  if (!cronOk && !(await isAdmin(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }
  await env.DB.prepare(CREATE_IGNORES_TABLE).run();

  if (action === 'dismiss') {
    // Operator marked a title as having no good link available — stop
    // surfacing it in the queue. Scoped by title (case-insensitive), same
    // grouping the queue itself uses.
    const title = String(body.title || '').trim();
    if (!title) return json({ error: 'title required' }, 400);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO url_cleanup_ignores (ltitle) VALUES (LOWER(?))'
    ).bind(title).run();
    return json({ ok: true });
  }

  if (action === 'save') {
    const id = parseInt(body.id, 10);
    const submittedNetwork = (body.network || '').trim();
    // Pull just the http(s)://... portion out — catches the case where the
    // operator pastes the whole share blob from a streamer's app, like
    // "Check out X on Hulu! https://..."
    const url = extractUrl(body.network_url || '') || (body.network_url || '').trim();

    if (!Number.isInteger(id)) return json({ error: 'id required' }, 400);
    if (!submittedNetwork) return json({ error: 'network required' }, 400);
    if (!url) return json({ error: 'URL required' }, 400);

    const lower = url.toLowerCase();
    const looksLikeSearch =
      lower.includes('/search') || lower.includes('/s?') ||
      lower.includes('?q=') || lower.includes('?query=');
    if (looksLikeSearch) {
      return json({ error: 'That still looks like a search URL — paste the direct show URL.' }, 400);
    }

    // network_url gets rendered into hrefs and handed to openURL() on the
    // Apple targets, so hold it to the same http(s)-only bar every other
    // write path uses. extractUrl() already pulled the URL out of a share
    // blob; this rejects what's left when the paste had no real URL in it.
    if (!safeNetworkUrl(url)) {
      return json({ error: 'That needs to be a full http(s) URL — paste the link from the address bar.' }, 400);
    }

    // URL trumps the dropdown pick. If the pasted URL is a Netflix link but
    // the operator left the dropdown on Hulu, store Netflix.
    //
    // Apple is the exception: tv.apple.com is a storefront, not a service.
    // It carries Apple TV+ originals *and* rent/buy titles that stream on
    // someone else's subscription, so an Apple link says nothing about who
    // carries the show. Letting it overrule the dropdown relabels rentals as
    // Apple TV+ and inflates the Subscription Audit. Operator's pick wins.
    const derived = networkFromUrl(url);
    const network = (derived && derived !== 'Apple TV+')
      ? derived
      : canonicalNetwork(submittedNetwork);

    const titleRow = await env.DB.prepare('SELECT title, tmdb_id, tmdb_type, movie FROM shows_v WHERE id = ?').bind(id).first();
    if (!titleRow) return json({ error: 'Show not found' }, 404);
    // This show's copies: the same TMDB entry (plus unmatched copies of its
    // title), never a different film that shares the name.
    const same = sameShowWhere('shows', titleRow, { forWrite: true, hasTitle: false });

    // Apply to every copy of this show on the same service, plus any
    // rows that have no network yet. Don't overwrite rows that already
    // have a different specific network — the same title can legitimately
    // be carried by multiple services (e.g. All Her Fault on Peacock for
    // one member, Amazon for another).
    //
    // "No network yet" has to cover the empty string as well as NULL:
    // fetchQueue() treats '' as missing and surfaces those rows, so matching
    // only NULL here left them unsaveable with no way to tell from the UI.
    const result = await env.DB.prepare(
      `UPDATE shows SET network = ?, network_url = ?, enriched_at = datetime('now')
       WHERE ${same.sql} AND archived = 0
         AND (network = ? OR network IS NULL OR network = '')`
    ).bind(network, url, ...same.binds, network).run();

    // Zero changed rows means every copy of this title is on some other
    // service, so the guard above skipped all of them. That used to return
    // ok:true with updated:0, which the operator UI rendered as a check mark
    // and "Updated 0 copies" — indistinguishable from a save at a glance, and
    // the reason saves looked like they landed intermittently. Say so instead,
    // and name the services standing in the way.
    if (result.meta.changes === 0) {
      const { results: conflicts } = await env.DB.prepare(
        `SELECT DISTINCT network FROM shows
          WHERE ${same.sql} AND archived = 0
            AND network IS NOT NULL AND network != ''`
      ).bind(...same.binds).all();
      const names = (conflicts || []).map(c => c.network).join(', ');
      return json({
        error: `Nothing saved — every copy of "${titleRow.title}" is on ${names || 'another service'}, not ${network}. `
             + `Change the network dropdown to match the copies, or fix the network first.`,
        updated: 0,
      }, 409);
    }

    return json({ ok: true, updated: result.meta.changes });
  }

  if (action === 'inherit_networks') {
    const networksSet = await inheritNetworks(env);
    const urlsFilled = await propagateGoodUrls(env);
    return json({ ok: true, networks_set: networksSet, urls_filled: urlsFilled });
  }

  if (action === 'reclassify_storefronts') {
    return await reclassifyStorefronts(env, body);
  }


  if (action === 'fix_mismatch') {
    // Operator chose which side wins for a single mismatched row.
    // `keep: 'url'`   → change the row's network to whatever the URL points at.
    // `keep: 'network'` → drop the URL so the next fill pass picks one for the
    //                     stored network.
    const id = parseInt(body.id, 10);
    const keep = body.keep === 'network' ? 'network' : 'url';
    if (!Number.isInteger(id)) return json({ error: 'id required' }, 400);
    const row = await env.DB.prepare(
      'SELECT id, network, network_url FROM shows WHERE id = ?'
    ).bind(id).first();
    if (!row) return json({ error: 'row_not_found' }, 404);

    if (keep === 'url') {
      const derived = networkFromUrl(row.network_url);
      if (!derived) return json({ error: 'Could not derive network from URL' }, 400);
      await env.DB.prepare(
        `UPDATE shows SET network = ?, enriched_at = datetime('now') WHERE id = ?`
      ).bind(derived, id).run();
      return json({ ok: true, set_network: derived });
    }
    // keep === 'network': null out the URL
    await env.DB.prepare(
      `UPDATE shows SET network_url = NULL, enriched_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
    return json({ ok: true, cleared_url: true });
  }



  const shows = await fetchQueue(env);
  const networks = await fetchNetworks(env);
  const mismatches = await fetchMismatches(env);
  return json({ shows, networks, mismatches });
}

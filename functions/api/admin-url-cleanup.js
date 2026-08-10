import { canonicalNetwork, networkFromUrl, storefrontFromUrl } from '../_shared/networks.js';
import { extractUrl, safeNetworkUrl } from '../_shared/url-utils.js';
import { isAdmin } from '../_shared/admin.js';
import { fetchEnrichment, fetchAvailability } from '../_shared/enrichment.js';
import { renameShowCopies } from '../_shared/title-fix.js';

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
const QUEUE_FILTER = `
  s.archived = 0
  AND ${BAD_URL}
  AND LOWER(s.title) NOT IN (SELECT ltitle FROM url_cleanup_ignores)
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
    WHERE LOWER(s_good.title) = LOWER(s.title)
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
// scoped to (title, network). But when every other active copy of the title
// agrees on a service, the answer is unambiguous: adopt it. Titles whose
// copies disagree are left alone; picking a winner there is the conflict
// queue's job. Runs on demand from the Show Cleanup page's "Adopt networks"
// button, followed by a propagation pass so the newly-scoped rows pick up
// their siblings' URLs in the same click.
async function inheritNetworks(env) {
  const result = await env.DB.prepare(`
    UPDATE shows
       SET network = (SELECT s.network FROM shows s
                       WHERE LOWER(s.title) = LOWER(shows.title) AND s.archived = 0
                         AND s.network IS NOT NULL AND s.network != ''),
           enriched_at = datetime('now')
     WHERE archived = 0
       AND (network IS NULL OR network = '')
       AND (SELECT COUNT(DISTINCT s.network) FROM shows s
             WHERE LOWER(s.title) = LOWER(shows.title) AND s.archived = 0
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
       FROM shows
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

async function propagateGoodUrls(env) {
  // Before listing, push every known good URL out to any sibling row that's
  // still on a placeholder. Scoped to (title, network) because the same
  // title can live on multiple services — copying URLs across networks
  // would land members on the wrong streaming app at watch time.
  const { results: sources } = await env.DB.prepare(
    `SELECT LOWER(title) as ltitle, network, network_url FROM shows
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
     GROUP BY LOWER(title), network`
  ).all();
  let filled = 0;
  for (const src of sources) {
    const result = await env.DB.prepare(
      `UPDATE shows
         SET network_url = ?,
             enriched_at = datetime('now')
       WHERE LOWER(title) = ? AND network = ? AND archived = 0
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
    ).bind(src.network_url, src.ltitle, src.network).run();
    filled += result.meta.changes;
  }
  return filled;
}

async function fetchQueue(env) {
  // One row per distinct title (case-insensitive), with all the member labels
  // for shows sharing that title.
  const { results } = await env.DB.prepare(`
    SELECT
      LOWER(s.title) AS ltitle,
      MIN(s.id) AS id,
      MIN(s.title) AS title,
      (SELECT s2.network FROM shows s2
        WHERE LOWER(s2.title) = LOWER(s.title) AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
        ORDER BY s2.id LIMIT 1) AS network,
      (SELECT s3.network_url FROM shows s3
        WHERE LOWER(s3.title) = LOWER(s.title) AND s3.archived = 0
        ORDER BY s3.id LIMIT 1) AS network_url,
      COUNT(*) AS member_count,
      GROUP_CONCAT(
        COALESCE(
          CASE WHEN m.first_name IS NOT NULL AND m.last_initial IS NOT NULL
               THEN m.first_name || ' ' || m.last_initial
               ELSE m.first_name END,
          s.member_slug),
        ', ') AS members
    FROM shows s
    LEFT JOIN members m ON m.slug = s.member_slug
    WHERE ${QUEUE_FILTER}
    GROUP BY LOWER(s.title)
    ORDER BY LOWER(COALESCE(network, 'zzz')), LOWER(s.title)
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

// Apply a title correction: enrich the new title, rename every active copy
// (member-safely — see renameShowCopies), and stamp the new title's artwork,
// rating, and cast onto the renamed rows. Drives the operator's fix_title
// action on the URL-cleanup queue.
async function commitTitleFix(env, oldTitle, rawNew, enriched) {
  let finalTitle = enriched.canonicalTitle || rawNew;
  // The operator is deliberately renaming away from oldTitle. When enrichment's
  // canonical title circles right back to it — TMDB/OMDB matched a same-named
  // entry (e.g. "Scarpetta" typed against a movie row collides with the 1918
  // short "Scarpetta e l'americana" in the movie index) — honoring canonical
  // would silently no-op the rename, which reads to the operator as the old
  // name stubbornly reappearing. Trust the operator's typed title in that case.
  if (finalTitle.trim().toLowerCase() === oldTitle.trim().toLowerCase()) {
    finalTitle = rawNew;
  }
  const renamed = await renameShowCopies(env, oldTitle, finalTitle);

  // Prefer the new title's artwork — the old title either had none (search
  // missed) or the wrong show's (search mismatched). Only keep the old value
  // when the new lookup returned nothing.
  await env.DB.prepare(
    `UPDATE shows
        SET rating = COALESCE(?, rating),
            poster_url = COALESCE(?, poster_url),
            network_logo_url = COALESCE(?, network_logo_url),
            overview = COALESCE(?, overview), backdrop_url = COALESCE(?, backdrop_url),
            tmdb_rating = COALESCE(?, tmdb_rating), content_rating = COALESCE(?, content_rating),
            trailer_key = COALESCE(?, trailer_key), director = COALESCE(?, director),
            runtime = COALESCE(?, runtime), release_year = COALESCE(?, release_year),
            network = COALESCE(network, ?), watch_link = COALESCE(?, watch_link),
            tmdb_id = COALESCE(?, tmdb_id), tmdb_type = COALESCE(?, tmdb_type)
      WHERE LOWER(title) = LOWER(?) AND archived = 0`
  ).bind(enriched.rating, enriched.posterUrl, enriched.networkLogoUrl,
    enriched.overview, enriched.backdropUrl, enriched.tmdbRating, enriched.contentRating,
    enriched.trailerKey, enriched.director, enriched.runtime, enriched.releaseYear,
    enriched.providerNetwork, enriched.watchLink, enriched.tmdbId, enriched.tmdbType, finalTitle).run();

  if (enriched.actors.length > 0) {
    const { results: copies } = await env.DB.prepare(
      'SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND archived = 0'
    ).bind(finalTitle).all();
    const ins = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
    for (const c of copies) {
      await env.DB.prepare('DELETE FROM actors WHERE show_id = ?').bind(c.id).run();
      await env.DB.batch(enriched.actors.map((a, i) => ins.bind(c.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
    }
  }

  return { finalTitle, updated: renamed };
}

// Titles where no active copy has a poster. Grouped by title (one card per
// title, with every member label) because artwork is per-title — a poster
// fetched for one copy covers all. These are the rows a stored title TMDB
// can't match on its own: a typo that stuck ("Marshalls"), a descriptive
// member-entered name, or a title only indexed under the opposite media type.
// The operator fixes them from the Missing-posters section: Re-enrich (a fresh
// TMDB lookup, media-type-flipping) or, when the title itself is wrong, Rename.
async function fetchNeedsPoster(env) {
  const { results } = await env.DB.prepare(`
    SELECT
      MIN(s.id) AS id,
      MIN(s.title) AS title,
      MAX(s.movie) AS movie,
      COUNT(*) AS member_count,
      GROUP_CONCAT(
        COALESCE(
          CASE WHEN m.first_name IS NOT NULL AND m.last_initial IS NOT NULL
               THEN m.first_name || ' ' || m.last_initial
               ELSE m.first_name END,
          s.member_slug),
        ', ') AS members
    FROM shows s
    LEFT JOIN members m ON m.slug = s.member_slug
    WHERE s.archived = 0
    GROUP BY LOWER(s.title)
    HAVING MAX(CASE WHEN s.poster_url IS NOT NULL AND s.poster_url != '' THEN 1 ELSE 0 END) = 0
    ORDER BY LOWER(s.title)
  `).all();
  return (results || []).map(r => ({
    id: r.id,
    title: r.title,
    movie: r.movie,
    member_count: r.member_count,
    members: r.members,
  }));
}

// Titles where two or more members carry the show on different networks.
// Often a typo (member picked the wrong service) but sometimes legitimate
// (a title that lives on multiple services). Surface so the operator can
// pick a canonical answer for the title.
async function fetchConflicts(env) {
  const { results } = await env.DB.prepare(`
    SELECT LOWER(s.title) AS ltitle,
           MIN(s.title) AS title,
           COUNT(DISTINCT s.network) AS distinct_networks,
           GROUP_CONCAT(DISTINCT s.network) AS networks,
           COUNT(*) AS rows
      FROM shows s
     WHERE s.archived = 0
       AND s.network IS NOT NULL
     GROUP BY LOWER(s.title)
    HAVING COUNT(DISTINCT s.network) > 1
     ORDER BY distinct_networks DESC, rows DESC, LOWER(s.title)
  `).all();
  return (results || []).map(r => ({
    title: r.title,
    networks: (r.networks || '').split(',').filter(Boolean),
    rows: r.rows,
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
      FROM shows s
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

  if (!(await isAdmin(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const action = body.action || 'list';
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

    const titleRow = await env.DB.prepare('SELECT title FROM shows WHERE id = ?').bind(id).first();
    if (!titleRow) return json({ error: 'Show not found' }, 404);

    // Apply to every row sharing this title on the same service, plus any
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
       WHERE LOWER(title) = LOWER(?) AND archived = 0
         AND (network = ? OR network IS NULL OR network = '')`
    ).bind(network, url, titleRow.title, network).run();

    // Zero changed rows means every copy of this title is on some other
    // service, so the guard above skipped all of them. That used to return
    // ok:true with updated:0, which the operator UI rendered as a check mark
    // and "Updated 0 copies" — indistinguishable from a save at a glance, and
    // the reason saves looked like they landed intermittently. Say so instead,
    // and name the services standing in the way.
    if (result.meta.changes === 0) {
      const { results: conflicts } = await env.DB.prepare(
        `SELECT DISTINCT network FROM shows
          WHERE LOWER(title) = LOWER(?) AND archived = 0
            AND network IS NOT NULL AND network != ''`
      ).bind(titleRow.title).all();
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

  if (action === 'resolve_conflict') {
    // Operator picked the canonical network for a title where members
    // disagreed. Set every active row to that network and clear any
    // network_url that came from a wrong-network propagation so the
    // next fill pass picks the right URL per the chosen network.
    const title = String(body.title || '').trim();
    const network = canonicalNetwork(String(body.network || '').trim());
    if (!title) return json({ error: 'title required' }, 400);
    if (!network) return json({ error: 'network required' }, 400);
    const result = await env.DB.prepare(
      `UPDATE shows
          SET network = ?,
              network_url = CASE WHEN network = ? THEN network_url ELSE NULL END,
              enriched_at = datetime('now')
        WHERE LOWER(title) = LOWER(?) AND archived = 0`
    ).bind(network, network, title).run();
    return json({ ok: true, updated: result.meta.changes });
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

  if (action === 'fix_title') {
    // Operator corrects a wrong/typo'd title. Re-run enrichment on the new
    // title (canonical title + rating + cast), then rename every active copy
    // of the old title and refresh their cast. Fixes both failure modes:
    // enrichment matched the wrong show, or matched nothing and the typo stuck.
    // Optional `network`: the operator can correct the service at the same
    // time (same semantics as resolve_conflict — every active copy moves to
    // the chosen network, and URLs that pointed at the old service are
    // cleared so the next fill pass picks the right one).
    const id = parseInt(body.id, 10);
    const rawNew = String(body.new_title || '').trim();
    const submittedNetwork = String(body.network || '').trim();
    // Optional direct URL: lets the operator set a watch link straight from the
    // Missing-posters card (which otherwise has no URL field). Same paste-blob
    // tolerance as the save action.
    const rawUrl = extractUrl(body.network_url || '') || (body.network_url || '').trim();
    if (!Number.isInteger(id)) return json({ error: 'id required' }, 400);
    if (!rawNew) return json({ error: 'new title required' }, 400);

    // Validate the URL and resolve its network up front — before we rename —
    // so a bad paste can't leave a half-applied fix (title renamed, URL rejected).
    let urlNetwork = null;
    if (rawUrl) {
      const lower = rawUrl.toLowerCase();
      const looksLikeSearch =
        lower.includes('/search') || lower.includes('/s?') ||
        lower.includes('?q=') || lower.includes('?query=');
      if (looksLikeSearch) {
        return json({ error: 'That still looks like a search URL — paste the direct show URL.' }, 400);
      }
      // URL trumps the dropdown pick, same as the save action.
      urlNetwork = networkFromUrl(rawUrl) || (submittedNetwork ? canonicalNetwork(submittedNetwork) : null);
      if (!urlNetwork) return json({ error: 'Pick a network for that URL.' }, 400);
    }

    const row = await env.DB.prepare('SELECT title, movie FROM shows WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Show not found' }, 404);
    const oldTitle = row.title;

    // Optional media-type correction from the card's Show/Movie toggle. Flipping
    // it makes enrichment search the right TMDB index — the reason a movie row
    // like "Scarpetta e l'americana" could never resolve to the TV series.
    const movieOverride = (body.movie === 0 || body.movie === 1) ? body.movie : null;
    const isMovie = movieOverride !== null ? !!movieOverride : !!row.movie;

    const enriched = await fetchEnrichment(rawNew, env, isMovie);
    const { finalTitle, updated } = await commitTitleFix(env, oldTitle, rawNew, enriched);
    if (movieOverride !== null) {
      await env.DB.prepare(
        `UPDATE shows SET movie = ?, enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND archived = 0`
      ).bind(movieOverride, finalTitle).run();
    }

    let network = null;
    if (rawUrl) {
      // Set the operator's direct URL on every copy of the (freshly renamed)
      // title that shares this network or has none — mirrors the save action's
      // scoping so a sibling on a different service isn't clobbered.
      network = urlNetwork;
      await env.DB.prepare(
        `UPDATE shows SET network = ?, network_url = ?, enriched_at = datetime('now')
          WHERE LOWER(title) = LOWER(?) AND archived = 0 AND (network = ? OR network IS NULL)`
      ).bind(network, rawUrl, finalTitle, network).run();
    } else if (submittedNetwork) {
      network = canonicalNetwork(submittedNetwork);
      await env.DB.prepare(
        `UPDATE shows
            SET network_url = CASE WHEN network = ? THEN network_url ELSE NULL END,
                network = ?,
                enriched_at = datetime('now')
          WHERE LOWER(title) = LOWER(?) AND archived = 0`
      ).bind(network, network, finalTitle).run();
    }

    return json({ ok: true, old_title: oldTitle, new_title: finalTitle, network, network_url: rawUrl || null, updated });
  }

  if (action === 're_enrich') {
    // Force a fresh TMDB lookup for a poster-less title without renaming it —
    // for titles that are spelled right but never matched (added before TMDB
    // had the entry, or only indexed under the opposite media type, which
    // fetchEnrichment flips for). Writes any artwork/rating found onto every
    // active copy; fills cast only where a copy has none. When nothing turns
    // up, stamps enriched_at so the title rotates to the back of the queue.
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id)) return json({ error: 'id required' }, 400);
    const row = await env.DB.prepare('SELECT title, movie FROM shows WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Show not found' }, 404);

    // Optional media-type correction from the card's Show/Movie toggle, so the
    // fresh lookup searches the right TMDB index.
    const movieOverride = (body.movie === 0 || body.movie === 1) ? body.movie : null;
    if (movieOverride !== null) {
      await env.DB.prepare(
        `UPDATE shows SET movie = ? WHERE LOWER(title) = LOWER(?) AND archived = 0`
      ).bind(movieOverride, row.title).run();
    }
    const isMovie = movieOverride !== null ? !!movieOverride : !!row.movie;

    const enriched = await fetchEnrichment(row.title, env, isMovie);
    if (enriched.posterUrl || enriched.networkLogoUrl || enriched.rating || enriched.overview) {
      await env.DB.prepare(
        `UPDATE shows
            SET poster_url = COALESCE(?, poster_url),
                network_logo_url = COALESCE(?, network_logo_url),
                rating = COALESCE(?, rating),
                overview = COALESCE(?, overview), backdrop_url = COALESCE(?, backdrop_url),
                tmdb_rating = COALESCE(?, tmdb_rating), content_rating = COALESCE(?, content_rating),
                trailer_key = COALESCE(?, trailer_key), director = COALESCE(?, director),
                runtime = COALESCE(?, runtime), release_year = COALESCE(?, release_year),
                network = COALESCE(network, ?), watch_link = COALESCE(?, watch_link),
                tmdb_id = COALESCE(?, tmdb_id), tmdb_type = COALESCE(?, tmdb_type),
                enriched_at = datetime('now')
          WHERE LOWER(title) = LOWER(?) AND archived = 0`
      ).bind(enriched.posterUrl, enriched.networkLogoUrl, enriched.rating,
        enriched.overview, enriched.backdropUrl, enriched.tmdbRating, enriched.contentRating,
        enriched.trailerKey, enriched.director, enriched.runtime, enriched.releaseYear,
        enriched.providerNetwork, enriched.watchLink, enriched.tmdbId, enriched.tmdbType, row.title).run();
    } else {
      // Nothing found — stamp so the title rotates to the back of the
      // oldest-first background pass instead of blocking it every round.
      await env.DB.prepare(
        `UPDATE shows SET enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND archived = 0`
      ).bind(row.title).run();
    }

    // Fill cast on any copy that has none (TMDB actors only — the fallback
    // can't supply IMDB ids, so there's nothing to gain from OMDB-only rows).
    if ((enriched.actors || []).some(a => a.imdb_id)) {
      const { results: copies } = await env.DB.prepare(
        'SELECT id FROM shows WHERE LOWER(title) = LOWER(?) AND archived = 0'
      ).bind(row.title).all();
      const ins = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id, ord, tmdb_person_id) VALUES (?, ?, ?, ?, ?)');
      for (const c of copies) {
        const have = await env.DB.prepare('SELECT COUNT(*) AS c FROM actors WHERE show_id = ?').bind(c.id).first();
        if (have.c === 0) await env.DB.batch(enriched.actors.map((a, i) => ins.bind(c.id, a.name, a.imdb_id || null, a.ord ?? i, a.tmdb_person_id ?? null)));
      }
    }

    return json({ ok: true, poster: !!enriched.posterUrl, title: enriched.canonicalTitle || row.title });
  }

  await propagateGoodUrls(env);
  const shows = await fetchQueue(env);
  const networks = await fetchNetworks(env);
  const conflicts = await fetchConflicts(env);
  const mismatches = await fetchMismatches(env);
  const needsPoster = await fetchNeedsPoster(env);
  return json({ shows, networks, conflicts, mismatches, needsPoster });
}

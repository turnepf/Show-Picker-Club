import { canonicalNetwork, networkFromUrl } from '../_shared/networks.js';
import { extractUrl } from '../_shared/url-utils.js';
import { isAdmin } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  -- Exempt HBO Max search-fallback URLs: they're the best deep link we
  -- can offer for titles Watchmode only knows as auto-play URLs, so
  -- they shouldn't show up in the queue every cleanup pass. Two shapes:
  -- /search?q=... (our auto-generated fallback) and /search/result?q=...
  -- (operator-pasted from HBO Max's own search-results page).
  AND s.network_url NOT LIKE 'https://play.hbomax.com/search?%'
  AND s.network_url NOT LIKE 'https://play.hbomax.com/search/result?%'
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
  for (const src of sources) {
    await env.DB.prepare(
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
  }
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
    return json({ error: 'Forbidden — log in as the operator' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const action = body.action || 'list';

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

    // URL trumps the dropdown pick. If the pasted URL is a Netflix link but
    // the operator left the dropdown on Hulu, store Netflix.
    const network = networkFromUrl(url) || canonicalNetwork(submittedNetwork);

    const titleRow = await env.DB.prepare('SELECT title FROM shows WHERE id = ?').bind(id).first();
    if (!titleRow) return json({ error: 'Show not found' }, 404);

    // Apply to every row sharing this title on the same service, plus any
    // rows that have no network yet. Don't overwrite rows that already
    // have a different specific network — the same title can legitimately
    // be carried by multiple services (e.g. All Her Fault on Peacock for
    // one member, Amazon for another).
    const result = await env.DB.prepare(
      `UPDATE shows SET network = ?, network_url = ?, enriched_at = datetime('now')
       WHERE LOWER(title) = LOWER(?) AND archived = 0
         AND (network = ? OR network IS NULL)`
    ).bind(network, url, titleRow.title, network).run();

    return json({ ok: true, updated: result.meta.changes });
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

  await propagateGoodUrls(env);
  const shows = await fetchQueue(env);
  const networks = await fetchNetworks(env);
  const conflicts = await fetchConflicts(env);
  const mismatches = await fetchMismatches(env);
  return json({ shows, networks, conflicts, mismatches });
}

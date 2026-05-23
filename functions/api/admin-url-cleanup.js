import { canonicalNetwork, networkFromUrl } from '../_shared/networks.js';
import { extractUrl } from '../_shared/url-utils.js';

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
  -- skip titles already resolvable from another member's good URL —
  -- sync-urls will propagate those automatically, nothing for admin to do.
  AND NOT EXISTS (
    SELECT 1 FROM shows s_good
    WHERE LOWER(s_good.title) = LOWER(s.title)
      AND s_good.archived = 0
      AND s_good.network IS NOT NULL
      AND s_good.network_url IS NOT NULL
      AND s_good.network_url NOT LIKE '%/search%'
      AND s_good.network_url NOT LIKE '%/s?%'
      AND s_good.network_url NOT LIKE '%?q=%'
      AND s_good.network_url NOT LIKE '%?query=%'
      AND s_good.network_url NOT LIKE 'https://www.max.com/%'
      AND s_good.network_url NOT LIKE 'https://www.hbomax.com/%'
      AND s_good.network_url NOT LIKE 'https://www.themoviedb.org/%'
      AND s_good.network_url != 'https://www.amazon.com/s'
      AND s_good.network_url != 'https://www.amazon.com/s/'
  )
`;

async function propagateGoodUrls(env) {
  // Before listing, push every known good URL out to any sibling row that's
  // still on a placeholder. Keeps the queue from showing titles that one
  // member has already fixed but the daily sync-urls hasn't caught up on.
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
       AND network_url NOT LIKE 'https://www.themoviedb.org/%'
       AND network_url != 'https://www.amazon.com/s'
       AND network_url != 'https://www.amazon.com/s/'
     GROUP BY LOWER(title)`
  ).all();
  for (const src of sources) {
    await env.DB.prepare(
      `UPDATE shows
         SET network_url = ?,
             network = COALESCE(network, ?),
             enriched_at = datetime('now')
       WHERE LOWER(title) = ? AND archived = 0
         AND (network_url IS NULL
              OR network_url LIKE '%/search%'
              OR network_url LIKE '%/s?%'
              OR network_url LIKE '%?q=%'
              OR network_url LIKE '%?query=%'
              OR network_url LIKE 'https://www.max.com/%'
              OR network_url LIKE 'https://www.hbomax.com/%'
              OR network_url LIKE 'https://www.themoviedb.org/%'
              OR network_url = 'https://www.amazon.com/s'
              OR network_url = 'https://www.amazon.com/s/')`
    ).bind(src.network_url, src.network, src.ltitle).run();
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

async function fetchNetworks(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT network FROM shows WHERE network IS NOT NULL AND network != '' ORDER BY network COLLATE NOCASE"
  ).all();
  return results.map(r => r.network);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ADMIN_SECRET) {
    return json({ error: 'ADMIN_SECRET not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Invalid secret' }, 401);
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

    // Apply to every active row sharing this title — across all members.
    const result = await env.DB.prepare(
      "UPDATE shows SET network = ?, network_url = ?, enriched_at = datetime('now') WHERE LOWER(title) = LOWER(?) AND archived = 0"
    ).bind(network, url, titleRow.title).run();

    return json({ ok: true, updated: result.meta.changes });
  }

  await propagateGoodUrls(env);
  const shows = await fetchQueue(env);
  const networks = await fetchNetworks(env);
  return json({ shows, networks });
}

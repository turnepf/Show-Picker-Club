import { getSession } from '../_shared/auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Find shows with "good" URLs (not generic search pages), grouped by
  // (title, network) so we never copy a URL from one network's row onto
  // another's. A title can live on multiple services (e.g. All Her Fault
  // on Peacock vs Amazon vs Hulu) — propagating across them used to
  // serve members a streaming-app URL that didn't match their stored
  // network.
  const { results: withUrls } = await env.DB.prepare(
    `SELECT LOWER(title) as ltitle, network, network_url FROM shows
     WHERE archived = 0
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url != '#'
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
     GROUP BY LOWER(title), network`
  ).all();

  if (withUrls.length === 0) {
    return new Response(JSON.stringify({ synced: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let synced = 0;
  for (const source of withUrls) {
    const result = await env.DB.prepare(
      `UPDATE shows SET network_url = ?, enriched_at = datetime('now')
       WHERE LOWER(title) = ? AND network = ? AND archived = 0
         AND (network_url IS NULL OR network_url LIKE '%/search%' OR network_url LIKE '%/s?%')`
    ).bind(source.network_url, source.ltitle, source.network).run();
    synced += result.meta.changes;
  }

  return new Response(JSON.stringify({ synced }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

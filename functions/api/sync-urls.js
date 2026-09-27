import { getSession } from '../_shared/auth.js';
import { demoMemberSlug } from '../_shared/demo.js';
import { networkFromUrl } from '../_shared/networks.js';
import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';

// Copies a real deep link from one member's copy of a title onto every other
// active copy on the same service that has only a placeholder.
//
// This is a club-wide sweep: its cost grows with the whole library, one UPDATE
// per distinct (title, service), whoever asks. It used to run for any member
// session, paced only by a localStorage timer in the web app, so one account
// could run it in a loop. It now runs nightly from watch-urls-fill.yml
// (X-Cron-Secret) or by an admin. A member session still gets the old
// `{synced, skipped}` answer with nothing done, so the web app's
// once-a-day call keeps working unchanged. New rows don't wait for the
// nightly run: /api/shows inherits a sibling's link on insert.
const BATCH = 50;

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  const cron = await cronAuthorized(request, env);
  if (!session && !cron) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!cron && !(await isAdmin(request, env))) {
    return new Response(JSON.stringify({ synced: 0, skipped: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Never treat the shared demo account's rows as a URL source — strangers
  // can edit them, and this endpoint propagates URLs to every member.
  const demoSlug = await demoMemberSlug(env);

  // Find shows with "good" URLs (not generic search pages), grouped by
  // (title, network) so we never copy a URL from one network's row onto
  // another's. A title can live on multiple services (e.g. All Her Fault
  // on Peacock vs Amazon vs Hulu) — propagating across them used to
  // serve members a streaming-app URL that didn't match their stored
  // network.
  const { results: withUrls } = await env.DB.prepare(
    `SELECT LOWER(title) as ltitle, network, network_url, tmdb_id FROM shows
     WHERE archived = 0
       AND network IS NOT NULL
       AND network_url IS NOT NULL
       AND network_url != '#'
       AND network_url NOT LIKE '%/search%'
       AND network_url NOT LIKE '%/s?%'
       AND (?1 IS NULL OR member_slug != ?1)
     GROUP BY LOWER(title), network, tmdb_id`
  ).bind(demoSlug).all();

  if (withUrls.length === 0) {
    return new Response(JSON.stringify({ synced: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let synced = 0;
  let skipped = 0;
  const updates = [];
  for (const source of withUrls) {
    // Provenance gate. network_url has two writers with very different trust:
    // Watchmode/TMDB enrichment, and a member's own request body (api/shows.js
    // accepts a pasted network_url, and safeNetworkUrl only checks the scheme
    // and the character class — any host passes). Signup is open and
    // self-service, so "another member" is not a trusted source, and the
    // demo-account exclusion above is a one-account denylist that a newly
    // registered account walks straight around. Only a URL whose host
    // canonicalizes to this row's own service may be pushed onto everybody
    // else's rows; anything else stays on the row that already has it.
    // `skipped` is reported so a provider host missing from the domain index
    // in _shared/networks.js shows up as a number to go fix, rather than as
    // this feature quietly narrowing.
    if (networkFromUrl(source.network_url) !== source.network) { skipped++; continue; }

    updates.push(env.DB.prepare(
      `UPDATE shows SET network_url = ?, enriched_at = datetime('now')
       WHERE LOWER(title) = ? AND network = ? AND archived = 0
         AND (tmdb_id IS NULL OR ? IS NULL OR tmdb_id = ?)
         AND (network_url IS NULL OR network_url LIKE '%/search%' OR network_url LIKE '%/s?%')`
    ).bind(source.network_url, source.ltitle, source.network, source.tmdb_id, source.tmdb_id));
  }

  // Batched so a growing library costs round trips in fiftieths rather than
  // one per title.
  for (let i = 0; i < updates.length; i += BATCH) {
    const results = await env.DB.batch(updates.slice(i, i + BATCH));
    for (const r of results || []) synced += r?.meta?.changes || 0;
  }

  return new Response(JSON.stringify({ synced, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

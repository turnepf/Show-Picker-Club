import { getSession } from '../_shared/auth.js';
import { canonicalNetwork, defaultPriceCents, isStorefront } from '../_shared/networks.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

const VALID_STATUS = new Set(['subscribed', 'paused', 'cancelled']);

// Verdicts the audit can assign to a service, in priority order:
//   keep      — actively watching something here now
//   pause     — nothing watching, but a waiting show has a known future season
//   pause_tba — waiting shows, but no announced next-season date yet
//   start     — only "next up" shows: start one or skip the service
//   cancel    — only finished/recommending shows; nothing pulls you back
function computeVerdict(s) {
  if (s.watching > 0) {
    return { verdict: 'keep', resubscribe_date: null };
  }
  if (s.soonest_upcoming) {
    return { verdict: 'pause', resubscribe_date: s.soonest_upcoming };
  }
  if (s.waiting > 0) {
    return { verdict: 'pause_tba', resubscribe_date: null };
  }
  if (s.next > 0) {
    return { verdict: 'start', resubscribe_date: null };
  }
  return { verdict: 'cancel', resubscribe_date: null };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  const slug = session.member_slug;
  const today = new Date().toISOString().slice(0, 10);

  // Pool shows across the member + their saved household so a service that
  // anyone in the household is watching counts as "keep" for the shared plan.
  const { results: hhRows } = await env.DB.prepare(
    'SELECT other_slug FROM household_members WHERE member_slug = ?'
  ).bind(slug).all().catch(() => ({ results: [] }));
  const householdSlugs = (hhRows || []).map((r) => r.other_slug);
  const auditSlugs = [slug, ...householdSlugs];
  const slugPlaceholders = auditSlugs.map(() => '?').join(',');
  // Only a real household (someone besides you) makes "who's watching this?"
  // a question worth answering — solo audits stay unchanged.
  const hasHousehold = householdSlugs.length > 0;

  const [{ results: shows }, { results: saved }, { results: memberRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT member_slug, title, network, list, next_season_date, full_series
       FROM shows_v
       WHERE member_slug IN (${slugPlaceholders}) AND archived = 0 AND network IS NOT NULL AND network != ''`
    ).bind(...auditSlugs).all(),
    env.DB.prepare(
      `SELECT network, status, monthly_price_cents, resubscribe_date, is_manual
       FROM member_subscriptions WHERE member_slug = ?`
    ).bind(slug).all(),
    env.DB.prepare(
      `SELECT slug, name, first_name, last_initial FROM members WHERE slug IN (${slugPlaceholders})`
    ).bind(...auditSlugs).all().catch(() => ({ results: [] })),
  ]);

  // First-name labels for everyone pooled into this audit, disambiguated by a
  // last initial when two of them share a first name — same rule as
  // /api/members and /api/household, so a name means the same person
  // everywhere. You are always "You".
  const nameCounts = {};
  for (const m of memberRows || []) {
    const fn = m.first_name || (m.name || '').split(' ')[0];
    nameCounts[fn] = (nameCounts[fn] || 0) + 1;
  }
  const labelBySlug = new Map();
  for (const m of memberRows || []) {
    const fn = m.first_name || (m.name || '').split(' ')[0];
    labelBySlug.set(m.slug, nameCounts[fn] > 1 && m.last_initial ? `${fn} ${m.last_initial}` : fn);
  }
  const viewerName = (s) => (s === slug ? 'You' : labelBySlug.get(s) || s);

  // Group shows under their canonical network. Household pooling can surface
  // the same title from more than one member, so dedupe per network by title,
  // keeping the most-active list (watching > waiting > next up > loved) so the
  // verdict reflects whoever in the household is furthest along. Each deduped
  // title also remembers who it came from and what list it sits on for them,
  // so a shared audit can name the person behind the verdict.
  const LIST_PRIORITY = { watching: 4, waiting: 3, next: 2, recommending: 1 };
  const byNetwork = new Map();
  for (const sh of shows) {
    const net = canonicalNetwork(sh.network);
    if (!net) continue;
    // Storefronts (Apple TV Store, Fandango at Home) are rent/buy shops, not
    // monthly services. A title bought there is never an argument for keeping
    // or starting a subscription, so it must not become a card in the audit —
    // that is exactly how Apple rentals stored as "Apple TV+" overstated what
    // members needed to pay for.
    if (isStorefront(net)) continue;
    if (!byNetwork.has(net)) {
      byNetwork.set(net, { network: net, titles: new Map(), soonest_upcoming: null });
    }
    const g = byNetwork.get(net);
    const key = (sh.title || '').toLowerCase();
    let entry = g.titles.get(key);
    if (!entry) {
      entry = { title: sh.title, list: null, next_season_date: null, full_series: 0, viewers: new Map() };
      g.titles.set(key, entry);
    }
    if (entry.list == null || (LIST_PRIORITY[sh.list] || 0) > (LIST_PRIORITY[entry.list] || 0)) {
      entry.title = sh.title;
      entry.list = sh.list;
      entry.next_season_date = sh.next_season_date || null;
      entry.full_series = sh.full_series ? 1 : 0;
    }
    // Per-person list, so "watching" next to one name and "next up" next to
    // another is preserved rather than flattened into the headline list.
    const prevList = entry.viewers.get(sh.member_slug);
    if (prevList == null || (LIST_PRIORITY[sh.list] || 0) > (LIST_PRIORITY[prevList] || 0)) {
      entry.viewers.set(sh.member_slug, sh.list);
    }
    // Soonest future premiere among "waiting" shows → the resubscribe target.
    if (sh.list === 'waiting' && sh.next_season_date && sh.next_season_date >= today) {
      if (!g.soonest_upcoming || sh.next_season_date < g.soonest_upcoming) {
        g.soonest_upcoming = sh.next_season_date;
      }
    }
  }

  const savedByNet = new Map();
  for (const r of saved) savedByNet.set(r.network, r);

  // Turn the per-title viewer map into an ordered list (you first, then the
  // rest alphabetically). Emitted only for a real household — on a solo audit
  // every show is yours and naming a viewer says nothing.
  function viewersFor(entry) {
    return [...entry.viewers.entries()]
      .map(([s, list]) => ({ slug: s, name: viewerName(s), list }))
      .sort((a, b) => (a.slug === slug ? -1 : b.slug === slug ? 1 : a.name.localeCompare(b.name)));
  }

  const services = [];
  for (const g of byNetwork.values()) {
    const showsArr = [...g.titles.values()].map((entry) => ({
      title: entry.title,
      list: entry.list,
      next_season_date: entry.next_season_date,
      full_series: entry.full_series,
      ...(hasHousehold ? { viewers: viewersFor(entry) } : {}),
    }));
    const counts = { watching: 0, waiting: 0, recommending: 0, next: 0 };
    for (const s of showsArr) if (counts[s.list] != null) counts[s.list]++;
    const { verdict, resubscribe_date } = computeVerdict({ ...counts, soonest_upcoming: g.soonest_upcoming });
    const sv = savedByNet.get(g.network);
    const price = sv && sv.monthly_price_cents != null ? sv.monthly_price_cents : defaultPriceCents(g.network);
    services.push({
      network: g.network,
      is_manual: false,
      counts,
      shows: showsArr,
      verdict,
      suggested_resubscribe_date: resubscribe_date,
      // Saved member decisions (null until they act).
      status: sv ? sv.status : null,
      monthly_price_cents: price,
      resubscribe_date: sv ? sv.resubscribe_date : null,
    });
  }

  // Manual services the member added that have no tracked shows.
  for (const r of saved) {
    if (!r.is_manual) continue;
    if (byNetwork.has(r.network)) continue; // already represented by real shows
    services.push({
      network: r.network,
      is_manual: true,
      counts: { watching: 0, waiting: 0, recommending: 0, next: 0 },
      shows: [],
      verdict: 'manual',
      suggested_resubscribe_date: null,
      status: r.status,
      monthly_price_cents: r.monthly_price_cents != null ? r.monthly_price_cents : defaultPriceCents(r.network),
      resubscribe_date: r.resubscribe_date,
    });
  }

  // Sort: keep first, then pause/start/cancel, manual last; alpha within group.
  const order = { keep: 0, start: 1, pause: 2, pause_tba: 2, cancel: 3, manual: 4 };
  services.sort((a, b) =>
    (order[a.verdict] - order[b.verdict]) || a.network.localeCompare(b.network)
  );

  // Effective status: an untouched service is assumed subscribed (you have
  // shows on it, or you added it manually).
  let monthlySpendCents = 0;
  let potentialSavingsCents = 0;
  for (const sv of services) {
    const status = sv.status || 'subscribed';
    if (status === 'cancelled') continue;
    const p = sv.monthly_price_cents || 0;
    monthlySpendCents += p;
    if (sv.verdict === 'cancel' || sv.verdict === 'pause' || sv.verdict === 'pause_tba') {
      potentialSavingsCents += p;
    }
  }

  // calendar_token: the page links "Shows calendar", and the feed now
  // authenticates with this per-member secret. Null pre-migration.
  const memberRow = await env.DB.prepare(
    'SELECT calendar_token FROM members WHERE slug = ?'
  ).bind(slug).first().catch(() => null);

  // Household member labels, for the "including …" line on the audit. Same
  // labels the per-show viewers use, from the one members lookup above.
  const household = householdSlugs
    .filter((s) => labelBySlug.has(s))
    .map((s) => ({ slug: s, name: labelBySlug.get(s) }));

  return new Response(JSON.stringify({
    member: slug,
    calendar_token: memberRow?.calendar_token || null,
    today,
    household,
    services,
    totals: {
      service_count: services.length,
      monthly_spend_cents: monthlySpendCents,
      potential_savings_cents: potentialSavingsCents,
    },
  }), { headers: corsHeaders() });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  const slug = session.member_slug;

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const network = typeof body.network === 'string' ? body.network.trim() : '';
  if (!network) {
    return new Response(JSON.stringify({ error: 'network required' }), { status: 400, headers: corsHeaders() });
  }

  // Remove a manual service entirely.
  if (body.remove) {
    await env.DB.prepare(
      `DELETE FROM member_subscriptions WHERE member_slug = ? AND network = ? AND is_manual = 1`
    ).bind(slug, network).run();
    return new Response(JSON.stringify({ ok: true, removed: true }), { headers: corsHeaders() });
  }

  if (body.status != null && !VALID_STATUS.has(body.status)) {
    return new Response(JSON.stringify({ error: 'invalid status' }), { status: 400, headers: corsHeaders() });
  }
  const resub = body.resubscribe_date;
  if (resub != null && resub !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(resub)) {
    return new Response(JSON.stringify({ error: 'invalid resubscribe_date' }), { status: 400, headers: corsHeaders() });
  }

  const status = body.status || 'subscribed';
  const price = body.monthly_price_cents != null ? Math.max(0, Math.round(body.monthly_price_cents)) : null;
  const isManual = body.is_manual ? 1 : 0;
  const resubscribe = resub ? resub : null;
  // Which fields did the caller actually send? On an update we only overwrite
  // those, so a status change doesn't wipe a saved price (and vice versa).
  const setStatus = body.status != null ? 1 : 0;
  const setPrice = body.monthly_price_cents != null ? 1 : 0;
  const setResub = resub !== undefined ? 1 : 0;

  // Upsert. is_manual stays 1 once set, so a manual service is never demoted
  // by a later edit. Placeholders are plain positional `?` in bind() order.
  await env.DB.prepare(
    `INSERT INTO member_subscriptions
       (member_slug, network, status, monthly_price_cents, resubscribe_date, is_manual)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_slug, network) DO UPDATE SET
       status = CASE WHEN ? THEN excluded.status ELSE member_subscriptions.status END,
       monthly_price_cents = CASE WHEN ? THEN excluded.monthly_price_cents ELSE member_subscriptions.monthly_price_cents END,
       resubscribe_date = CASE WHEN ? THEN excluded.resubscribe_date ELSE member_subscriptions.resubscribe_date END,
       is_manual = MAX(member_subscriptions.is_manual, excluded.is_manual),
       updated_at = datetime('now')`
  ).bind(
    slug, network, status, price, resubscribe, isManual,
    setStatus, setPrice, setResub,
  ).run();

  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

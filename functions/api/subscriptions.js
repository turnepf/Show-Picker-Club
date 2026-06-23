import { getSession } from '../_shared/auth.js';
import { canonicalNetwork, defaultPriceCents } from '../_shared/networks.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

const VALID_STATUS = new Set(['subscribed', 'paused', 'cancelled']);

// Verdicts the audit can assign to a service, in priority order:
//   keep      — actively watching something here now
//   pause     — nothing watching, but a waiting show has a known future season
//   pause_tba — waiting shows, but no announced next-season date yet
//   start     — only "up next" shows: start one or skip the service
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

  const [{ results: shows }, { results: saved }] = await Promise.all([
    env.DB.prepare(
      `SELECT title, network, list, next_season_date, full_series
       FROM shows
       WHERE member_slug = ? AND archived = 0 AND network IS NOT NULL AND network != ''`
    ).bind(slug).all(),
    env.DB.prepare(
      `SELECT network, status, monthly_price_cents, resubscribe_date, is_manual
       FROM member_subscriptions WHERE member_slug = ?`
    ).bind(slug).all(),
  ]);

  // Group shows under their canonical network.
  const byNetwork = new Map();
  for (const sh of shows) {
    const net = canonicalNetwork(sh.network);
    if (!net) continue;
    if (!byNetwork.has(net)) {
      byNetwork.set(net, { network: net, watching: 0, waiting: 0, recommending: 0, next: 0, soonest_upcoming: null, shows: [] });
    }
    const g = byNetwork.get(net);
    if (g[sh.list] != null) g[sh.list]++;
    // Soonest future premiere among "waiting" shows → the resubscribe target.
    if (sh.list === 'waiting' && sh.next_season_date && sh.next_season_date >= today) {
      if (!g.soonest_upcoming || sh.next_season_date < g.soonest_upcoming) {
        g.soonest_upcoming = sh.next_season_date;
      }
    }
    g.shows.push({
      title: sh.title,
      list: sh.list,
      next_season_date: sh.next_season_date || null,
      full_series: sh.full_series ? 1 : 0,
    });
  }

  const savedByNet = new Map();
  for (const r of saved) savedByNet.set(r.network, r);

  const services = [];
  for (const g of byNetwork.values()) {
    const { verdict, resubscribe_date } = computeVerdict(g);
    const sv = savedByNet.get(g.network);
    const price = sv && sv.monthly_price_cents != null ? sv.monthly_price_cents : defaultPriceCents(g.network);
    services.push({
      network: g.network,
      is_manual: false,
      counts: { watching: g.watching, waiting: g.waiting, recommending: g.recommending, next: g.next },
      shows: g.shows,
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

  return new Response(JSON.stringify({
    member: slug,
    today,
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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

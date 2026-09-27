import { getSession } from '../_shared/auth.js';

// Household members for the subscription audit. GET returns the caller's saved
// household plus the roster of other members to choose from; PUT replaces the
// caller's household set. The audit (/api/subscriptions) pools shows across the
// member + their saved household. Directed per-member — see migration 045.
//
// Adding somebody is their decision, not yours: a household is joined by
// invite link only (POST /api/household/invite, then POST /api/household/join
// under the joining member's own session). PUT survives for older builds and
// the web page, which save the whole set at once, but it can only narrow the
// set you already hold — it removes, it never adds. Before 2026-09 it wrote
// any slug it was handed, so a member could pool a stranger's library into
// their audit with no invite, no notice and no way for them to undo it.
//
// GET still returns the full roster (`members`) because the current iOS build
// resolves household slugs to names through it, and `member_of`: the
// households that include you, so a claim on you is visible and — through
// POST /api/household/remove, which works from either end — revocable.

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// First-name display names, disambiguated by a last initial when two members
// share a first name — mirrors /api/members so labels match across the app.
function displayNames(rows) {
  const counts = {};
  for (const m of rows) {
    const fn = m.first_name || (m.name || '').split(' ')[0];
    counts[fn] = (counts[fn] || 0) + 1;
  }
  return rows.map((m) => {
    const fn = m.first_name || (m.name || '').split(' ')[0];
    const name = counts[fn] > 1 && m.last_initial ? `${fn} ${m.last_initial}` : fn;
    return { slug: m.slug, name };
  });
}

async function rosterExcluding(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT slug, name, first_name, last_initial FROM members
      WHERE slug != ?
      ORDER BY name`
  ).bind(slug).all().catch(() => ({ results: [] }));
  return displayNames(results || []);
}

async function savedHousehold(env, slug) {
  const { results } = await env.DB.prepare(
    'SELECT other_slug FROM household_members WHERE member_slug = ?'
  ).bind(slug).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => r.other_slug);
}

async function householdsIncluding(env, slug) {
  const { results } = await env.DB.prepare(
    'SELECT member_slug FROM household_members WHERE other_slug = ?'
  ).bind(slug).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => r.member_slug);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  const slug = session.member_slug;
  const [members, household, member_of] = await Promise.all([
    rosterExcluding(env, slug),
    savedHousehold(env, slug),
    householdsIncluding(env, slug),
  ]);
  return new Response(JSON.stringify({ household, members, member_of }), { headers: corsHeaders() });
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
  const requested = Array.isArray(body.members)
    ? [...new Set(body.members.filter((s) => typeof s === 'string' && s && s !== slug))]
    : [];

  // Only people already in your household may stay in it. Anyone new has to
  // come in through an invite they redeem themselves.
  const current = new Set(await savedHousehold(env, slug));
  if (requested.some((s) => !current.has(s))) {
    return new Response(JSON.stringify({ error: 'household_invite_required' }), { status: 403, headers: corsHeaders() });
  }
  const valid = requested;

  // Replace the household set atomically-ish (delete then insert).
  await env.DB.prepare('DELETE FROM household_members WHERE member_slug = ?').bind(slug).run();
  if (valid.length) {
    const ins = env.DB.prepare(
      'INSERT OR IGNORE INTO household_members (member_slug, other_slug) VALUES (?, ?)'
    );
    await env.DB.batch(valid.map((s) => ins.bind(slug, s)));
  }

  return new Response(JSON.stringify({ ok: true, household: valid }), { headers: corsHeaders() });
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

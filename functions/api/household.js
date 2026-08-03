import { getSession } from '../_shared/auth.js';

// Household members for the subscription audit. GET returns the caller's saved
// household plus the roster of other members to choose from; PUT replaces the
// caller's household set. The audit (/api/subscriptions) pools shows across the
// member + their saved household. Directed per-member — see migration 045.
//
// Backward compatibility note: This endpoint exposes a full roster (household +
// members list) for older apps that use picker-based household selection. New
// apps should use the invite-based flow: POST /api/household/invite to generate
// a code, then POST /api/household/join to accept it (like groups). The roster
// logic here will be removed after new apps pass approval.

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

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }
  const slug = session.member_slug;
  const [members, household] = await Promise.all([
    rosterExcluding(env, slug),
    savedHousehold(env, slug),
  ]);
  return new Response(JSON.stringify({ household, members }), { headers: corsHeaders() });
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

  // Keep only slugs that are real members (never trust the client's list).
  let valid = [];
  if (requested.length) {
    const placeholders = requested.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT slug FROM members WHERE slug IN (${placeholders})`
    ).bind(...requested).all();
    const real = new Set((results || []).map((r) => r.slug));
    valid = requested.filter((s) => real.has(s));
  }

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

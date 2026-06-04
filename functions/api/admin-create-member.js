import { isAdmin } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Normalise to E.164. Accepts "+CC..." as-is, treats bare 10-digit input as US,
// and treats 11-digit input starting with 1 as US with country code already
// included. Anything else: trust the user and just prepend "+".
function normalizePhone(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length >= 7 && digits.length <= 15) return '+' + digits;
  return null;
}

async function pickSeeds(env) {
  const lists = ['watching', 'waiting', 'recommending', 'next'];
  const picks = [];
  for (const list of lists) {
    const { results } = await env.DB.prepare(`
      SELECT s.id, s.title, s.network, s.network_url, s.rating, s.list, s.full_series
      FROM shows s
      WHERE s.archived = 0
        AND s.list = ?
        AND s.rating IS NOT NULL
        AND CAST(s.rating AS REAL) >= 7.5
        AND s.network IS NOT NULL AND s.network != ''
        AND s.network_url IS NOT NULL AND s.network_url != ''
        AND s.network_url NOT LIKE '%search%'
        AND s.network_url NOT LIKE '%/s?%'
        AND s.network_url NOT LIKE '%?q=%'
        AND s.network_url NOT LIKE '%?query=%'
        AND EXISTS (SELECT 1 FROM actors a WHERE a.show_id = s.id)
        AND (SELECT COUNT(DISTINCT t.member_slug) FROM shows t WHERE LOWER(t.title) = LOWER(s.title) AND t.archived = 0) BETWEEN 1 AND 2
      GROUP BY LOWER(s.title)
      ORDER BY RANDOM()
      LIMIT 2
    `).bind(list).all();
    picks.push(...results);
  }
  return picks;
}

// Core member-creation routine. Used both by the operator-facing POST
// endpoint below and by the /requests admin page's "Approve" action.
// Returns either { ok: true, ...details } or { ok: false, status, error }.
export async function createMember(env, { full_name, phone, emails }) {
  if (!full_name) {
    return { ok: false, status: 400, error: 'Full name required' };
  }
  if (!phone && !emails) {
    return { ok: false, status: 400, error: 'Provide a phone number, at least one email, or both' };
  }

  let phoneE164 = null;
  if (phone) {
    phoneE164 = normalizePhone(phone);
    if (!phoneE164) {
      return { ok: false, status: 400, error: 'Phone number looks invalid — use digits only, with + and country code for non-US numbers' };
    }
    const phoneClash = await env.DB.prepare(
      'SELECT member_slug FROM member_phones WHERE phone = ?'
    ).bind(phoneE164).first();
    if (phoneClash) {
      return { ok: false, status: 409, error: `Phone already on file for member: ${phoneClash.member_slug}` };
    }
  }

  const emailList = (emails || '')
    .split(/[,;\s]+/)
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  for (const e of emailList) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, status: 400, error: `Email looks invalid: ${e}` };
    }
  }

  const code = phoneE164 ? phoneE164.slice(-4) : null;

  const tokens = full_name.trim().split(/\s+/);
  const firstName = tokens[0];
  const firstSlug = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  const lastInitial = lastName
    ? lastName.toLowerCase().replace(/[^a-z0-9]/g, '').charAt(0)
    : '';

  if (!firstSlug) {
    return { ok: false, status: 400, error: 'Could not derive slug from name' };
  }

  const candidates = [firstSlug];
  if (lastInitial) candidates.push(firstSlug + lastInitial);
  for (let i = 2; i <= 20; i++) {
    candidates.push((lastInitial ? firstSlug + lastInitial : firstSlug) + i);
  }

  let slug = null;
  for (const cand of candidates) {
    const hit = await env.DB.prepare('SELECT slug FROM members WHERE slug = ?').bind(cand).first();
    if (!hit) { slug = cand; break; }
  }
  if (!slug) {
    return { ok: false, status: 409, error: 'Could not find available slug' };
  }

  const displayName = `${firstName}'s Shows`;
  const editorName = firstName;
  const lastInitialUpper = lastInitial ? lastInitial.toUpperCase() : null;

  await env.DB.prepare(
    'INSERT INTO members (slug, name, first_name, last_initial, last_name) VALUES (?, ?, ?, ?, ?)'
  ).bind(slug, displayName, firstName, lastInitialUpper, lastName).run();
  if (code) {
    await env.DB.prepare(
      'INSERT INTO member_codes (member_slug, code, editor_name) VALUES (?, ?, ?)'
    ).bind(slug, code, editorName).run();
  }
  if (phoneE164) {
    await env.DB.prepare(
      'INSERT INTO member_phones (phone, member_slug, label, is_primary) VALUES (?, ?, NULL, 1)'
    ).bind(phoneE164, slug).run();
  }
  for (let i = 0; i < emailList.length; i++) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, ?)'
    ).bind(emailList[i], slug, i === 0 ? 1 : 0).run();
  }

  const seeds = await pickSeeds(env);
  const seededTitles = [];

  for (const seed of seeds) {
    const result = await env.DB.prepare(
      "INSERT INTO shows (title, network, network_url, rating, list, full_series, member_slug, added_by, created_at, updated_at, enriched_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', NULL, NULL, datetime('now'))"
    ).bind(seed.title, seed.network, seed.network_url, seed.rating, seed.list, seed.full_series || 0, slug).run();

    const newShowId = result.meta.last_row_id;
    const { results: actors } = await env.DB.prepare(
      'SELECT name FROM actors WHERE show_id = ?'
    ).bind(seed.id).all();

    if (actors.length > 0) {
      const stmt = env.DB.prepare('INSERT INTO actors (show_id, name) VALUES (?, ?)');
      await env.DB.batch(actors.map(a => stmt.bind(newShowId, a.name)));
    }
    seededTitles.push(`${seed.title} (${seed.list})`);
  }

  return {
    ok: true,
    slug,
    name: displayName,
    editor_name: editorName,
    url: `https://showpicker.club/${slug}`,
    code,
    phone: phoneE164,
    emails: emailList,
    seeded: seededTitles,
  };
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

  const result = await createMember(env, body);
  if (!result.ok) {
    return json({ error: result.error }, result.status || 400);
  }
  return json(result);
}

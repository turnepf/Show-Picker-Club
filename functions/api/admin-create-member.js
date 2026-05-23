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

  const { secret, full_name, phone } = body;

  if (secret !== env.ADMIN_SECRET) {
    return json({ error: 'Invalid secret' }, 401);
  }

  if (!full_name || !phone) {
    return json({ error: 'Full name and phone required' }, 400);
  }

  const phoneE164 = normalizePhone(phone);
  if (!phoneE164) {
    return json({ error: 'Phone number looks invalid — use digits only, with + and country code for non-US numbers' }, 400);
  }

  // Login code derives from the last 4 digits of the phone. Short-term until
  // SMS code login replaces it; gives the user something to remember tied to
  // their own number rather than an arbitrary 4-digit string.
  const code = phoneE164.slice(-4);

  const phoneClash = await env.DB.prepare(
    'SELECT member_slug FROM member_phones WHERE phone = ?'
  ).bind(phoneE164).first();
  if (phoneClash) {
    return json({ error: `Phone already on file for member: ${phoneClash.member_slug}` }, 409);
  }

  const tokens = full_name.trim().split(/\s+/);
  const firstName = tokens[0];
  const firstSlug = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lastInitial = tokens.length > 1
    ? tokens[tokens.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '').charAt(0)
    : '';

  if (!firstSlug) {
    return json({ error: 'Could not derive slug from name' }, 400);
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
    return json({ error: 'Could not find available slug' }, 409);
  }

  const displayName = `${firstName}'s Shows`;
  const editorName = firstName;
  const lastInitialUpper = lastInitial ? lastInitial.toUpperCase() : null;

  await env.DB.prepare(
    'INSERT INTO members (slug, name, first_name, last_initial) VALUES (?, ?, ?, ?)'
  ).bind(slug, displayName, firstName, lastInitialUpper).run();
  await env.DB.prepare(
    'INSERT INTO member_codes (member_slug, code, editor_name) VALUES (?, ?, ?)'
  ).bind(slug, code, editorName).run();
  await env.DB.prepare(
    'INSERT INTO member_phones (phone, member_slug, label, is_primary) VALUES (?, ?, NULL, 1)'
  ).bind(phoneE164, slug).run();

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

  return json({
    ok: true,
    slug,
    name: displayName,
    editor_name: editorName,
    url: `https://showpicker.club/${slug}`,
    code,
    phone: phoneE164,
    seeded: seededTitles,
  });
}

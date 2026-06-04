import { isAdmin } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Match the canonical normaliser in admin-create-member.js so this admin
// path inserts the same shape: + and country code, or +1 prepended for
// bare 10-digit US input.
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

// GET: list every member with their current emails, phones, and last
// login time. Used by the /members admin page.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  // Activity rollup: per (member, list) count of shows added or touched
  // in the last 30 days. Excludes seeded rows (they're the operator's
  // auto-pick, not member activity) and archived rows.
  const since = "datetime('now', '-30 days')";
  const { results } = await env.DB.prepare(`
    SELECT m.slug, m.name, m.first_name, m.last_initial, m.last_name,
           (SELECT GROUP_CONCAT(email, ',')
              FROM (SELECT email FROM member_emails
                     WHERE member_slug = m.slug
                     ORDER BY is_primary DESC, id)) AS emails,
           (SELECT GROUP_CONCAT(phone, ',')
              FROM (SELECT phone FROM member_phones
                     WHERE member_slug = m.slug
                     ORDER BY is_primary DESC, id)) AS phones,
           (SELECT MAX(created_at) FROM sessions
             WHERE member_slug = m.slug) AS last_login,
           (SELECT COUNT(*) FROM shows
             WHERE member_slug = m.slug AND archived = 0 AND list = 'watching'
               AND COALESCE(added_by,'') != 'seed'
               AND COALESCE(updated_at, created_at) >= ${since}) AS act_watching,
           (SELECT COUNT(*) FROM shows
             WHERE member_slug = m.slug AND archived = 0 AND list = 'waiting'
               AND COALESCE(added_by,'') != 'seed'
               AND COALESCE(updated_at, created_at) >= ${since}) AS act_waiting,
           (SELECT COUNT(*) FROM shows
             WHERE member_slug = m.slug AND archived = 0 AND list = 'recommending'
               AND COALESCE(added_by,'') != 'seed'
               AND COALESCE(updated_at, created_at) >= ${since}) AS act_recommending,
           (SELECT COUNT(*) FROM shows
             WHERE member_slug = m.slug AND archived = 0 AND list = 'next'
               AND COALESCE(added_by,'') != 'seed'
               AND COALESCE(updated_at, created_at) >= ${since}) AS act_next
      FROM members m
     ORDER BY m.first_name COLLATE NOCASE
  `).all();
  const members = (results || []).map(r => ({
    slug: r.slug,
    name: r.name,
    first_name: r.first_name,
    last_initial: r.last_initial,
    last_name: r.last_name,
    emails: r.emails ? r.emails.split(',').filter(Boolean) : [],
    phones: r.phones ? r.phones.split(',').filter(Boolean) : [],
    last_login: r.last_login || null,
    activity_30d: {
      watching: r.act_watching || 0,
      waiting: r.act_waiting || 0,
      recommending: r.act_recommending || 0,
      next: r.act_next || 0,
    },
  }));
  return json({ members });
}

// POST: replace the email and/or phone set for one member. Body:
// { slug, emails?: string|string[], phones?: string|string[] }.
// Sending an empty array clears the corresponding set; omitting the key
// leaves that side alone.
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const slug = (body.slug || '').trim();
  if (!slug) return json({ error: 'missing_slug' }, 400);

  const exists = await env.DB.prepare('SELECT slug FROM members WHERE slug = ?').bind(slug).first();
  if (!exists) return json({ error: 'unknown_member' }, 404);

  // ---- Emails ----
  let emails = null;
  if (body.emails !== undefined) {
    let raw = body.emails;
    if (typeof raw === 'string') raw = raw.split(/[,;\s]+/);
    if (!Array.isArray(raw)) raw = [];
    emails = [...new Set(raw.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    for (const e of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return json({ error: `Email looks invalid: ${e}` }, 400);
      }
    }
  }

  // ---- Phones ----
  let phones = null;
  if (body.phones !== undefined) {
    let raw = body.phones;
    if (typeof raw === 'string') raw = raw.split(/[,;]+/);
    if (!Array.isArray(raw)) raw = [];
    const normalised = [];
    for (const p of raw.map(s => String(s).trim()).filter(Boolean)) {
      const norm = normalizePhone(p);
      if (!norm) return json({ error: `Phone looks invalid: ${p}` }, 400);
      if (!normalised.includes(norm)) normalised.push(norm);
    }
    phones = normalised;
    // Reject phones already claimed by a different member, to avoid an
    // accidental hijack from the admin UI.
    for (const p of phones) {
      const clash = await env.DB.prepare(
        'SELECT member_slug FROM member_phones WHERE phone = ? AND member_slug != ?'
      ).bind(p, slug).first();
      if (clash) {
        return json({ error: `Phone ${p} is already on file for ${clash.member_slug}` }, 409);
      }
    }
  }

  if (emails !== null) {
    await env.DB.prepare('DELETE FROM member_emails WHERE member_slug = ?').bind(slug).run();
    for (let i = 0; i < emails.length; i++) {
      await env.DB.prepare(
        'INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, ?)'
      ).bind(emails[i], slug, i === 0 ? 1 : 0).run();
    }
  }
  if (phones !== null) {
    await env.DB.prepare('DELETE FROM member_phones WHERE member_slug = ?').bind(slug).run();
    for (let i = 0; i < phones.length; i++) {
      await env.DB.prepare(
        'INSERT INTO member_phones (phone, member_slug, is_primary) VALUES (?, ?, ?)'
      ).bind(phones[i], slug, i === 0 ? 1 : 0).run();
    }
    // Keep the legacy static code in sync with the (new) primary phone so
    // the 4-digit login flow keeps working through the June 7 cutoff.
    if (phones.length > 0) {
      const code = phones[0].slice(-4);
      const editorRow = await env.DB.prepare(
        'SELECT editor_name FROM member_codes WHERE member_slug = ? LIMIT 1'
      ).bind(slug).first();
      const firstNameRow = await env.DB.prepare(
        'SELECT first_name FROM members WHERE slug = ?'
      ).bind(slug).first();
      const editorName = editorRow?.editor_name || firstNameRow?.first_name || slug;
      await env.DB.prepare('DELETE FROM member_codes WHERE member_slug = ?').bind(slug).run();
      await env.DB.prepare(
        'INSERT INTO member_codes (member_slug, code, editor_name) VALUES (?, ?, ?)'
      ).bind(slug, code, editorName).run();
    }
  }

  return json({ ok: true, slug, emails, phones });
}

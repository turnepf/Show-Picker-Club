import { isAdmin } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET: list every member with their current emails. Used by the
// /member-emails admin page to show the working set.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  const { results } = await env.DB.prepare(`
    SELECT m.slug, m.name, m.first_name,
           GROUP_CONCAT(me.email, ',') AS emails
      FROM members m
      LEFT JOIN member_emails me ON me.member_slug = m.slug
     GROUP BY m.slug
     ORDER BY m.first_name COLLATE NOCASE
  `).all();
  const members = (results || []).map(r => ({
    slug: r.slug,
    name: r.name,
    first_name: r.first_name,
    emails: r.emails ? r.emails.split(',').filter(Boolean) : [],
  }));
  return json({ members });
}

// POST: replace the email set for one member. Body: { slug, emails: [...] }.
// Sending an empty array clears the member's emails.
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const slug = (body.slug || '').trim();
  if (!slug) return json({ error: 'missing_slug' }, 400);

  // Tolerate both an array and a comma-separated string here so the form
  // and a JSON client can both POST without converting.
  let raw = body.emails;
  if (typeof raw === 'string') raw = raw.split(/[,;\s]+/);
  if (!Array.isArray(raw)) raw = [];
  const emails = [...new Set(raw.map(e => String(e).trim().toLowerCase()).filter(Boolean))];

  for (const e of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return json({ error: `Email looks invalid: ${e}` }, 400);
    }
  }

  const exists = await env.DB.prepare('SELECT slug FROM members WHERE slug = ?').bind(slug).first();
  if (!exists) return json({ error: 'unknown_member' }, 404);

  await env.DB.prepare('DELETE FROM member_emails WHERE member_slug = ?').bind(slug).run();
  for (let i = 0; i < emails.length; i++) {
    await env.DB.prepare(
      'INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, ?)'
    ).bind(emails[i], slug, i === 0 ? 1 : 0).run();
  }

  return json({ ok: true, slug, emails });
}

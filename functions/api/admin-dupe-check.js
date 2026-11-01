// Monthly duplicate-account scan, run from GitHub Actions (dupe-check.yml).
// Ports the heuristic the interactive /members "Possible duplicates" panel
// used to run in the browser (removed 2026-09 — Patrick decided not to keep
// worrying about it there) into a headless check: same dupe_ignores table,
// one signal (two accounts sharing a login email, since 2026-11), surfaced
// as an email instead of a UI to click through. Merging or permanently silencing a pair still works — via
// POST /api/admin-member-merge / /api/admin-dupe-ignores — there's just no
// button anywhere; curl with an admin session cookie.
//
//   POST { dry_run?: boolean }
//
// A pair already in dupe_ignores (self-pairs are left over from the
// retired hidden-email-only check) is treated as "already flagged" and
// never re-surfaces or re-emails — that's the whole point of writing found pairs into the same
// table the old ignore button used. There's no way back short of deleting
// the row directly; that's fine, since re-arming a specific pair is rare and
// the table is a normal SQLite table.

import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { demoMemberSlug } from '../_shared/demo.js';
import { sendEmail } from '../_shared/email.js';

const ADMIN_ALERT_EMAIL = 'patrick@patrickturner.net';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function authorized(request, env) {
  if (await isAdmin(request, env)) return true;
  return await cronAuthorized(request, env);
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS dupe_ignores (
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (slug_a, slug_b)
)`;

function sortedPair(a, b) {
  return a <= b ? [a, b] : [b, a];
}

// Gmail ignores dots and anything after a "+" in the local part, so
// j.doe+tv@gmail.com and jdoe@gmail.com reach the same inbox.
function normalizeEmail(email) {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}

function displayName(m) {
  return m.last_name ? `${m.first_name || m.slug} ${m.last_name}` : (m.first_name || m.slug);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await authorized(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const dryRun = !!body.dry_run;

  await env.DB.prepare(CREATE_TABLE).run();

  const demoSlug = await demoMemberSlug(env);

  const { results } = await env.DB.prepare(`
    SELECT m.slug, m.first_name, m.last_name,
           (SELECT GROUP_CONCAT(email, ',') FROM member_emails WHERE member_slug = m.slug) AS emails
      FROM members m
  `).all();

  const members = (results || [])
    .filter((m) => m.slug !== demoSlug)
    .map((m) => ({
      slug: m.slug,
      first_name: m.first_name,
      last_name: m.last_name,
      emails: m.emails ? m.emails.split(',').filter(Boolean) : [],
    }));

  const { results: ignoreRows } = await env.DB.prepare(
    'SELECT slug_a, slug_b FROM dupe_ignores'
  ).all();
  const known = new Set((ignoreRows || []).map((r) => sortedPair(r.slug_a, r.slug_b).join('|')));

  // Group by login email. A shared first name (the old panel's other
  // signal) is far too common at this size, and a hidden-email-only signup
  // usually turned out to be a new person rather than a second account —
  // both were dropped 2026-11. Two accounts holding the same address is the
  // one signal that names the same person.
  const byEmail = new Map();
  for (const m of members) {
    for (const e of new Set(m.emails.map(normalizeEmail))) {
      if (!byEmail.has(e)) byEmail.set(e, []);
      byEmail.get(e).push(m);
    }
  }

  const newPairs = []; // every pair to write into dupe_ignores once reported
  const newFindings = []; // one line per shared address, for the email
  const queued = new Set();

  for (const [email, group] of byEmail) {
    if (group.length < 2) continue;
    const pairs = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairs.push(sortedPair(group[i].slug, group[j].slug));
      }
    }
    const unknownPairs = pairs.filter((p) => !known.has(p.join('|')) && !queued.has(p.join('|')));
    if (!unknownPairs.length) continue;
    for (const p of unknownPairs) queued.add(p.join('|'));
    newPairs.push(...unknownPairs);
    newFindings.push(
      `Shared email ${email}: ` +
      group.map((m) => `${displayName(m)} (@${m.slug})`).join(', ')
    );
  }

  if (!newFindings.length) {
    return json({ ok: true, new: 0, dry_run: dryRun });
  }

  if (dryRun) {
    return json({ ok: true, new: newFindings.length, findings: newFindings, dry_run: true });
  }

  for (const [a, b] of newPairs) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO dupe_ignores (slug_a, slug_b) VALUES (?, ?)'
    ).bind(a, b).run();
  }

  const count = newFindings.length;
  const listHtml = newFindings.map((f) => `<li>${f}</li>`).join('');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2C2C2C;">
    <h2 style="color:#2C3E50;margin:0 0 12px;">Possible duplicate member${count === 1 ? '' : 's'}</h2>
    <p style="font-size:14px;line-height:1.5;">${count} new possible duplicate${count === 1 ? '' : 's'} found on Show Picker Club:</p>
    <ul style="font-size:14px;line-height:1.7;">${listHtml}</ul>
    <p style="font-size:12px;color:#888;">This won't repeat for the same match next month. Merge for real with a curl to /api/admin-member-merge, or leave it — it's already recorded as seen.</p>
  </div>`;
  const text = `${count} new possible duplicate(s) on Show Picker Club:\n\n` +
    newFindings.map((f) => `- ${f}`).join('\n') +
    `\n\nThis won't repeat for the same match next month.`;

  const emailResult = await sendEmail(env, {
    to: ADMIN_ALERT_EMAIL,
    subject: `Show Picker Club: ${count} possible duplicate${count === 1 ? '' : 's'}`,
    html,
    text,
  });

  return json({ ok: true, new: count, findings: newFindings, emailed: emailResult.ok, dry_run: false });
}

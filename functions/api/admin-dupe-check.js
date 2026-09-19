// Monthly duplicate-account scan, run from GitHub Actions (dupe-check.yml).
// Ports the heuristic the interactive /members "Possible duplicates" panel
// used to run in the browser (removed 2026-09 — Patrick decided not to keep
// worrying about it there) into a headless check: same two signals, same
// dupe_ignores table, but surfaced as an email instead of a UI to click
// through. Merging or permanently silencing a pair still works — via
// POST /api/admin-member-merge / /api/admin-dupe-ignores — there's just no
// button anywhere; curl with an admin session cookie.
//
//   POST { dry_run?: boolean }
//
// A pair (or a lone relay-only account, recorded as a self-pair) already in
// dupe_ignores is treated as "already flagged" and never re-surfaces or
// re-emails — that's the whole point of writing found pairs into the same
// table the old ignore button used. There's no way back short of deleting
// the row directly; that's fine, since re-arming a specific pair is rare and
// the table is a normal SQLite table.

import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { demoMemberSlug } from '../_shared/demo.js';
import { sendEmail } from '../_shared/email.js';

const ADMIN_ALERT_EMAIL = 'patrick@patrickturner.net';
const RELAY_RE = /@privaterelay\.appleid\.com$/i;

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

function isRelayOnly(m) {
  if (m.emails.length) return m.emails.every((e) => RELAY_RE.test(e));
  // No email at all only happens for external-identity signups.
  return !!m.enrolled_via && m.phone_count === 0;
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
    SELECT m.slug, m.first_name, m.last_name, m.enrolled_via,
           (SELECT GROUP_CONCAT(email, ',') FROM member_emails WHERE member_slug = m.slug) AS emails,
           (SELECT COUNT(*) FROM member_phones WHERE member_slug = m.slug) AS phone_count
      FROM members m
  `).all();

  const members = (results || [])
    .filter((m) => m.slug !== demoSlug)
    .map((m) => ({
      slug: m.slug,
      first_name: m.first_name,
      last_name: m.last_name,
      enrolled_via: m.enrolled_via || null,
      emails: m.emails ? m.emails.split(',').filter(Boolean) : [],
      phone_count: m.phone_count || 0,
    }));

  const { results: ignoreRows } = await env.DB.prepare(
    'SELECT slug_a, slug_b FROM dupe_ignores'
  ).all();
  const known = new Set((ignoreRows || []).map((r) => sortedPair(r.slug_a, r.slug_b).join('|')));

  // Group by first name, same as the old panel.
  const byFirst = new Map();
  for (const m of members) {
    const key = (m.first_name || m.slug).trim().toLowerCase();
    if (!byFirst.has(key)) byFirst.set(key, []);
    byFirst.get(key).push(m);
  }
  const nameGroups = [...byFirst.values()].filter((g) => g.length > 1);
  const grouped = new Set(nameGroups.flat().map((m) => m.slug));

  const newPairs = []; // every pair to write into dupe_ignores once reported
  const newFindings = []; // one line per group / lone account, for the email

  for (const group of nameGroups) {
    const pairs = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairs.push(sortedPair(group[i].slug, group[j].slug));
      }
    }
    const unknownPairs = pairs.filter((p) => !known.has(p.join('|')));
    if (!unknownPairs.length) continue;
    newPairs.push(...unknownPairs);
    newFindings.push(
      `Shared first name "${group[0].first_name || group[0].slug}": ` +
      group.map((m) => `${displayName(m)} (@${m.slug})`).join(', ')
    );
  }

  for (const m of members) {
    if (grouped.has(m.slug)) continue; // already covered by a name group above
    if (!isRelayOnly(m)) continue;
    const pair = [m.slug, m.slug];
    if (known.has(pair.join('|'))) continue;
    newPairs.push(pair);
    newFindings.push(`Hidden-email-only signup: ${displayName(m)} (@${m.slug}) — no other identity on file`);
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

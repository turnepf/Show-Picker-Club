import { sendSms } from '../_shared/sms.js';
import { isAdmin } from '../_shared/admin.js';

// Monthly "dormant members" digest. Finds members who have done nothing with
// their library (no non-seed shows, no edits, no archives) AND haven't pinged
// a session in the last `days` (default 30), then texts the operator a summary
// so stale accounts can be pruned.
//
// Auth: either an operator session (isAdmin) OR a matching CRON_SECRET header
// (so the GitHub Actions monthly job can call it without a cookie).
//
// Body / query (optional):
//   days     — dormancy window, default 30
//   dry_run  — if truthy, compute + return the list but don't send the SMS
//              (handy while the Twilio campaign is still pending approval)

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function authorized(request, env) {
  if (await isAdmin(request, env)) return true;
  const provided = request.headers.get('X-Cron-Secret');
  return !!env.CRON_SECRET && provided === env.CRON_SECRET;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await authorized(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const days = Math.max(1, Math.min(365, parseInt(body.days, 10) || 30));
  const dryRun = !!body.dry_run;

  // Dormant: no library engagement beyond seeds AND no recent session.
  const { results: dormant } = await env.DB.prepare(
    `SELECT m.slug, m.name, m.created_at,
            (SELECT MAX(last_seen_at) FROM sessions WHERE member_slug = m.slug) AS last_seen
     FROM members m
     WHERE NOT EXISTS (
        SELECT 1 FROM shows s
        WHERE s.member_slug = m.slug
          AND (COALESCE(s.added_by,'') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
     )
     AND NOT EXISTS (
        SELECT 1 FROM sessions sess
        WHERE sess.member_slug = m.slug
          AND sess.last_seen_at >= datetime('now', ?)
     )
     ORDER BY m.created_at`
  ).bind(`-${days} days`).all();

  const names = dormant.map(d => {
    const first = (d.name || d.slug).split(' ')[0];
    return first;
  });

  let message;
  if (dormant.length === 0) {
    message = `Show Picker Club: no dormant members this month — everyone with an account has engaged. Nice.`;
  } else {
    const list = names.slice(0, 20).join(', ');
    const extra = names.length > 20 ? ` +${names.length - 20} more` : '';
    message = `Show Picker Club: ${dormant.length} dormant member${dormant.length === 1 ? '' : 's'} (no activity in ${days}+ days): ${list}${extra}. Review/prune: https://showpicker.club/reporting`;
  }

  const summary = {
    dormant_count: dormant.length,
    days,
    dormant: dormant.map(d => ({ slug: d.slug, name: d.name, joined: d.created_at, last_seen: d.last_seen })),
    message,
    sent: false,
  };

  if (dryRun) return json(summary);

  // Send to the operator's primary phone.
  const op = await env.DB.prepare(
    "SELECT phone FROM member_phones WHERE member_slug = 'patrick' AND is_primary = 1 LIMIT 1"
  ).first();
  if (!op?.phone) {
    return json({ ...summary, error: 'No primary phone on file for operator' }, 500);
  }

  const result = await sendSms(env, op.phone, message);
  return json({ ...summary, sent: result.ok, sms: result });
}

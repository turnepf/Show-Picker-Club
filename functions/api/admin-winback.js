import { getAdminSession } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { planWinback, sendWinback, renderWinback, unsubscribeUrl, PREVIEW_TO, FROM } from '../_shared/winback.js';

// POST /api/admin-winback — the "we saved your spot" email
// (functions/_shared/winback.js). Admin session or X-Cron-Secret; driven by
// scripts/winback.mjs from the Actions tab. Never an AI connection: mailing
// members is not something a connected app can start.
//
// Body { mode }:
//   plan    — who's inactive and which version each would get. Sends nothing.
//   review  — every message a send would deliver, fully rendered: to,
//             subject, text and HTML. Admin SESSION only, never the cron
//             secret, because it carries members' addresses and the cron
//             path ends up in public Actions logs. Read by /admin-winback.
//   preview — one email per version, built from a real member's data, sent
//             to PREVIEW_TO only. Stamps nothing.
//   send    — sends to members not yet sent one for this lapse, `limit` at a
//             time (default 10, max 20) to stay inside the Worker's
//             subrequest budget; call again until `remaining` is 0. Requires
//             { confirm: "send" } so a stray call can't mail the club.

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

const VARIANTS = ['awaiting', 'group', 'start', 'general'];

function counts(plan) {
  const out = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
  for (const e of plan) out[e.variant]++;
  return out;
}

export async function onRequestPost({ request, env }) {
  const authorized = (await cronAuthorized(request, env)) || !!(await getAdminSession(request, env));
  if (!authorized) return json({ error: 'forbidden' }, 403);
  if (!env.CRON_SECRET) return json({ error: 'CRON_SECRET is not set; unsubscribe links cannot be signed' }, 500);

  const body = await request.json().catch(() => ({}));
  const mode = body.mode || 'plan';

  if (mode === 'review') {
    if (!(await getAdminSession(request, env))) return json({ error: 'forbidden' }, 403);
    const plan = await planWinback(env);
    const messages = [];
    for (const e of plan) {
      const unsubscribe = await unsubscribeUrl(env, e.slug);
      const msg = renderWinback(e, { unsubscribe });
      messages.push({
        slug: e.slug, version: e.variant, last_seen: e.last_seen,
        to: e.email, from: FROM, already_sent: e.already_sent,
        subject: msg.subject, text: msg.text, html: msg.html,
      });
    }
    return json({ count: messages.length, by_version: counts(plan), messages });
  }

  if (mode === 'plan') {
    const plan = await planWinback(env);
    return json({
      inactive: plan.length,
      by_version: counts(plan),
      no_email: plan.filter((e) => !e.email).length,
      already_sent: plan.filter((e) => e.already_sent).length,
      would_send: plan.filter((e) => e.email && !e.already_sent).length,
      members: plan.map((e) => ({
        slug: e.slug, version: e.variant, last_seen: e.last_seen,
        has_email: !!e.email, already_sent: e.already_sent,
      })),
    });
  }

  if (mode === 'preview') {
    const plan = await planWinback(env);
    const sent = [];
    for (const v of VARIANTS) {
      const sample = plan.find((e) => e.variant === v);
      if (!sample) continue;
      const r = await sendWinback(env, sample, { to: PREVIEW_TO, preview: true });
      sent.push({ version: v, sample: sample.slug, ok: !!r.ok, error: r.error || null });
    }
    return json({ to: PREVIEW_TO, sent });
  }

  if (mode === 'send') {
    if (body.confirm !== 'send') return json({ error: 'send needs { confirm: "send" }' }, 400);
    const limit = Math.min(Math.max(Number.parseInt(body.limit, 10) || 10, 1), 20);
    const queue = (await planWinback(env, { unsentOnly: true })).filter((e) => e.email);
    const batch = queue.slice(0, limit);
    const results = [];
    for (const entry of batch) {
      const r = await sendWinback(env, entry);
      if (r.ok) {
        await env.DB.prepare("UPDATE members SET winback_sent_at = datetime('now') WHERE slug = ?")
          .bind(entry.slug).run();
      }
      results.push({ slug: entry.slug, version: entry.variant, ok: !!r.ok, error: r.error || null });
    }
    const failed = results.filter((r) => !r.ok).length;
    return json({
      sent: results.length - failed,
      failed,
      remaining: queue.length - (results.length - failed),
      results,
    });
  }

  return json({ error: 'mode must be plan, review, preview or send' }, 400);
}

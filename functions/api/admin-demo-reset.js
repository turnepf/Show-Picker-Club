import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { resetDemoIfDue } from '../_shared/demo.js';

// Restores the demo member's data to its baseline snapshot once the one-hour
// window after the last demo sign-in has passed (see _shared/demo.js for the
// lifecycle). Called hourly by the demo-reset GitHub Action; the login path
// also runs the same check lazily, so this is the backstop that cleans up
// when no one logs in again.
//
// Auth: operator session OR a matching X-Cron-Secret header.
// Body (optional): { force: true } — operator-only way to reset immediately
// without waiting out the hour.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await isAdmin(request, env);
  if (!admin && !(await cronAuthorized(request, env))) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  // Immediate reset is an operator action, not something the cron should do —
  // forcing on the hourly job would wipe an active demo session mid-hour.
  const force = admin && body.force === true;

  const result = await resetDemoIfDue(env, { force });
  return json(result);
}

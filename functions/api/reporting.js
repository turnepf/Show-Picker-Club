import { getSession } from '../_shared/auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function countOver(env, sql, ...binds) {
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return row ? row.cnt : 0;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const windows = [
    ['day', "AND created_at >= datetime('now', '-1 day')", "AND updated_at >= datetime('now', '-1 day')"],
    ['week', "AND created_at >= datetime('now', '-7 days')", "AND updated_at >= datetime('now', '-7 days')"],
    ['month', "AND created_at >= datetime('now', '-30 days')", "AND updated_at >= datetime('now', '-30 days')"],
    ['all_time', '', ''],
  ];

  const newShows = {};
  const editedShows = {};
  const archivedShows = {};
  const newMembers = {};

  for (const [label, createdFilter, updatedFilter] of windows) {
    newShows[label] = await countOver(env,
      `SELECT COUNT(*) as cnt FROM shows WHERE archived = 0 AND created_at IS NOT NULL ${createdFilter}`);
    editedShows[label] = await countOver(env,
      `SELECT COUNT(*) as cnt FROM shows WHERE updated_at IS NOT NULL AND (created_at IS NULL OR updated_at != created_at) ${updatedFilter}`);
    archivedShows[label] = await countOver(env,
      `SELECT COUNT(*) as cnt FROM shows WHERE archived = 1 ${updatedFilter}`);
    newMembers[label] = await countOver(env,
      `SELECT COUNT(*) as cnt FROM members WHERE 1=1 ${createdFilter}`);
  }

  // Active members = distinct logged-in members whose session pinged within
  // the window. last_seen_at is bumped (throttled to 1/hour) on every
  // /auth/check, so this approximates DAU/WAU/MAU for authenticated visits.
  const activeMembers = {
    day: await countOver(env,
      `SELECT COUNT(DISTINCT member_slug) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-1 day')`),
    week: await countOver(env,
      `SELECT COUNT(DISTINCT member_slug) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-7 days')`),
    month: await countOver(env,
      `SELECT COUNT(DISTINCT member_slug) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-30 days')`),
  };

  const totals = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM members) as members,
      (SELECT COUNT(*) FROM shows WHERE archived = 0) as active_shows,
      (SELECT COUNT(*) FROM shows WHERE archived = 1) as archived_shows,
      (SELECT COUNT(*) FROM shows WHERE archived = 0 AND list = 'watching') as watching,
      (SELECT COUNT(*) FROM shows WHERE archived = 0 AND list = 'waiting') as waiting,
      (SELECT COUNT(*) FROM shows WHERE archived = 0 AND list = 'recommending') as recommending,
      (SELECT COUNT(*) FROM shows WHERE archived = 0 AND list = 'next') as next`
  ).first();

  const { results: topNetworks } = await env.DB.prepare(
    `SELECT network, COUNT(*) as cnt
     FROM shows
     WHERE archived = 0 AND network IS NOT NULL AND network != ''
     GROUP BY network
     ORDER BY cnt DESC
     LIMIT 10`
  ).all();

  const { results: topShared } = await env.DB.prepare(
    `SELECT title, COUNT(DISTINCT member_slug) as members
     FROM shows
     WHERE archived = 0
     GROUP BY LOWER(title)
     HAVING members > 1
     ORDER BY members DESC, title
     LIMIT 10`
  ).all();

  return json({
    generated_at: new Date().toISOString(),
    new_shows: newShows,
    edited_shows: editedShows,
    archived_shows: archivedShows,
    new_members: newMembers,
    active_members: activeMembers,
    totals,
    top_networks: topNetworks,
    top_shared: topShared,
  });
}

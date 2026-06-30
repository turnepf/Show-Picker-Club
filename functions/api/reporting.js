import { isAdmin } from '../_shared/admin.js';

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
  // Operator-only: aggregate metrics (member counts, login coverage) shouldn't
  // be visible to every logged-in member, only the admin.
  if (!(await isAdmin(request, env))) return json({ error: 'Forbidden' }, 403);

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

  // Active sessions broken down by client platform (ios / tvos / web-small /
  // web-large). Counts distinct sessions, not members: a member can be active
  // on more than one platform, and anonymous tvOS devices have no member.
  // Defensive: the platform column arrives in migration 016, so fall back to
  // an empty breakdown rather than 500 the whole dashboard if it's missing.
  const activeByPlatform = { day: {}, week: {}, month: {} };
  const platWindows = { day: '-1 day', week: '-7 days', month: '-30 days' };
  try {
    for (const [label, interval] of Object.entries(platWindows)) {
      const { results } = await env.DB.prepare(
        `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(DISTINCT id) AS cnt
           FROM sessions
          WHERE last_seen_at >= datetime('now', ?)
          GROUP BY COALESCE(platform, 'unknown')`
      ).bind(interval).all();
      for (const row of results) activeByPlatform[label][row.platform] = row.cnt;
    }
  } catch (_) { /* platform column not migrated yet */ }

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

  // Durable login coverage (migration 013). Defensive: if the column isn't
  // there yet, report nulls rather than 500 the whole dashboard.
  let membersLogin = { ever: null, never: null };
  try {
    membersLogin = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM members WHERE last_login_at IS NOT NULL) AS ever,
         (SELECT COUNT(*) FROM members WHERE last_login_at IS NULL) AS never`
    ).first();
  } catch (_) { /* column not migrated yet */ }

  // Who has never logged in since we started tracking it (migration 013), and
  // for each, whether their library is still just the seeded rows. seeds_only
  // is true when nothing beyond the seeds has happened: no member-added show,
  // no archive, no edit (updated_at moved off created_at). Mirrors the
  // "engagement beyond seeds" test used by the dormant-member digest.
  let neverLoggedIn = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.slug, m.name, m.created_at AS joined,
              (SELECT COUNT(*) FROM shows s WHERE s.member_slug = m.slug) AS show_count,
              CASE WHEN EXISTS (
                SELECT 1 FROM shows s
                WHERE s.member_slug = m.slug
                  AND (COALESCE(s.added_by, '') != 'seed'
                       OR s.archived = 1
                       OR (s.updated_at IS NOT NULL AND s.updated_at != s.created_at))
              ) THEN 0 ELSE 1 END AS seeds_only
         FROM members m
        WHERE m.last_login_at IS NULL
        ORDER BY m.created_at`
    ).all();
    neverLoggedIn = results.map(r => ({
      slug: r.slug,
      name: r.name,
      joined: r.joined,
      show_count: r.show_count,
      seeds_only: r.seeds_only === 1,
    }));
  } catch (_) { /* last_login_at / added_by not migrated yet */ }

  return json({
    generated_at: new Date().toISOString(),
    new_shows: newShows,
    edited_shows: editedShows,
    archived_shows: archivedShows,
    new_members: newMembers,
    active_members: activeMembers,
    active_by_platform: activeByPlatform,
    totals,
    members_login: membersLogin,
    never_logged_in: neverLoggedIn,
    top_networks: topNetworks,
    top_shared: topShared,
  });
}

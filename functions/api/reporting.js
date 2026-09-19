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

// One person, counted once — the unit every "people" number on this dashboard
// is in. Sessions are per device and plural by design: signing in on three
// Apple TVs, two Macs or four Rokus mints three, two and four rows, and a
// reinstall mints another. Grouping by the member the session belongs to is
// what turns those back into one user. A row predating member_slug (nothing
// mints one now, and a session lives 30 days) falls back to the identity it
// does carry, prefixed so it can never collide with a real slug.
const PERSON = "COALESCE(member_slug, 'email:' || email)";

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

  // Ratings (migration 053): how many people submitted a rating, and how
  // many ratings were submitted, in each window. Uses updated_at (bumped on
  // every insert *and* update) rather than created_at, so re-rating a title
  // still counts as activity in the window, matching what "submitted"
  // implies. Defensive: report zeros rather than 500 the whole dashboard if
  // the table isn't there yet (a stale preview branch pre-migration-053).
  const ratingMembers = {};
  const ratingsSubmitted = {};
  try {
    for (const [label, , updatedFilter] of windows) {
      ratingMembers[label] = await countOver(env,
        `SELECT COUNT(DISTINCT member_slug) as cnt FROM show_ratings WHERE 1=1 ${updatedFilter}`);
      ratingsSubmitted[label] = await countOver(env,
        `SELECT COUNT(*) as cnt FROM show_ratings WHERE 1=1 ${updatedFilter}`);
    }
  } catch (_) { /* show_ratings not migrated yet */ }

  // Distinct titles with at least one rating (all-time), for the Totals card.
  let ratingsTitles = 0;
  try {
    ratingsTitles = await countOver(env,
      `SELECT COUNT(*) as cnt FROM (SELECT DISTINCT tmdb_id, tmdb_type FROM show_ratings)`);
  } catch (_) { /* show_ratings not migrated yet */ }

  // Active members = distinct logged-in people whose session pinged within
  // the window. last_seen_at is bumped (throttled to 1/hour) on every
  // /auth/check, so this approximates DAU/WAU/MAU for authenticated visits.
  const activeMembers = {
    day: await countOver(env,
      `SELECT COUNT(DISTINCT ${PERSON}) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-1 day')`),
    week: await countOver(env,
      `SELECT COUNT(DISTINCT ${PERSON}) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-7 days')`),
    month: await countOver(env,
      `SELECT COUNT(DISTINCT ${PERSON}) as cnt FROM sessions WHERE last_seen_at >= datetime('now', '-30 days')`),
  };

  // Active *people* broken down by client platform (see
  // _shared/platform.js#KNOWN_PLATFORMS). Counts distinct people, not
  // sessions or devices: one member on three Apple TVs, two Macs or four
  // Rokus is one user on that row, and a reinstall or a second sign-in on
  // the same phone is still one person. A member active on two platforms
  // counts once in each, so the rows deliberately don't sum to Active
  // members.
  //
  // Sessions whose platform was never captured are left out rather than
  // gathered into an "Unknown" row. That row only ever meant "this dashboard
  // failed to ask", which is a fact about the instrumentation and not about
  // anybody's viewing: /auth/check is the only writer of sessions.platform,
  // and a check sent without the header used to make a session countable
  // while leaving the column NULL. The pages that did that were fixed, so the
  // row is now a shrinking tail of sessions that predate the fix, and a number
  // nobody can act on is worse than no number. Those people are still counted
  // once in Active members, which is why these rows can also sum to *less*
  // than it. Defensive: the platform column arrives in migration 016, so fall
  // back to an empty breakdown rather than 500 the whole dashboard if it's
  // missing.
  const activeByPlatform = { day: {}, week: {}, month: {} };
  const platWindows = { day: '-1 day', week: '-7 days', month: '-30 days' };
  try {
    for (const [label, interval] of Object.entries(platWindows)) {
      const { results } = await env.DB.prepare(
        `SELECT platform, COUNT(DISTINCT ${PERSON}) AS cnt
           FROM sessions
          WHERE last_seen_at >= datetime('now', ?)
            AND platform IS NOT NULL
          GROUP BY platform`
      ).bind(interval).all();
      for (const row of results) activeByPlatform[label][row.platform] = row.cnt;
    }
  } catch (_) { /* platform column not migrated yet */ }

  // How members actually sign in (migration 059): distinct *people* who
  // minted a session per method over each window, plus how every account was
  // created. This is what says whether an auth channel still earns what it
  // costs to run — Twilio SMS bills per message, email codes need Resend.
  // Counting people rather than sessions is what keeps that readable: one
  // member signing in on four devices is one person who depends on Apple,
  // not four, and retiring a channel is a decision about people. Someone who
  // used two methods counts on both rows, so these don't sum either. A NULL
  // auth_method — a session minted before the column existed — is left out
  // for the same reason the platform breakdown drops its unknowns: it names
  // no channel, so it can't inform a decision about one.
  const signinMethods = { week: {}, month: {}, quarter: {} };
  const methodWindows = { week: '-7 days', month: '-30 days', quarter: '-90 days' };
  try {
    for (const [label, interval] of Object.entries(methodWindows)) {
      const { results } = await env.DB.prepare(
        `SELECT auth_method AS method, COUNT(DISTINCT ${PERSON}) AS cnt
           FROM sessions
          WHERE created_at >= datetime('now', ?)
            AND auth_method IS NOT NULL
          GROUP BY auth_method`
      ).bind(interval).all();
      for (const row of results) signinMethods[label][row.method] = row.cnt;
    }
  } catch (_) { /* auth_method column not migrated yet */ }

  // Calendar feed usage (migration 061): how many members' feeds a client has
  // actually fetched lately, and how many have ever been fetched at all.
  let calendarUsage = null;
  try {
    calendarUsage = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM members WHERE calendar_fetched_at >= datetime('now', '-7 days')) AS week,
         (SELECT COUNT(*) FROM members WHERE calendar_fetched_at >= datetime('now', '-30 days')) AS month,
         (SELECT COUNT(*) FROM members WHERE calendar_fetched_at IS NOT NULL) AS ever,
         (SELECT COALESCE(SUM(calendar_fetch_count), 0) FROM members) AS fetches`
    ).first();
  } catch (_) { /* columns not migrated yet */ }

  // Account creation method, all time (migration 031's enrolled_via).
  const enrolledVia = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT COALESCE(enrolled_via, 'unknown') AS method, COUNT(*) AS cnt
         FROM members GROUP BY COALESCE(enrolled_via, 'unknown')`
    ).all();
    for (const row of results) enrolledVia[row.method] = row.cnt;
  } catch (_) { /* enrolled_via column not migrated yet */ }

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
  // no archive, no edit (updated_at moved off created_at).
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
    rating_members: ratingMembers,
    ratings_submitted: ratingsSubmitted,
    ratings_titles: ratingsTitles,
    active_members: activeMembers,
    active_by_platform: activeByPlatform,
    signin_methods: signinMethods,
    calendar_usage: calendarUsage,
    enrolled_via: enrolledVia,
    totals,
    members_login: membersLogin,
    never_logged_in: neverLoggedIn,
    top_networks: topNetworks,
    top_shared: topShared,
  });
}

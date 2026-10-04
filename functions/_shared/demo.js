// Demo-account support: identity helpers + the auto-reset lifecycle.
//
// The demo member is whoever owns DEMO_LOGIN_EMAIL (a Cloudflare secret) — a
// single source of truth shared by the email/code reviewer login, the Apple
// demo fallback, and the reset machinery here.
//
// Reset lifecycle ("demo data wipes an hour after login"):
//   1. On every successful demo sign-in, noteDemoLogin() runs:
//      - if a reset is overdue, restore the baseline right away (this login
//        starts clean);
//      - if the data is currently canonical (no reset pending), snapshot it
//        as the new baseline — so the operator can re-curate the demo library
//        any time and the next login picks it up;
//      - arm/extend the reset for one hour from now.
//   2. resetDemoIfDue() restores the baseline once the hour has passed. It is
//      called lazily at the next demo login AND by the hourly demo-reset
//      GitHub Action (via /api/admin-demo-reset), so junk never outlives the
//      hour by much even when nobody logs in again.
//
// State lives in the demo_state key/value table (migration 029):
//   baseline     — JSON snapshot { shows, actors, subscriptions }
//   reset_due_at — ISO timestamp; present = demo data may be dirty

export async function demoMemberSlug(env) {
  const demoEmail = (env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase();
  if (!demoEmail) return null;
  const row = await env.DB.prepare(
    'SELECT member_slug FROM member_emails WHERE LOWER(email) = ? LIMIT 1'
  ).bind(demoEmail).first();
  return row?.member_slug || null;
}

export async function isDemoMember(env, slug) {
  if (!slug) return false;
  const demo = await demoMemberSlug(env);
  return !!demo && demo === slug;
}

async function getState(env, key) {
  const row = await env.DB.prepare(
    'SELECT value FROM demo_state WHERE key = ?'
  ).bind(key).first();
  return row?.value ?? null;
}

async function setState(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO demo_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, value).run();
}

async function delState(env, key) {
  await env.DB.prepare('DELETE FROM demo_state WHERE key = ?').bind(key).run();
}

// Snapshot everything a demo user can change about their own account. SELECT *
// keeps the snapshot in step with schema migrations without a column list here.
async function snapshotBaseline(env, slug) {
  const shows = (await env.DB.prepare(
    'SELECT * FROM shows WHERE member_slug = ?'
  ).bind(slug).all()).results || [];
  const showIds = shows.map((s) => s.id);
  let actors = [];
  if (showIds.length) {
    const placeholders = showIds.map(() => '?').join(',');
    actors = (await env.DB.prepare(
      `SELECT show_id, name, imdb_id FROM actors WHERE show_id IN (${placeholders})`
    ).bind(...showIds).all()).results || [];
  }
  const subscriptions = (await env.DB.prepare(
    'SELECT * FROM member_subscriptions WHERE member_slug = ?'
  ).bind(slug).all()).results || [];

  await setState(env, 'baseline', JSON.stringify({ shows, actors, subscriptions }));
}

// Rebuild INSERT statements from a snapshot row's own keys, so the restore
// tolerates columns added by later migrations (older snapshots simply omit
// them and the column default applies) and columns dropped since (a
// snapshot taken before normalizing carries the show's facts on the row;
// `columns`, when given, keeps only the ones the table still has).
function insertFromRow(env, table, row, { dropId = false, columns = null } = {}) {
  const entries = Object.entries(row).filter(([k, v]) =>
    v !== null && !(dropId && k === 'id') && (!columns || columns.has(k)));
  const cols = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => v);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return env.DB.prepare(sql).bind(...vals);
}

// Restore the demo member's data to the baseline snapshot. With force=false
// (the cron/login path) it only runs once reset_due_at has passed.
export async function resetDemoIfDue(env, { force = false } = {}) {
  const slug = await demoMemberSlug(env);
  if (!slug) return { reset: false, reason: 'demo_not_configured' };

  const due = await getState(env, 'reset_due_at');
  if (!due) return { reset: false, reason: 'clean' };
  if (!force && new Date(due) > new Date()) {
    return { reset: false, reason: 'not_due_yet', due };
  }

  const baselineRaw = await getState(env, 'baseline');
  if (!baselineRaw) {
    // Nothing to restore to — drop the marker rather than wiping the account.
    await delState(env, 'reset_due_at');
    return { reset: false, reason: 'no_baseline' };
  }
  const baseline = JSON.parse(baselineRaw);
  const { results: showCols } = await env.DB.prepare("SELECT name FROM pragma_table_info('shows')").all();
  const showColumns = new Set((showCols || []).map((c) => c.name));

  const statements = [
    env.DB.prepare(
      'DELETE FROM actors WHERE show_id IN (SELECT id FROM shows WHERE member_slug = ?)'
    ).bind(slug),
    env.DB.prepare('DELETE FROM shows WHERE member_slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM member_subscriptions WHERE member_slug = ?').bind(slug),
    // Shows keep their original ids. Their facts and cast are their entries'
    // shared rows, which the restore doesn't touch; a snapshot's own actor
    // rows are no longer restored (copies don't carry cast since step 3c).
    ...(baseline.shows || []).map((s) => insertFromRow(env, 'shows', s, { columns: showColumns })),
    ...(baseline.subscriptions || []).map((s) =>
      insertFromRow(env, 'member_subscriptions', s, { dropId: true })),
  ];
  await env.DB.batch(statements);
  await delState(env, 'reset_due_at');
  return { reset: true, restored_shows: (baseline.shows || []).length };
}

// Called after every successful demo sign-in (email/code or Apple fallback).
// Never throws: a broken reset (e.g. demo_state table not migrated yet) must
// not break the login itself.
export async function noteDemoLogin(env, slug) {
  try {
    const demo = await demoMemberSlug(env);
    if (!demo || demo !== slug) return;

    // Overdue from a previous visitor? Start this one clean.
    await resetDemoIfDue(env);

    // No reset pending means the data on disk is canonical — snapshot it.
    const due = await getState(env, 'reset_due_at');
    if (!due) await snapshotBaseline(env, slug);

    // The wipe lands one hour after the most recent sign-in.
    await setState(env, 'reset_due_at',
      new Date(Date.now() + 60 * 60 * 1000).toISOString());
  } catch (e) {
    // Swallow: demo reset is best-effort at login time; the hourly cron
    // endpoint surfaces real errors.
  }
}

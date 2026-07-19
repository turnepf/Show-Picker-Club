// Merge a duplicate member account into the real one, then delete the
// duplicate. Built for the Apple "Hide My Email" case: a member signs into
// the iPhone app with a private-relay address we don't have on file, so
// self-enrollment mints a fresh account (with seeded shows) instead of
// finding theirs. Merging repoints everything at the kept account —
// crucially member_apple_ids, so the NEXT relay sign-in resolves straight
// to the right member.
//
//   POST { source: 'jessica-2', target: 'jessica' }
//
// What moves from source → target, in one all-or-nothing batch:
//   - shows (+ their actors, which key on show_id), EXCEPT:
//       * untouched seed rows (added_by='seed', updated_at IS NULL) — the
//         duplicate's auto-picks, dropped outright;
//       * active rows whose title (case-insensitive) already exists among
//         the target's active rows — the kept account's copy wins.
//   - member_emails / member_phones, deduped against the target's set and
//     demoted to is_primary=0 (the target keeps its own primaries; the
//     relay address stays usable for email-code login).
//   - member_apple_ids / member_google_ids — the identity repoint that
//     stops the duplicate from ever coming back.
//   - member_subscriptions, deduped on (member, network).
//   - sessions — the member's signed-in devices flip to the kept account
//     instead of being logged out.
//   - signup_requests.created_member_slug (audit trail follows the keeper).
//   - members.last_login_at — target takes the max of the two.
// login_otps for the source are deleted; then the source member row is.

import { isAdmin } from '../_shared/admin.js';
import { demoMemberSlug } from '../_shared/demo.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const source = String(body.source || '').trim();
  const target = String(body.target || '').trim();
  if (!source || !target) return json({ error: 'missing_slug' }, 400);
  if (source === target) return json({ error: 'same_member' }, 400);

  const srcRow = await env.DB.prepare(
    'SELECT slug, is_admin FROM members WHERE slug = ?'
  ).bind(source).first();
  const tgtRow = await env.DB.prepare(
    'SELECT slug FROM members WHERE slug = ?'
  ).bind(target).first();
  if (!srcRow || !tgtRow) return json({ error: 'unknown_member' }, 404);
  if (srcRow.is_admin) return json({ error: 'cannot_merge_admin' }, 400);

  const demo = await demoMemberSlug(env);
  if (demo && (demo === source || demo === target)) {
    return json({ error: 'cannot_merge_demo' }, 400);
  }

  // The two classes of source rows that do NOT move. Untouched seeds are the
  // duplicate account's auto-picks; "dupes" are active rows the target
  // already carries under the same title (any list — the keeper's copy wins).
  const untouchedSeed =
    "member_slug = ?1 AND added_by = 'seed' AND updated_at IS NULL";
  const titleDupe = `member_slug = ?1 AND archived = 0
       AND NOT (added_by = 'seed' AND updated_at IS NULL)
       AND EXISTS (SELECT 1 FROM shows t
                    WHERE t.member_slug = ?2 AND t.archived = 0
                      AND LOWER(t.title) = LOWER(shows.title))`;

  // Counts up front so the response can say what happened (the batch's
  // meta.changes are per-statement and awkward to attribute after dedupes).
  const count = async (sql, ...binds) =>
    ((await env.DB.prepare(sql).bind(...binds).first())?.cnt) || 0;
  const seedsDropped = await count(
    `SELECT COUNT(*) AS cnt FROM shows WHERE ${untouchedSeed}`, source);
  const dupesDropped = await count(
    `SELECT COUNT(*) AS cnt FROM shows WHERE ${titleDupe}`, source, target);
  const showsMoved = (await count(
    'SELECT COUNT(*) AS cnt FROM shows WHERE member_slug = ?1', source))
    - seedsDropped - dupesDropped;
  const emailsMoved = await count(
    `SELECT COUNT(*) AS cnt FROM member_emails WHERE member_slug = ?1
       AND email NOT IN (SELECT email FROM member_emails WHERE member_slug = ?2)`,
    source, target);
  const sessionsMoved = await count(
    'SELECT COUNT(*) AS cnt FROM sessions WHERE member_slug = ?1', source);

  const statements = [
    // 1) Drop the duplicate's untouched seed rows (and their cast).
    env.DB.prepare(
      `DELETE FROM actors WHERE show_id IN (SELECT id FROM shows WHERE ${untouchedSeed})`
    ).bind(source),
    env.DB.prepare(`DELETE FROM shows WHERE ${untouchedSeed}`).bind(source),
    // 2) Drop active rows the target already has under the same title.
    env.DB.prepare(
      `DELETE FROM actors WHERE show_id IN (SELECT id FROM shows WHERE ${titleDupe})`
    ).bind(source, target),
    env.DB.prepare(`DELETE FROM shows WHERE ${titleDupe}`).bind(source, target),
    // 3) Move the rest. Actors follow via show_id.
    env.DB.prepare('UPDATE shows SET member_slug = ?2 WHERE member_slug = ?1')
      .bind(source, target),
    // 4) Contacts: dedupe against the target, then move as non-primary
    //    alternates (UNIQUE(email|phone, member_slug) + the one-primary-per-
    //    member index stay satisfied).
    env.DB.prepare(
      `DELETE FROM member_emails WHERE member_slug = ?1
         AND email IN (SELECT email FROM member_emails WHERE member_slug = ?2)`
    ).bind(source, target),
    env.DB.prepare(
      'UPDATE member_emails SET member_slug = ?2, is_primary = 0 WHERE member_slug = ?1'
    ).bind(source, target),
    env.DB.prepare(
      `DELETE FROM member_phones WHERE member_slug = ?1
         AND phone IN (SELECT phone FROM member_phones WHERE member_slug = ?2)`
    ).bind(source, target),
    env.DB.prepare(
      'UPDATE member_phones SET member_slug = ?2, is_primary = 0 WHERE member_slug = ?1'
    ).bind(source, target),
    // 5) Identity links — future Apple relay sign-ins resolve to the keeper.
    env.DB.prepare(
      'UPDATE member_apple_ids SET member_slug = ?2 WHERE member_slug = ?1'
    ).bind(source, target),
    // 6) Subscriptions, deduped on (member, network).
    env.DB.prepare(
      `DELETE FROM member_subscriptions WHERE member_slug = ?1
         AND network IN (SELECT network FROM member_subscriptions WHERE member_slug = ?2)`
    ).bind(source, target),
    env.DB.prepare(
      'UPDATE member_subscriptions SET member_slug = ?2 WHERE member_slug = ?1'
    ).bind(source, target),
    // 7) The member's signed-in devices carry over instead of logging out.
    env.DB.prepare('UPDATE sessions SET member_slug = ?2 WHERE member_slug = ?1')
      .bind(source, target),
    env.DB.prepare('DELETE FROM login_otps WHERE member_slug = ?1').bind(source),
    // 8) Audit trail follows the keeper.
    env.DB.prepare(
      'UPDATE signup_requests SET created_member_slug = ?2 WHERE created_member_slug = ?1'
    ).bind(source, target),
    // 9) Keep the freshest last-login on the target. NULLIF/COALESCE because
    //    scalar MAX() returns NULL if either side is NULL; ISO strings
    //    compare lexicographically. Must run before the source row deletes.
    env.DB.prepare(
      `UPDATE members SET last_login_at = NULLIF(MAX(
         COALESCE(last_login_at, ''),
         COALESCE((SELECT last_login_at FROM members WHERE slug = ?1), '')
       ), '') WHERE slug = ?2`
    ).bind(source, target),
    env.DB.prepare('DELETE FROM members WHERE slug = ?1').bind(source),
  ];

  // member_google_ids only exists from migration 031 — include it, retry
  // without on older databases (batch is all-or-nothing).
  try {
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE member_google_ids SET member_slug = ?2 WHERE member_slug = ?1'
      ).bind(source, target),
      ...statements,
    ]);
  } catch (e) {
    await env.DB.batch(statements);
  }

  // Best-effort: drop any dismissed-duplicate matches that referenced the
  // now-deleted account (table may not exist yet — see admin-dupe-ignores).
  await env.DB.prepare(
    'DELETE FROM dupe_ignores WHERE slug_a = ?1 OR slug_b = ?1'
  ).bind(source).run().catch(() => {});

  return json({
    ok: true,
    source,
    target,
    shows_moved: showsMoved,
    seed_shows_dropped: seedsDropped,
    duplicate_shows_dropped: dupesDropped,
    emails_moved: emailsMoved,
    sessions_moved: sessionsMoved,
  });
}

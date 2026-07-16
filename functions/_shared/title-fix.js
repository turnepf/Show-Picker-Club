// Member-safe title renaming, shared by the operator's manual title-fix
// control in the URL-cleanup queue. (The automatic og:title recovery that
// used to live here was retired once TMDB type-ahead pinning made new rows
// arrive with canonical titles — see docs/PRODUCT.md.)

// Rename every active copy of a title, member-safely: if a member already
// carries the show under its real name, their wrong-titled duplicate is
// archived instead of renamed (renaming would give them the same show twice).
// Returns the number of rows renamed.
export async function renameShowCopies(env, oldTitle, newTitle) {
  if (oldTitle.toLowerCase() !== newTitle.toLowerCase()) {
    await env.DB.prepare(
      `UPDATE shows SET archived = 1, enriched_at = datetime('now')
        WHERE LOWER(title) = LOWER(?) AND archived = 0
          AND member_slug IN (SELECT member_slug FROM shows
                               WHERE LOWER(title) = LOWER(?) AND archived = 0)`
    ).bind(oldTitle, newTitle).run();
  }
  const upd = await env.DB.prepare(
    `UPDATE shows SET title = ?, enriched_at = datetime('now')
      WHERE LOWER(title) = LOWER(?) AND archived = 0`
  ).bind(newTitle, oldTitle).run();
  return upd.meta.changes;
}

// Everything that points at a member, other than the identities and lists the
// delete and merge paths already handle themselves.
//
// Security audit run-2: account deletion and admin merge deleted the members
// row while these rows still named the slug. With foreign keys enforced that
// failed the whole deletion (so an account a member asked to delete stayed
// live); without enforcement the rows dangled, and createMember hands a freed
// slug to the next signup with the same first name, who inherited the old
// member's group memberships and household links.
//
// Delete mode removes or unlinks every reference. Merge mode moves them to the
// surviving member (duplicates fold into what the target already has).
// Children come before parents so the statements hold with or without
// foreign-key enforcement. Groups the departing member created go with them:
// a deleted account can't hand a group on (see group-delete.js).

export function memberReferenceStatements(env, slug, { mergeInto = null } = {}) {
  const P = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  if (mergeInto) {
    const t = mergeInto;
    return [
      P('UPDATE OR IGNORE show_ratings SET member_slug = ? WHERE member_slug = ?', t, slug),
      P('DELETE FROM show_ratings WHERE member_slug = ?', slug),
      P('UPDATE show_watchers SET created_by = ? WHERE created_by = ?', t, slug),
      P('INSERT OR IGNORE INTO household_members (member_slug, other_slug, created_at) SELECT ?, other_slug, created_at FROM household_members WHERE member_slug = ? AND other_slug != ?', t, slug, t),
      P('INSERT OR IGNORE INTO household_members (member_slug, other_slug, created_at) SELECT member_slug, ?, created_at FROM household_members WHERE other_slug = ? AND member_slug != ?', t, slug, t),
      P('DELETE FROM household_members WHERE member_slug = ? OR other_slug = ?', slug, slug),
      P('UPDATE household_invites SET inviter_slug = ? WHERE inviter_slug = ?', t, slug),
      P('DELETE FROM member_platforms WHERE member_slug = ?', slug),
      P('DELETE FROM member_spend WHERE member_slug = ?', slug),
      P('DELETE FROM import_pending WHERE member_slug = ?', slug),
      P('UPDATE failed_logins SET member_slug = NULL WHERE member_slug = ?', slug),
      P('UPDATE OR IGNORE group_members SET member_slug = ? WHERE member_slug = ?', t, slug),
      P('DELETE FROM group_members WHERE member_slug = ?', slug),
      P('UPDATE group_invites SET created_by = ? WHERE created_by = ?', t, slug),
      P('UPDATE groups SET creator_slug = ? WHERE creator_slug = ?', t, slug),
      P('UPDATE groups SET profile_changed_by = ? WHERE profile_changed_by = ?', t, slug),
    ];
  }
  const own = 'SELECT id FROM groups WHERE creator_slug = ?';
  return [
    P('DELETE FROM show_ratings WHERE member_slug = ?', slug),
    P('UPDATE show_watchers SET created_by = NULL WHERE created_by = ?', slug),
    P('DELETE FROM household_members WHERE member_slug = ? OR other_slug = ?', slug, slug),
    P('DELETE FROM household_invites WHERE inviter_slug = ?', slug),
    P('DELETE FROM member_platforms WHERE member_slug = ?', slug),
    P('DELETE FROM member_spend WHERE member_slug = ?', slug),
    P('DELETE FROM import_pending WHERE member_slug = ?', slug),
    P('UPDATE failed_logins SET member_slug = NULL WHERE member_slug = ?', slug),
    // Groups they created, with everything in them.
    P(`DELETE FROM group_suggestion_responses WHERE suggestion_id IN (SELECT id FROM group_suggestions WHERE group_id IN (${own}))`, slug),
    P(`DELETE FROM group_suggestions WHERE group_id IN (${own})`, slug),
    P(`DELETE FROM group_invites WHERE group_id IN (${own})`, slug),
    P(`DELETE FROM group_members WHERE group_id IN (${own})`, slug),
    P('DELETE FROM groups WHERE creator_slug = ?', slug),
    // Their place in other people's groups.
    P('DELETE FROM group_invites WHERE created_by = ?', slug),
    P('DELETE FROM group_members WHERE member_slug = ?', slug),
    P('UPDATE groups SET profile_changed_by = NULL WHERE profile_changed_by = ?', slug),
  ];
}

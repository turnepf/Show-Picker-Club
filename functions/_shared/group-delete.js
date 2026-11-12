// Deleting a group and everything that belongs to it.
//
// One helper for every way a group ends: its creator deletes it, its creator
// leaves it without handing it to another member (security audit run-2,
// owner decision), or its creator's account is deleted. Children are removed
// before the group row so the result is the same with or without foreign-key
// enforcement.

// The statements, for callers that fold them into a larger batch.
export function groupDeleteStatements(env, groupId) {
  return [
    env.DB.prepare(
      'DELETE FROM group_suggestion_responses WHERE suggestion_id IN (SELECT id FROM group_suggestions WHERE group_id = ?)'
    ).bind(groupId),
    env.DB.prepare('DELETE FROM group_suggestions WHERE group_id = ?').bind(groupId),
    env.DB.prepare('DELETE FROM group_invites WHERE group_id = ?').bind(groupId),
    env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId),
    env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId),
  ];
}

export async function deleteGroup(env, groupId) {
  await env.DB.batch(groupDeleteStatements(env, groupId));
}

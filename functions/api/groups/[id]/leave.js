import { deleteGroup } from '../../../_shared/group-delete.js';
import { getSession } from '../../../_shared/auth.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

async function checkGroupMembership(env, groupId, memberSlug) {
  const membership = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, memberSlug).first();
  return !!membership;
}

export async function onRequestPost(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  const isMember = await checkGroupMembership(env, groupId, session.member_slug);
  if (!isMember) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  const group = await env.DB.prepare('SELECT id, creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  if (!group) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }

  // The creator leaving either hands the group to another member or deletes
  // it for everyone (owner decision, security audit run-2). The client must
  // say which: `transfer_to` names a current member to take it over, and
  // `confirm_delete: true` says the member saw the delete warning. An app
  // build from before the delete rule sends neither and gets told to update,
  // rather than deleting a group on a prompt that only said "Leave group?".
  let handTo = null;
  if (group.creator_slug === session.member_slug) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    if (body && typeof body.transfer_to === 'string' && body.transfer_to.trim()) {
      handTo = body.transfer_to.trim();
      // Only somebody already in the group can be handed it: an invite is how
      // anyone else gets in, and creator is the one role a group-mate can't
      // turn down here, so it goes only to people who chose this group.
      if (handTo === session.member_slug || !(await checkGroupMembership(env, groupId, handTo))) {
        return new Response(JSON.stringify({
          error: 'not_a_member',
          message: 'You can only hand the group to someone who is in it.',
        }), { status: 400, headers: corsHeaders() });
      }
    } else if (!body || body.confirm_delete !== true) {
      return new Response(JSON.stringify({
        error: 'creator_must_confirm',
        message: 'You created this group, so leaving deletes it for everyone. Update the app to leave this group, or delete it instead.',
      }), { status: 409, headers: corsHeaders() });
    } else {
      await deleteGroup(env, groupId);
      return new Response(JSON.stringify({ ok: true, deleted: true }), { headers: corsHeaders() });
    }
  }

  // Check if this would leave the group empty (reject)
  const { cnt: memberCount } = (await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?'
  ).bind(groupId).first()) || { cnt: 0 };

  if (memberCount <= 1) {
    return new Response(JSON.stringify({ error: 'Cannot leave a group with only one member' }), { status: 400, headers: corsHeaders() });
  }

  // Leaving takes your recommendations off the group's board — a card is a
  // memo about your taste addressed to people you were in a group with, and
  // it shouldn't keep speaking for you after you've gone. Your dismissed/
  // added marks on other people's cards go too; they only shaped your own
  // view. (Try/catch: a database without migration 065 has no board.)
  try {
    await env.DB.prepare(
      'DELETE FROM group_suggestions WHERE group_id = ? AND suggested_by = ?'
    ).bind(groupId, session.member_slug).run();
    await env.DB.prepare(
      `DELETE FROM group_suggestion_responses WHERE member_slug = ?
        AND suggestion_id IN (SELECT id FROM group_suggestions WHERE group_id = ?)`
    ).bind(session.member_slug, groupId).run();
  } catch (e) { /* pre-065 database */ }

  // Your outstanding invites go with you, for the same reason. An invite is
  // one member vouching for someone; once you've left there is nobody behind
  // it, and a link you shared last week would otherwise keep admitting
  // strangers to a group you're no longer in. join.js re-checks the issuer's
  // membership as well, so a row that predates this still stops working.
  // The hand-over, the invites and the membership go in one batch, so a
  // group is never left with a creator who isn't in it. The creator_slug
  // guard means a second, racing hand-over changes nothing.
  const statements = [];
  if (handTo) {
    statements.push(env.DB.prepare(
      'UPDATE groups SET creator_slug = ? WHERE id = ? AND creator_slug = ?'
    ).bind(handTo, groupId, session.member_slug));
  }
  statements.push(
    env.DB.prepare('DELETE FROM group_invites WHERE group_id = ? AND created_by = ?').bind(groupId, session.member_slug),
    env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND member_slug = ?').bind(groupId, session.member_slug),
  );
  await env.DB.batch(statements);

  return new Response(JSON.stringify(handTo ? { ok: true, transferred_to: handTo } : { ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

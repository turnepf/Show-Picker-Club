import { getSession } from '../../_shared/auth.js';
import { GROUP_ICONS, GROUP_COLORS, readIconField } from '../../_shared/group-icons.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

async function checkGroupMembership(env, groupId, memberSlug) {
  const membership = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, memberSlug).first();
  return !!membership;
}

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  const membership = await env.DB.prepare(
    'SELECT joined_at, last_seen_change_at FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(groupId, session.member_slug).first();
  if (!membership) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  // Same shape as the group list — the apps decode one Group model, and the
  // detail screen gates its Delete action on is_creator. profile_changed_*
  // rides along here rather than a second query, then gets stripped before
  // this becomes the "group" the client decodes (see below).
  const row = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at, icon, color,
            profile_changed_by, profile_changed_at, profile_changed_fields,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();
  if (!row) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }
  const { profile_changed_by, profile_changed_at, profile_changed_fields, ...group } = row;

  // Get members with their show counts
  const { results: members } = await env.DB.prepare(
    `SELECT m.slug, m.first_name, m.last_name,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0) AS show_count,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0 AND list = 'watching') AS watching_count,
            (SELECT COUNT(*) FROM shows WHERE member_slug = m.slug AND archived = 0 AND list = 'awaiting') AS awaiting_count,
            MAX(s.updated_at) AS last_activity_at
     FROM group_members gm
     INNER JOIN members m ON m.slug = gm.member_slug
     LEFT JOIN shows s ON s.member_slug = m.slug
     WHERE gm.group_id = ?
     GROUP BY m.slug
     ORDER BY m.first_name, m.last_name`
  ).bind(groupId).all();

  const isCreator = group.creator_slug === session.member_slug;

  // Tell a member once that somebody else renamed the group or changed its
  // icon: never to the member who made the change (they know), never to a
  // member who joined after it happened (they've never known it any other
  // way), and never twice — seeing it here is what advances my own
  // high-water mark below, whether or not there was anything to show.
  let changeNotice = null;
  if (
    profile_changed_at &&
    profile_changed_by !== session.member_slug &&
    membership.joined_at <= profile_changed_at &&
    (!membership.last_seen_change_at || membership.last_seen_change_at < profile_changed_at)
  ) {
    const changer = await env.DB.prepare('SELECT first_name FROM members WHERE slug = ?')
      .bind(profile_changed_by).first();
    changeNotice = {
      changed_by: profile_changed_by,
      changed_by_name: changer?.first_name || profile_changed_by,
      changed_fields: profile_changed_fields ? profile_changed_fields.split(',') : [],
      changed_at: profile_changed_at,
    };
  }
  if (profile_changed_at && profile_changed_at !== membership.last_seen_change_at) {
    await env.DB.prepare(
      'UPDATE group_members SET last_seen_change_at = ? WHERE group_id = ? AND member_slug = ?'
    ).bind(profile_changed_at, groupId, session.member_slug).run();
  }

  return new Response(JSON.stringify({
    group,
    members,
    is_creator: isCreator,
    can_manage: isCreator,
    change_notice: changeNotice
  }), { headers: corsHeaders() });
}

// Rename a group and/or set its icon/color. Any group member may — creator
// was the original bar (and still is for Delete, see below), but Patrick hit
// it as a member of a group he didn't create and there was no reason a
// group-mate couldn't tidy up a shared thing. groups.html has been calling
// this since private groups shipped; the handler never existed, so every
// rename came back 405.
export async function onRequestPatch(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  // Icon and color ride the same PATCH (migration 066): an absent key leaves
  // the stored value alone, null clears it, and anything outside the curated
  // sets is rejected rather than stored.
  const icon = readIconField(body, 'icon', GROUP_ICONS);
  const color = readIconField(body, 'color', GROUP_COLORS);
  if (!icon.ok || !color.ok) {
    return new Response(JSON.stringify({ error: 'Unknown icon or color' }), { status: 400, headers: corsHeaders() });
  }
  if (!name && !icon.present && !color.present) {
    return new Response(JSON.stringify({ error: 'Group name is required' }), { status: 400, headers: corsHeaders() });
  }

  const existing = await env.DB.prepare('SELECT name, icon, color FROM groups WHERE id = ?').bind(groupId).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }
  const isMember = await checkGroupMembership(env, groupId, session.member_slug);
  if (!isMember) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  const sets = [];
  const binds = [];
  // What actually changed, for the "X renamed the group" notice everyone
  // else gets once (migration 068) — not just what was sent. Icon and color
  // are one user-facing action ("Change icon"), so they fold into a single
  // 'icon' field rather than two.
  const changedFields = [];
  if (name && name !== existing.name) { sets.push('name = ?'); binds.push(name); changedFields.push('name'); }
  const iconChanged = icon.present && icon.value !== existing.icon;
  const colorChanged = color.present && color.value !== existing.color;
  if (icon.present) { sets.push('icon = ?'); binds.push(icon.value); }
  if (color.present) { sets.push('color = ?'); binds.push(color.value); }
  if (iconChanged || colorChanged) changedFields.push('icon');

  if (changedFields.length > 0) {
    // Stamped via the DB's own clock, in the same 'YYYY-MM-DD HH:MM:SS[.SSS]'
    // shape as joined_at's `datetime('now')` default — mixing that with a JS
    // `toISOString()` (which inserts a 'T') would break the string
    // comparisons GET does against it, since ' ' sorts before 'T' regardless
    // of the actual times involved. Millisecond precision (`%f`, vs.
    // datetime('now')'s whole seconds) matters here specifically: two edits
    // landing in the same second — a rename right after an icon change, say
    // — need to stay distinguishable so a member's high-water mark against
    // the first doesn't accidentally also cover the second.
    const { now } = await env.DB.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS now").first();
    sets.push('profile_changed_by = ?', 'profile_changed_at = ?', 'profile_changed_fields = ?');
    binds.push(session.member_slug, now, changedFields.join(','));
    // I've obviously seen my own change — this keeps it from ever notifying
    // me about myself.
    await env.DB.prepare(
      'UPDATE group_members SET last_seen_change_at = ? WHERE group_id = ? AND member_slug = ?'
    ).bind(now, groupId, session.member_slug).run();
  }

  if (sets.length > 0) {
    await env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, groupId).run();
  }

  // Same group shape every other endpoint returns, so clients can swap it in.
  const group = await env.DB.prepare(
    `SELECT id, name, creator_slug, created_at, icon, color,
            (SELECT COUNT(*) FROM group_members WHERE group_id = groups.id) AS member_count,
            CASE WHEN creator_slug = ? THEN 1 ELSE 0 END AS is_creator
     FROM groups WHERE id = ?`
  ).bind(session.member_slug, groupId).first();

  return new Response(JSON.stringify({ group }), { headers: corsHeaders() });
}

export async function onRequestDelete(context) {
  const { env, request, params } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const groupId = parseInt(params.id, 10);
  if (!Number.isInteger(groupId)) {
    return new Response(JSON.stringify({ error: 'Invalid group ID' }), { status: 400, headers: corsHeaders() });
  }

  const group = await env.DB.prepare('SELECT creator_slug FROM groups WHERE id = ?').bind(groupId).first();
  if (!group) {
    return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: corsHeaders() });
  }

  if (group.creator_slug !== session.member_slug) {
    return new Response(JSON.stringify({ error: 'Only the creator can delete a group' }), { status: 403, headers: corsHeaders() });
  }

  await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run();
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

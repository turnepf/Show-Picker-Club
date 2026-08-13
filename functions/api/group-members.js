import { getSession } from '../_shared/auth.js';
import { groupMates, displayNames } from '../_shared/watchers.js';

// Everyone the caller shares at least one private group with. This is the
// candidate list behind the "Watching with" picker: the people you are allowed
// to name on a show, which is exactly the people a tag is allowed to write to.
//
// Session-gated and self-scoped — it answers for the caller and nobody else,
// so there is no slug parameter to hand-type. Names are first-name level, the
// same shape /api/members returns, because that is all any member surface
// exposes about anyone.
//
// `groups` names which of the caller's groups each person is in, so the picker
// can say why someone is on the list when the caller belongs to several.
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const mates = await groupMates(env, session.member_slug);
  const names = displayNames(mates);

  const { results: memberships } = await env.DB.prepare(
    `SELECT gm.member_slug, g.name AS group_name
       FROM group_members gm
       INNER JOIN groups g ON g.id = gm.group_id
      WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?)
        AND gm.member_slug != ?`
  ).bind(session.member_slug, session.member_slug).all();

  const groupsBySlug = {};
  for (const r of memberships || []) {
    (groupsBySlug[r.member_slug] = groupsBySlug[r.member_slug] || []).push(r.group_name);
  }

  const members = mates.map((m) => ({
    slug: m.slug,
    name: names.get(m.slug),
    groups: groupsBySlug[m.slug] || [],
  }));

  return new Response(JSON.stringify({ members }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

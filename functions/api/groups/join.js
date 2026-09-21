import { getSession } from '../../_shared/auth.js';

const WEB_ORIGIN = 'https://showpicker.club';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

// Redeeming an invite is a WRITE performed by a cookie-authenticated GET, so
// a top-level navigation from anywhere on the web used to carry the victim's
// session into it: one link, and a signed-in member was a member of the
// attacker's private group — which is the boundary the whole product's
// privacy rests on. SameSite=Lax doesn't help, because it permits the cookie
// on exactly this kind of navigation.
//
// The verb is wrong and the write belongs on a POST, but both shipped clients
// call this as a GET (ios/ShowPickerIOS/API.swift and public/groups.html), so
// moving it would break group invites on every installed app until a new
// build reached the App Store. This gate closes the cross-site vector today
// without touching either client:
//
//   - A browser sends Sec-Fetch-Site on every request. Our own page's
//     fetch() sends `same-origin`; a cross-site link sends `cross-site`,
//     which is the case being refused.
//   - Native clients (URLSession) send neither Sec-Fetch-Site nor Origin, so
//     they fall through the gate unaffected. That is deliberate: a header no
//     attacker-controlled browser can suppress is what does the work here,
//     and a browser that omits it is not a browser.
//
// When the clients move to POST, this check moves with the write rather than
// being deleted.
function crossSite(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return !['same-origin', 'same-site', 'none'].includes(site);
  const origin = request.headers.get('Origin');
  if (origin) return origin !== WEB_ORIGIN;
  return false;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'token required' }), { status: 400, headers: corsHeaders() });
  }

  // created_by, use_count, max_uses and revoked_at are selected here because
  // the checks below read them — an issuer-liveness check reading a column
  // this SELECT doesn't return would bind undefined and refuse every
  // redemption, including the legitimate first-time join this route exists
  // for.
  const invite = await env.DB.prepare(
    `SELECT gi.id, gi.group_id, gi.expires_at, gi.created_by,
            gi.use_count, gi.max_uses, gi.revoked_at,
            g.name, g.creator_slug
     FROM group_invites gi
     INNER JOIN groups g ON g.id = gi.group_id
     WHERE gi.token = ?`
  ).bind(token).first();

  if (!invite) {
    return new Response(JSON.stringify({ error: 'Invite not found or expired' }), { status: 404, headers: corsHeaders() });
  }

  // Revoked, exhausted and expired all answer alike. A dead link should not
  // tell its holder which kind of dead it is, or that it was ever real.
  const spent = invite.revoked_at
    || (invite.use_count ?? 0) >= (invite.max_uses ?? 10)
    || new Date(invite.expires_at) < new Date();
  if (spent) {
    return new Response(JSON.stringify({ error: 'Invite expired' }), { status: 410, headers: corsHeaders() });
  }

  // If no session, return preview only
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({
      group: {
        id: invite.group_id,
        name: invite.name
      },
      join_required: true
    }), { headers: corsHeaders() });
  }

  // Session exists; check if already a member
  const existing = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(invite.group_id, session.member_slug).first();

  if (existing) {
    return new Response(JSON.stringify({
      error: 'already_member',
      group_id: invite.group_id
    }), { status: 409, headers: corsHeaders() });
  }

  // Everything above this line is a read. The write starts here, so this is
  // where the cross-site refusal belongs: a cross-site caller still gets the
  // group's name (it is already on the link they hold) but joins nobody.
  if (crossSite(request)) {
    return new Response(JSON.stringify({
      group: { id: invite.group_id, name: invite.name },
      join_required: true
    }), { headers: corsHeaders() });
  }

  // An invite is a member vouching for someone. Once that member has left the
  // group, the vouching has no author, so their outstanding links stop
  // working — leave.js deletes them, and this covers a row that predates it
  // or a membership removed some other way.
  const issuerStillIn = await env.DB.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND member_slug = ?'
  ).bind(invite.group_id, invite.created_by).first();
  if (!issuerStillIn) {
    return new Response(JSON.stringify({ error: 'Invite expired' }), { status: 410, headers: corsHeaders() });
  }

  // Claim a use atomically BEFORE writing membership. The guard is in the
  // WHERE clause, not in JavaScript, so two redemptions racing each other
  // cannot both read use_count = max_uses - 1 and both proceed: D1 reports
  // one changed row and the loser gets none.
  const claim = await env.DB.prepare(
    `UPDATE group_invites SET use_count = use_count + 1
      WHERE id = ? AND use_count < max_uses AND revoked_at IS NULL`
  ).bind(invite.id).run();
  if (!claim.meta || claim.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Invite expired' }), { status: 410, headers: corsHeaders() });
  }

  // Add member to group
  await env.DB.prepare(
    'INSERT INTO group_members (group_id, member_slug) VALUES (?, ?)'
  ).bind(invite.group_id, session.member_slug).run();

  return new Response(JSON.stringify({
    ok: true,
    group_id: invite.group_id,
    group: {
      id: invite.group_id,
      name: invite.name
    }
  }), { headers: corsHeaders() });
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

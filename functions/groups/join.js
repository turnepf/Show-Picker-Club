import { ogPage } from '../_shared/og-page.js';

// GET /groups/join?token=… — the link preview for a group invite.
//
// The tap is already handled: iOS routes this URL into the app, which redeems
// the token and lands on the group (HomeView.route(url:)). This renders the
// bubble, so it reads "Join Thursday Night Club on Show Picker Club" instead of
// the generic marketing card every share used to get.
//
// PUBLIC, no session — but it says no more than the API already does. A
// logged-out GET /api/groups/join?token=… returns the group's name for exactly
// this purpose (its `join_required` branch); the token is the credential.
// **Only the group's name.** Never its members, their slugs, or anything on
// their lists.

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const canonical = `https://showpicker.club/groups/join${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const generic = {
    title: 'Join a group on Show Picker Club',
    description: 'This invite link has expired or is no longer valid. Ask for a new one.',
    url: canonical,
    status: 404,
  };

  if (!token) return ogPage(generic);

  const invite = await env.DB.prepare(
    `SELECT gi.expires_at, gi.use_count, gi.max_uses, gi.revoked_at, g.name
       FROM group_invites gi
       INNER JOIN groups g ON g.id = gi.group_id
      WHERE gi.token = ?`
  ).bind(token).first();

  // Unknown, expired, revoked and exhausted all render the same card. A live
  // invite is the only thing that gets a group name — a dead link must not
  // name the group it used to open, or confirm that it was ever real. This
  // page has no session, so the card is what anyone holding the URL sees.
  const dead = !invite
    || new Date(invite.expires_at) < new Date()
    || invite.revoked_at
    || (invite.use_count ?? 0) >= (invite.max_uses ?? 10);
  if (dead) return ogPage(generic);

  const name = (invite.name || '').trim() || 'a group';

  return ogPage({
    title: `Join ${name} on Show Picker Club`,
    heading: `Join ${name}`,
    description: 'See what everyone in the group is watching, and what they think is worth your time.',
    url: canonical,
    // The web app can finish this one: /groups reads ?token= and redeems it.
    // Only on a live invite — the expired and unknown cards stay identical, so
    // a dead link still can't confirm the invite ever existed.
    webUrl: `/groups?token=${encodeURIComponent(token)}`,
    webLabel: 'Join in your browser',
  });
}

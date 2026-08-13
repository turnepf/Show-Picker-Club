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
    `SELECT gi.expires_at, g.name
       FROM group_invites gi
       INNER JOIN groups g ON g.id = gi.group_id
      WHERE gi.token = ?`
  ).bind(token).first();

  // Unknown and expired render the same card. A live invite is the only thing
  // that gets a group name.
  if (!invite || new Date(invite.expires_at) < new Date()) return ogPage(generic);

  const name = (invite.name || '').trim() || 'a group';

  return ogPage({
    title: `Join ${name} on Show Picker Club`,
    heading: `Join ${name}`,
    description: 'See what everyone in the group is watching, and what they think is worth your time.',
    url: canonical,
  });
}

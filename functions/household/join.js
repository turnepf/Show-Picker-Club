import { ogPage } from '../_shared/og-page.js';

// GET /household/join?code=… — the link preview for a household invite.
//
// As with the group invite, the tap is already the app's job: iOS redeems the
// code and lands on the subscription audit (HomeView.route(url:)). This is only
// the bubble.
//
// PUBLIC, no session. A household has no name of its own — the table stores
// `inviter_slug` — so the card is named after whoever sent it, using their
// **first name only**, which is already public surface (the roster exposes
// first names). Nothing about either household's shows or services appears
// here, and an unknown or expired code never confirms it existed.

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const canonical = `https://showpicker.club/household/join${code ? `?code=${encodeURIComponent(code)}` : ''}`;

  const generic = {
    title: 'Join a household on Show Picker Club',
    description: 'This invite link has expired or is no longer valid. Ask for a new one.',
    url: canonical,
    status: 404,
  };

  if (!code) return ogPage(generic);

  const invite = await env.DB.prepare(
    `SELECT hi.expires_at, m.first_name, m.name, m.slug
       FROM household_invites hi
       LEFT JOIN members m ON m.slug = hi.inviter_slug
      WHERE hi.code = ?`
  ).bind(code).first();

  if (!invite || new Date(invite.expires_at) < new Date()) return ogPage(generic);

  // Same fallback chain the rest of the app uses for a display first name.
  const first =
    (invite.first_name || '').trim() ||
    (invite.name || '').trim().split(' ')[0] ||
    invite.slug ||
    '';
  const whose = first ? `${first}'s household` : 'a household';

  return ogPage({
    title: `Join ${whose} on Show Picker Club`,
    heading: `Join ${whose}`,
    description: 'Pool your streaming services so the subscription audit counts each one once, not twice.',
    url: canonical,
  });
}

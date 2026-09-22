// Minting a group invite, in one place.
//
// Two routes hand out links — creating a group (functions/api/groups.js) and
// inviting to one that already exists (functions/api/groups/[id]/invite.js) —
// and each carried its own copy of the token generator, the seven-day expiry
// and the URL shape.
//
// The ceiling is why they're together now rather than merely why they could
// be. Migration 070 bounded a link at ten redemptions, and the invite sheet
// in the app states that number to whoever is about to share the link. A
// promise made on the client and enforced on the server is two numbers that
// drift; this is one constant, reported by whichever route mints.

export const INVITE_MAX_USES = 10;
export const INVITE_TTL_DAYS = 7;

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 24; i++) {
    token += chars[arr[i] % chars.length];
  }
  return token;
}

// Writes the row and answers in the shape both routes return. max_uses is
// bound rather than left to the column default so this module is the one
// place the number is written down.
export async function mintInvite(env, groupId, createdBy) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO group_invites (group_id, token, expires_at, created_by, max_uses) VALUES (?, ?, ?, ?, ?)'
  ).bind(groupId, token, expiresAt, createdBy, INVITE_MAX_USES).run();

  return {
    token,
    expires_at: expiresAt,
    max_uses: INVITE_MAX_USES,
    url: `https://showpicker.club/groups/join?token=${token}`,
  };
}

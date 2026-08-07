// Passkey plumbing shared by the four /auth/passkey-* endpoints and the
// /api/passkeys management routes: who the relying party is, and the
// single-use challenge store that stops a captured assertion being replayed.
//
// The cryptography itself lives in _shared/webauthn.js; this file is the
// policy and the storage around it.

import { randomChallenge } from './webauthn.js';

// The relying party is the site, not the app: one credential works across
// iPhone, iPad and Mac because they all share the iCloud Keychain and the
// same associated domain. `webcredentials:showpicker.club` in the app's
// entitlements plus the `webcredentials` block in the AASA file is what
// authorizes the native app to use it — see docs/ARCHITECTURE.md#passkeys.
const DEFAULT_RP_ID = 'showpicker.club';
const DEFAULT_ORIGIN = 'https://showpicker.club';

export const RP_NAME = 'Show Picker Club';

export function rpId(env) {
  return env.PASSKEY_RP_ID || DEFAULT_RP_ID;
}

// The origin the authenticator reports in clientDataJSON. Native Apple
// clients report `https://<rpId>` exactly as the web does, so one entry
// covers every platform. Overridable as a comma-separated list for local
// preview against wrangler's localhost origin.
export function allowedOrigins(env) {
  const configured = (env.PASSKEY_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return configured.length ? configured : [DEFAULT_ORIGIN];
}

// Challenges are short-lived on purpose: long enough for a Face ID prompt and
// a slow network, short enough that a stolen one is worthless by the time
// it's used.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Outstanding (unexpired) challenges one IP may hold at once. Starting a
// sign-in is unauthenticated, so without a ceiling anyone could write rows
// into the table indefinitely. Well above a person fumbling Face ID.
const MAX_OPEN_CHALLENGES_PER_IP = 20;

/**
 * Mint a challenge and record it. `purpose` is 'register' or 'authenticate';
 * `memberSlug` is set for registration (the member is already signed in) and
 * NULL for authentication (we don't know who they are yet — that's the point
 * of a discoverable credential).
 *
 * Returns null when the IP is over its ceiling.
 */
export async function createChallenge(env, purpose, memberSlug = null, ip = null) {
  const now = Date.now();
  const nowISO = new Date(now).toISOString();

  // Sweep first, so expired rows don't count against the cap below. Cheap,
  // and there is no cron for this.
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?')
    .bind(nowISO).run().catch(() => {});

  if (ip) {
    const { cnt } = (await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM webauthn_challenges WHERE ip = ? AND expires_at > ?'
    ).bind(ip, nowISO).first().catch(() => ({ cnt: 0 }))) || { cnt: 0 };
    if (cnt >= MAX_OPEN_CHALLENGES_PER_IP) return null;
  }

  const challenge = randomChallenge();
  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (challenge, purpose, member_slug, ip, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    challenge,
    purpose,
    memberSlug,
    ip,
    new Date(now + CHALLENGE_TTL_MS).toISOString(),
    nowISO
  ).run();

  return challenge;
}

/**
 * Consume a challenge: it must exist, match the purpose, not be expired, and
 * — for registration — belong to the member completing it. Deleting before
 * returning is what makes it single-use, so a replayed request finds nothing.
 * Returns the row on success, null on any failure.
 */
export async function consumeChallenge(env, challenge, purpose, memberSlug = null) {
  if (!challenge) return null;
  const row = await env.DB.prepare(
    'SELECT challenge, purpose, member_slug, expires_at FROM webauthn_challenges WHERE challenge = ?'
  ).bind(challenge).first().catch(() => null);

  // Delete on every lookup, hit or miss — a challenge that was offered up to
  // a failed verification must not get a second attempt either.
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?')
    .bind(challenge).run().catch(() => {});

  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  if (purpose === 'register' && row.member_slug !== memberSlug) return null;
  return row;
}

// A member-facing name for a passkey. The client sends the device name it
// knows ("Patrick's iPhone"); anything longer or with control characters in
// it is not something we want rendering in a list of credentials.
export function cleanLabel(raw) {
  const label = String(raw || '').replace(/[\x00-\x1f<>]/g, '').trim();
  if (!label) return null;
  return label.slice(0, 60);
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://showpicker.club',
    'Content-Type': 'application/json',
  };
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), ...extraHeaders },
  });
}

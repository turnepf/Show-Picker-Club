// Which TMDB entry a paste-a-list row is, decided on the server.
//
// The import is two calls: /api/import/parse resolves each pasted title against
// TMDB, and /api/import/commit writes what the member kept. Everything between
// them round-trips through the client, so commit can't take the client's word
// for a row's identity: an id TMDB never served, under a name the client chose,
// would otherwise become a shared `titles` row every other member and the
// public Trending payload read (security audit run-2).
//
// So parse signs each TMDB match (type, id, TMDB's name, year) and commit
// accepts that tuple only with a valid signature. A client that doesn't carry
// the signature back (the iOS app before this change decodes import rows into
// a fixed struct) falls back to a bounded TMDB lookup in commit. URLs from the
// client are never used: the poster comes from TMDB through enrichment.
//
// Keyed by CRON_SECRET under its own label, like the unsubscribe token
// (_shared/winback.js), so it can't be confused with anything else signed with
// that key. With no key configured nothing is signed and commit always looks up.

const LABEL = 'import-identity:v1';

function message(item) {
  return [LABEL, item.tmdb_type, item.tmdb_id, item.title, item.year ?? ''].join('\u001f');
}

async function hmac(env, text) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.CRON_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hasIdentity(item) {
  return item && Number.isInteger(item.tmdb_id)
    && (item.tmdb_type === 'tv' || item.tmdb_type === 'movie')
    && typeof item.title === 'string' && item.title.length > 0;
}

// The signature parse attaches to a matched row, or null when there's nothing
// to sign (no TMDB match, or no key configured).
export async function signIdentity(env, item) {
  if (!env.CRON_SECRET || !hasIdentity(item)) return null;
  return hmac(env, message(item));
}

// True only when `sig` is parse's signature over exactly this row's identity.
export async function verifyIdentity(env, item, sig) {
  if (!env.CRON_SECRET || !hasIdentity(item) || typeof sig !== 'string' || !sig) return false;
  const expected = await hmac(env, message(item));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

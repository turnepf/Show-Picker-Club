// Defensive URL extractor for any field that's supposed to hold a single
// URL but might arrive with junk attached. Catches share-button payloads
// like "Check out Tell Me Lies on Hulu! https://www.hulu.com/series/..."
// that copy-pasted as a unit and stored verbatim.
//
// Returns the first http(s) substring, or null if the input is empty /
// not a string / contains no recognizable URL.

// A network_url ends up rendered into an href on the public site, so only
// http(s) URLs may be stored. Rejects javascript:, data:, and other
// script-bearing schemes, plus anything carrying quote/whitespace/angle
// characters that could break out of an HTML attribute (real streaming
// URLs percent-encode those). Returns the trimmed URL, or null if
// unsafe/empty.
export function safeNetworkUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const t = url.trim();
  if (/[\s"'<>`\\]/.test(t) || /[\x00-\x1f\x7f]/.test(t)) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return t;
}

export function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Fast path: already a clean URL.
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  // Slow path: pull out the first http(s)://... run.
  const match = trimmed.match(/https?:\/\/\S+/i);
  return match ? match[0] : null;
}

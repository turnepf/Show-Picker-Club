// Amazon publishes the same title under several hosts, and on tvOS only one of
// them reaches the Prime Video app.
//
// Apple's app-association file for watch.amazon.com hands the whole host to
// Prime Video (`"appID":"J7P34ALZ5R.com.amazon.aiv.AIVApp", "paths":["*"]`).
// www.amazon.com does not: it maps a long list of paths to Amazon's *other*
// apps — music, Whole Foods, Business — and Prime Video does not claim
// /gp/video/detail/* there at all. So a stored www.amazon.com link opens
// nothing on an Apple TV, falls through to the aiv:// scheme, and dumps the
// member on the Prime Video home screen. Confirmed on an Apple TV 4K
// 2026-09-10: watch.amazon.com landed on the show, the other three shapes the
// club stores did not.
//
// The repair is available because the two hosts carry the SAME id. Watchmode
// returns both forms for one title:
//
//   https://watch.amazon.com/detail?gti=amzn1.dv.gti.d4bc0a58-...
//   https://www.amazon.com/gp/video/detail/amzn1.dv.gti.d4bc0a58-...?autoplay=0
//
// so moving a gti onto the host that works is a rewrite, not a guess.
//
// What this deliberately does NOT do is invent an id. An ASIN (B08WJQ3XP5) is
// not a gti and Amazon rejects it in the gti parameter — tested directly, it
// resolves to nothing — so a row carrying only an ASIN is left exactly as it
// was. A wrong deep link is worse than a link that merely opens the app: the
// member lands on an error instead of somewhere they can search.

// Bounded to hex and dashes so it stops cleanly at a `?`, a `/`, or the end of
// the string, and so a primevideo.com id (0OB9NDUVQKFRSYRSCHT2A784TI) can't be
// mistaken for one.
const GTI = /amzn1\.dv\.gti\.[0-9a-fA-F][0-9a-fA-F-]{7,63}/;

const AMAZON_HOST = /(^|\.)(amazon\.com|primevideo\.com)$/i;

// Returns the URL that reaches the show on tvOS, or the original string
// unchanged when there is nothing safe to do with it. Never throws — callers
// pass whatever a member or a vendor gave them.
export function normalizeAmazonUrl(url) {
  if (typeof url !== 'string' || !url) return url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.toLowerCase();
  if (!AMAZON_HOST.test(host)) return url;
  if (host === 'watch.amazon.com') return url;

  const found = GTI.exec(url);
  if (!found) return url;

  return `https://watch.amazon.com/detail?gti=${found[0]}`;
}

// True when a URL already lands on the show — the same question the tvOS app
// asks before promising "Watch on" rather than "Open".
export function amazonUrlLandsOnShow(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === 'watch.amazon.com';
  } catch {
    return false;
  }
}

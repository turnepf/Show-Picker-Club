// HBO Max publishes every title twice: an info page on www.hbomax.com (or the
// older www.max.com) and the player on play.hbomax.com. Only the player opens
// the show — the info page dumps the member on HBO Max's home screen, which is
// why the URL-cleanup queue and the nightly Watchmode fill both treat
// www.hbomax.com / www.max.com as placeholders.
//
// The two hosts carry the SAME id. Checked 2026-10-11 against five titles the
// club stores on play.hbomax.com (Euphoria, The White Lotus, One Battle After
// Another…): www.hbomax.com/show/<id> and /movie/<id> name the same title. So
// moving the id onto the player host is a rewrite, not a guess — the same
// reasoning as amazon-urls.js. The info host has shipped three shapes:
//
//   https://www.hbomax.com/show/<id>?utm_source=universal_search
//   https://www.hbomax.com/shows/<slug>/<id>
//   https://www.max.com/movies/<slug>/<id>
//
// plus an optional locale prefix (/us/es/show/<id>). Anything else — a page
// with no id, a lookalike host — comes back unchanged.

const INFO_HOST = /^(www\.)?(hbomax|max)\.com$/i;
const INFO_PATH = /^\/(?:[a-z]{2}\/[a-z]{2}\/)?(show|shows|movie|movies)\/(?:[^/]+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

// Returns the play.hbomax.com URL for an info-page link, or the original
// string unchanged. Never throws.
export function normalizeHboMaxUrl(url) {
  if (typeof url !== 'string' || !url) return url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!INFO_HOST.test(parsed.hostname)) return url;
  const m = INFO_PATH.exec(parsed.pathname);
  if (!m) return url;

  const kind = m[1].toLowerCase().startsWith('movie') ? 'movie' : 'show';
  return `https://play.hbomax.com/${kind}/${m[2].toLowerCase()}`;
}

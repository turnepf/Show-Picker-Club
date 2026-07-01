// Automatic bad-title recovery. A show whose stored name is made up (e.g.
// "Juul Documentary") can't be matched by TMDB/OMDB search — but when the row
// carries a real deep link, the streaming service's own title page is a public
// SEO page whose og:title holds the show's actual name ("Watch Big Vape: The
// Rise and Fall of Juul | Netflix Official Site"). Fetch that, strip the
// service dressing, and the real title falls out.

const SEARCHY = /\/search|\/s\?|\?q=|\?query=/i;

// The service-name dressing streamers append to page titles. Used to decide
// whether a trailing " - Xyz" / " — Xyz" segment is branding or part of the
// show's own name ("Big Vape - Part 2" must survive).
const SERVICE_TAG = /\b(netflix|hulu|prime video|amazon|freevee|apple tv|max|hbo|paramount|peacock|disney|starz|showtime|britbox|acorn|tubi|roku|youtube|official site|official trailer|watch online|full episodes|streaming|tv show|tv series)\b/i;

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// "Watch Big Vape: The Rise and Fall of Juul | Netflix Official Site"
//   → "Big Vape: The Rise and Fall of Juul"
export function cleanPageTitle(raw) {
  if (!raw) return null;
  let t = decodeEntities(String(raw)).replace(/\s+/g, ' ').trim();
  // Everything after the first pipe is always branding.
  t = t.split('|')[0].trim();
  t = t.replace(/^watch\s+/i, '');
  // Trailing dash-separated segments are dropped only when they read as
  // service branding, so hyphenated titles survive.
  const parts = t.split(/\s+[-–—]\s+/);
  while (parts.length > 1 && SERVICE_TAG.test(parts[parts.length - 1])) parts.pop();
  t = parts.join(' - ').trim();
  // Hulu-style glued suffixes: "The Bear Streaming Online" → "The Bear".
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/\s+(streaming online|watch online|full episodes( online)?|streaming|online|tv show|tv series)$/i, '').trim();
  }
  // A page that lost its show name entirely is useless — refuse rather than
  // rename a show to branding. Only exact branding strings are refused
  // (real titles like "Mad Max" contain service words and must survive).
  if (!t || /^(watch\s+)?(netflix|hulu|max|hbo max|prime video|apple tv\+?|paramount\+?|peacock|disney\+?|starz|showtime|britbox|tubi|youtube|streaming online|watch online|full episodes|streaming|online|tv shows?|tv series)(\s+official site)?$/i.test(t)
        || /official site/i.test(t)) return null;
  return t;
}

// Fetch a deep link's page and recover the show's real title, or null.
// Search-page placeholders carry no show identity, so they're refused up
// front. Never throws.
export async function titleFromUrl(url, fetcher = fetch) {
  if (!url || !/^https?:\/\//i.test(url) || SEARCHY.test(url)) return null;
  try {
    const res = await fetcher(url, {
      redirect: 'follow',
      headers: {
        // Some services serve a bare shell to unknown agents; a browser-ish
        // UA gets the SEO page with og:title populated.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct && !ct.includes('html')) return null;
    // og:title lives in <head>; 200 KB is plenty and bounds memory.
    const html = (await res.text()).slice(0, 200000);
    const og =
      html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    let raw = og && og[1];
    if (!raw) {
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      raw = m && m[1];
    }
    return cleanPageTitle(raw);
  } catch (_) {
    return null;
  }
}

// Rename every active copy of a title, member-safely: if a member already
// carries the show under its real name, their wrong-titled duplicate is
// archived instead of renamed (renaming would give them the same show twice).
// Returns the number of rows renamed.
export async function renameShowCopies(env, oldTitle, newTitle) {
  if (oldTitle.toLowerCase() !== newTitle.toLowerCase()) {
    await env.DB.prepare(
      `UPDATE shows SET archived = 1, enriched_at = datetime('now')
        WHERE LOWER(title) = LOWER(?) AND archived = 0
          AND member_slug IN (SELECT member_slug FROM shows
                               WHERE LOWER(title) = LOWER(?) AND archived = 0)`
    ).bind(oldTitle, newTitle).run();
  }
  const upd = await env.DB.prepare(
    `UPDATE shows SET title = ?, enriched_at = datetime('now')
      WHERE LOWER(title) = LOWER(?) AND archived = 0`
  ).bind(newTitle, oldTitle).run();
  return upd.meta.changes;
}

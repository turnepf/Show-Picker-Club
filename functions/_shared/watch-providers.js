import { canonicalNetwork } from './networks.js';

// Looks up a real streaming-service deep link for a (title, network) pair
// via Watchmode's API. Used both at insert time (so new shows land with
// real URLs without the member ever needing to paste one) and by the
// admin bulk-fill endpoint.
//
// Returns the web_url string on success, or null when:
//   - WATCHMODE_API_KEY isn't configured
//   - Watchmode can't find the title
//   - The title exists in Watchmode but the chosen network isn't a source
//   - Any network error
//
// Never throws — callers can use it inside ctx.waitUntil without wrapping.
// Each call burns ~2 Watchmode requests (free tier = 1000/month).

export async function lookupWatchmodeUrl(env, title, network, isMovie) {
  if (!env.WATCHMODE_API_KEY) return null;
  if (!title || !network) return null;
  const key = env.WATCHMODE_API_KEY;
  const types = isMovie ? 'movie' : 'tv_series,tv_miniseries';

  try {
    const searchRes = await fetch(
      `https://api.watchmode.com/v1/search/?apiKey=${key}` +
      `&search_field=name&search_value=${encodeURIComponent(title)}&types=${types}`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const titleId = searchData.title_results?.[0]?.id;
    if (!titleId) return null;

    const sourcesRes = await fetch(
      `https://api.watchmode.com/v1/title/${titleId}/sources/?apiKey=${key}&regions=US`
    );
    if (!sourcesRes.ok) return null;
    const sources = await sourcesRes.json();
    if (!Array.isArray(sources)) return null;

    const subs = sources.filter(s =>
      s.region === 'US' && (s.type === 'sub' || s.type === 'free')
    );
    const match = subs.find(s =>
      canonicalNetwork(s.name) === network && s.web_url
    );
    return match?.web_url || null;
  } catch {
    return null;
  }
}

import { ogPage, upscaleTmdb, APP_STORE_URL } from '../_shared/og-page.js';

// GET /show/:id — the link preview for a shared show.
//
// iOS already routes this URL into the app (Route.showLink in HomeView.swift);
// this exists only so the Messages/Slack/WhatsApp bubble says which show it is
// instead of a generic "Show Picker Club". See _shared/og-page.js.
//
// PUBLIC, no session. It therefore renders **catalog facts only** — the same
// slice `functions/api/shows/[id].js` hands a logged-out visitor via
// PUBLIC_SHOW_FIELDS. The column list below is spelled out rather than
// `SELECT *` on purpose: a preview page must never be able to grow a leak just
// because a personal column was added to the table. Nothing about whose list
// the show is on, who recommended it, who's watching it with whom, or any
// note ever appears here.
const CATALOG_COLUMNS =
  'title, overview, poster_url, backdrop_url, release_year, network, genres, movie';

// og:description is rendered as two or three lines; a full TMDB synopsis is cut
// off mid-word by the client. Trim at a word boundary and add an ellipsis.
function truncate(text, limit = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, '')}…`;
}

// Fallback when a show has no synopsis yet: say what we do know rather than
// leaving the bubble with a bare title.
function factsLine(show) {
  const kind = show.movie ? 'Movie' : 'TV series';
  const bits = [kind, show.release_year || null, show.network || null].filter(Boolean);
  return `${bits.join(' · ')} — tracked on Show Picker Club.`;
}

export async function onRequestGet(context) {
  const { env, params, request } = context;
  const url = new URL(request.url);
  const canonical = `https://showpicker.club/show/${encodeURIComponent(params.id)}`;

  const id = Number.parseInt(params.id, 10);
  const show = Number.isSafeInteger(id) && id > 0
    ? await env.DB.prepare(`SELECT ${CATALOG_COLUMNS} FROM shows WHERE id = ?`).bind(id).first()
    : null;

  // A link can outlive the row it points at (the show was removed, or the id
  // was never real). Show the app's own card rather than an error — the link
  // still opens the app for anyone who has it.
  if (!show) {
    return ogPage({
      title: 'Show Picker Club',
      description: 'Four simple lists for what you\'re watching, with artwork, ratings and premiere dates filled in automatically.',
      url: canonical,
      status: 404,
    });
  }

  // Backdrop before poster: a 16:9 still fills the width of a Messages bubble,
  // where a portrait poster is letterboxed into a narrow strip. Same order the
  // watch and phone detail screens use.
  const art = upscaleTmdb(show.backdrop_url) || upscaleTmdb(show.poster_url);

  return ogPage({
    // The line the recipient actually reads before tapping.
    title: `${show.title} on Show Picker Club`,
    heading: show.title,
    description: show.overview ? truncate(show.overview) : factsLine(show),
    image: art,
    url: canonical,
  });
}

import { getSession } from '../_shared/auth.js';
import { fetchEnrichmentById } from '../_shared/enrichment.js';

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

async function tryOMDB(title, apiKey) {
  try {
    const res = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`);
    const data = await res.json();
    if (data.Response === 'True') {
      return {
        canonicalTitle: data.Title,
        rating: data.imdbRating !== 'N/A' ? data.imdbRating : null,
        actors: data.Actors && data.Actors !== 'N/A' ? data.Actors.split(', ') : [],
      };
    }
  } catch (e) {}
  return null;
}

async function searchOMDB(title, apiKey) {
  try {
    const res = await fetch(`https://www.omdbapi.com/?s=${encodeURIComponent(title)}&apikey=${apiKey}`);
    const data = await res.json();
    if (data.Response === 'True' && data.Search && data.Search.length > 0) {
      const detailRes = await fetch(`https://www.omdbapi.com/?i=${data.Search[0].imdbID}&apikey=${apiKey}`);
      const detail = await detailRes.json();
      if (detail.Response === 'True') {
        return {
          canonicalTitle: detail.Title,
          rating: detail.imdbRating !== 'N/A' ? detail.imdbRating : null,
          actors: detail.Actors && detail.Actors !== 'N/A' ? detail.Actors.split(', ') : [],
        };
      }
    }
  } catch (e) {}
  return null;
}

async function fetchOMDB(title, env) {
  const apiKey = env.OMDB_API_KEY;
  if (!apiKey) return { canonicalTitle: null, rating: null, actors: [] };
  let result = await tryOMDB(title, apiKey);
  if (result) return result;
  result = await tryOMDB('The ' + title, apiKey);
  if (result) return result;
  if (title.toLowerCase().startsWith('the ')) {
    result = await tryOMDB(title.slice(4), apiKey);
    if (result) return result;
  }
  const collapsed = title.replace(/\s+/g, '');
  if (collapsed !== title) {
    result = await tryOMDB(collapsed, apiKey);
    if (result) return result;
  }
  result = await searchOMDB(title, apiKey);
  if (result) return result;
  return { canonicalTitle: null, rating: null, actors: [] };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { title, network, recommended_by, notes, movie, full_series, member } = body;

  if (!title || !member) {
    return new Response(JSON.stringify({ error: 'Title and member are required' }), { status: 400, headers: corsHeaders() });
  }

  // Check for existing show (including archived)
  const existing = await env.DB.prepare(
    'SELECT id, list, archived FROM shows WHERE LOWER(title) = LOWER(?) AND member_slug = ?'
  ).bind(title, member).first();

  if (existing) {
    if (existing.archived) {
      return new Response(JSON.stringify({ duplicate: true, archived: true }), { headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ duplicate: true, archived: false, list: existing.list }), { headers: corsHeaders() });
  }

  // Exact pick from type-ahead search: enrich the chosen TMDB entry directly
  // (poster/cast/rating included) instead of guessing from the typed title.
  const tmdbId = parseInt(body.tmdb_id, 10);
  const tmdbType = body.tmdb_type === 'movie' || body.tmdb_type === 'tv' ? body.tmdb_type : null;
  let omdb = null;
  if (Number.isInteger(tmdbId) && tmdbType) {
    const byId = await fetchEnrichmentById(tmdbId, tmdbType, env);
    if (byId.canonicalTitle) omdb = byId;
  }
  if (!omdb) omdb = await fetchOMDB(title, env);
  const finalTitle = omdb.canonicalTitle || title;

  // Check again with canonical title
  if (finalTitle.toLowerCase() !== title.toLowerCase()) {
    const dupeCheck = await env.DB.prepare(
      'SELECT id, list, archived FROM shows WHERE LOWER(title) = LOWER(?) AND member_slug = ?'
    ).bind(finalTitle, member).first();
    if (dupeCheck) {
      if (dupeCheck.archived) {
        return new Response(JSON.stringify({ duplicate: true, archived: true }), { headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ duplicate: true, archived: false, list: dupeCheck.list }), { headers: corsHeaders() });
    }
  }

  const suggestionNote = notes ? `Suggested · ${notes}` : 'Suggested';

  const result = await env.DB.prepare(
    'INSERT INTO shows (title, network, recommended_by, rating, list, notes, movie, full_series, poster_url, network_logo_url, member_slug, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(finalTitle, network || null, recommended_by || null, omdb.rating, 'next', suggestionNote, movie || 0, full_series || 0, omdb.posterUrl || null, omdb.networkLogoUrl || null, member, recommended_by || 'Anonymous').run();

  const showId = result.meta.last_row_id;
  if (omdb.actors.length > 0) {
    // OMDB path yields plain name strings; the exact-pick path yields
    // {name, imdb_id} objects. Normalise so both insert cleanly.
    const stmt = env.DB.prepare('INSERT INTO actors (show_id, name, imdb_id) VALUES (?, ?, ?)');
    await env.DB.batch(omdb.actors.map(actor => typeof actor === 'string'
      ? stmt.bind(showId, actor, null)
      : stmt.bind(showId, actor.name, actor.imdb_id || null)));
  }

  // Backfill network/URL from other members if missing
  if (!network) {
    const match = await env.DB.prepare(
      `SELECT network, network_url FROM shows
       WHERE LOWER(title) = LOWER(?) AND archived = 0
         AND id != ?
         AND network IS NOT NULL
         AND network_url IS NOT NULL
         AND network_url NOT LIKE '%/search%'
         AND network_url NOT LIKE '%/s?%'
       LIMIT 1`
    ).bind(finalTitle, showId).first();
    if (match) {
      await env.DB.prepare(
        "UPDATE shows SET network = ?, network_url = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(match.network, match.network_url, showId).run();
    }
  }

  return new Response(JSON.stringify({ success: true }), { status: 201, headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

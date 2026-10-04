import { getSession } from '../../_shared/auth.js';
import { sameShowWhere } from '../../_shared/same-show.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  // Reveals whether a title is on a member's list — members only.
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const url = new URL(request.url);
  const title = url.searchParams.get('title');
  const member = url.searchParams.get('member');

  if (!title || !member) {
    return new Response(JSON.stringify({ exists: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // A client that knows which TMDB entry it means sends tmdb_id (and
  // tmdb_type or movie), so a different show sharing the title isn't
  // reported as this one. Without them this answers by title, as before.
  const movieParam = url.searchParams.get('movie');
  const match = sameShowWhere('s', {
    title,
    tmdb_id: url.searchParams.get('tmdb_id'),
    tmdb_type: url.searchParams.get('tmdb_type'),
    movie: movieParam === null ? null : movieParam === '1' || movieParam === 'true',
  });
  const show = await env.DB.prepare(
    `SELECT id, list, archived FROM shows_v s WHERE ${match.sql} AND member_slug = ?`
  ).bind(...match.binds, member).first();

  if (!show) {
    return new Response(JSON.stringify({ exists: false }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    exists: true,
    id: show.id,
    list: show.list,
    archived: !!show.archived,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

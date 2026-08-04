function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://showpicker.club',
    'Content-Type': 'application/json',
  };
}

export async function onRequestGet(context) {
  const { env, params } = context;
  // Billing order (migration 060): TMDB returns cast top-billed first and we
  // store that as `ord`, so the principals lead. Rows written before the
  // column have NULL ord and fall back to insertion order, which was the
  // same thing.
  const { results } = await env.DB.prepare(
    'SELECT name, imdb_id FROM actors WHERE show_id = ? ORDER BY COALESCE(ord, 9999), id'
  ).bind(params.id).all().catch(() => env.DB.prepare(
    'SELECT name, imdb_id FROM actors WHERE show_id = ?'
  ).bind(params.id).all());
  return new Response(JSON.stringify({ actors: results }), { headers: corsHeaders() });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

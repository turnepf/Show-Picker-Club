function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://showpicker.club',
    'Content-Type': 'application/json',
  };
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const { results } = await env.DB.prepare(
    'SELECT name, imdb_id FROM actors WHERE show_id = ?'
  ).bind(params.id).all();
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

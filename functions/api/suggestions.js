// Retired 2026-07: suggest-a-show pushed rows into OTHER members' lists.
// Usage data (18 suggestions ever, 1 in the trailing year, most never acted
// on) didn't justify keeping a cross-member write surface once self-enroll
// opened the club to strangers. The pull model remains: browse another
// member's list and add to your own via POST /api/shows.
//
// Kept as a 410 stub (not deleted) so shipped iOS/tvOS builds that still
// carry the button get a clear error instead of an HTML 404 page.
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost() {
  return new Response(
    JSON.stringify({ error: 'retired', message: 'Suggestions were retired. Add the show to your own list instead.' }),
    { status: 410, headers: corsHeaders() }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://showpicker.club',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

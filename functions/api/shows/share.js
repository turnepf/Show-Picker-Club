// Retired 2026-07: share-to-member copied a show into ANOTHER member's list.
// Nearly all use was the operator's own; retiring it removes a cross-member
// write surface before self-enrollment opens the club to strangers. The pull
// model remains: browse another member's list and add to your own.
//
// Kept as a 410 stub (not deleted) so shipped iOS/tvOS builds that still
// carry the button get a clear error instead of an HTML 404 page.
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
}

export async function onRequestPost() {
  return new Response(
    JSON.stringify({ error: 'retired', message: 'Sharing to another member was retired. They can add it from your list.' }),
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

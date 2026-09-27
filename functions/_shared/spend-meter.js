// Per-member daily ceilings on the upstream calls a request costs, counted in
// member_spend (migration 072).
//
// The row caps in /api/shows (50 adds a day) and /api/import/commit (300 rows
// a day) are product rules counted from `shows`, so they only ever saw the
// paths that insert a row. The spend happens per request, before any insert,
// and on paths that never insert at all: an edit re-enriches, a duplicate add
// enriched before it was refused, the suggest proxy and the type-ahead search
// write nothing, and the import's parse step calls Claude on every slice.
// Signup is open, so a session is an identity, not a budget. This meters the
// thing that costs money.
//
// Each limit is far above a human pace. A member adding 50 shows a day through
// the app spends ~100 lookups (a suggest and an add each); a normal pasted
// list is one parse call, and the 400k-character ceiling on a single paste is
// 34.
export const DAILY_LIMITS = {
  claude: 100,   // /api/import/parse slices
  lookups: 300,  // enrichment fan-outs: add, edit, suggest
  searches: 1000, // /api/title-search queries (type-ahead)
};

// Charges one unit of `kind` to the member's day and says whether the request
// may go ahead. Counted before the spend, so a refused request still counts —
// a script that keeps hammering stays refused. Fails OPEN on a ledger error:
// a broken meter must not stop members adding shows, and a database without
// migration 072 has no table to count in.
export async function chargeSpend(env, memberSlug, kind) {
  if (!memberSlug || !(kind in DAILY_LIMITS)) return true;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO member_spend (member_slug, day, ${kind}) VALUES (?, date('now'), 1)
       ON CONFLICT(member_slug, day) DO UPDATE SET ${kind} = ${kind} + 1
       RETURNING ${kind} AS used`
    ).bind(memberSlug).first();
    return !row || row.used <= DAILY_LIMITS[kind];
  } catch (_) {
    return true;
  }
}

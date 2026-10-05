// Writes a member's copy of a show. A copy has no title of its own: every
// show is a TMDB entry, named on its shared row (docs/INVARIANTS.md §29), so
// callers write the shared row (writeTitle) and the copy holds member fields
// and the pin. `shows.title` was dropped 2026-10-05.
export async function insertCopy(env, cols) {
  const keys = Object.keys(cols);
  return await env.DB.prepare(
    `INSERT INTO shows (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map((k) => cols[k])).run();
}

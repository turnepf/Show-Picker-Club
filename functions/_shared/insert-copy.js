// Writes a member's copy of a show. A copy has no title of its own: every
// show is a TMDB entry, named on its shared row (docs/INVARIANTS.md §29).
//
// Transitional: production's `shows.title` is NOT NULL until the operator
// script drops it (migrations/README.md). Until then an insert without it is
// refused, and is retried once carrying the show's name, which nothing reads.
// After the drop the first attempt succeeds and the retry never runs. Remove
// the retry once the column is gone.
export async function insertCopy(env, cols, name) {
  const keys = Object.keys(cols);
  const run = (k, v) => env.DB.prepare(
    `INSERT INTO shows (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`
  ).bind(...v).run();
  try {
    return await run(keys, keys.map((k) => cols[k]));
  } catch (e) {
    if (!/NOT NULL constraint failed: shows\.title/.test(String(e?.message || e))) throw e;
    return await run(['title', ...keys], [name || '', ...keys.map((k) => cols[k])]);
  }
}

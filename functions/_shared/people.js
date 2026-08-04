// Canonical people: what we already know about actors and creators, so the
// same human doesn't get re-resolved once per show.
//
// Two keys, because we learn about people two ways. TMDB gives us a person id
// with the cast, so `people` is keyed on that. Creators (and every legacy
// actor row) are just a name, so `people_by_name` carries the name→imdb_id
// pairs we've resolved. Reads check both; writes fill both.
//
// Everything here is best-effort: a failure to cache or fill must never take
// down enrichment or a show's detail screen.

// IMDB ids we already have for these TMDB person ids. Returns a Map keyed by
// person id; missing ids simply aren't in the map.
export async function knownByPersonIds(env, ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  if (!wanted.length) return new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT tmdb_person_id, imdb_id FROM people
        WHERE tmdb_person_id IN (${wanted.map(() => '?').join(',')})
          AND imdb_id IS NOT NULL`
    ).bind(...wanted).all();
    return new Map((results || []).map(r => [r.tmdb_person_id, r.imdb_id]));
  } catch (_) {
    return new Map();
  }
}

// Same, by lowercased name — for creators and any row we only know by name.
export async function knownByNames(env, names) {
  const wanted = [...new Set((names || []).filter(Boolean).map(n => n.toLowerCase()))];
  if (!wanted.length) return new Map();
  const placeholders = wanted.map(() => '?').join(',');
  const found = new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT name_lower, imdb_id FROM people
        WHERE name_lower IN (${placeholders}) AND imdb_id IS NOT NULL`
    ).bind(...wanted).all();
    for (const r of results || []) found.set(r.name_lower, r.imdb_id);
  } catch (_) { /* table not migrated yet */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT name_lower, imdb_id FROM people_by_name WHERE name_lower IN (${placeholders})`
    ).bind(...wanted).all();
    // people_by_name only fills gaps — a TMDB-id-backed row is the better
    // record when we have both.
    for (const r of results || []) if (!found.has(r.name_lower)) found.set(r.name_lower, r.imdb_id);
  } catch (_) { /* table not migrated yet */ }
  return found;
}

// Remember people we just resolved. `people` entries are {tmdbPersonId, name,
// imdbId}; entries without a person id land in people_by_name instead.
export async function rememberPeople(env, people) {
  const rows = (people || []).filter(p => p && p.name && p.imdbId);
  if (!rows.length) return;
  for (const p of rows) {
    const nameLower = p.name.toLowerCase();
    if (p.tmdbPersonId) {
      await env.DB.prepare(
        `INSERT INTO people (tmdb_person_id, name, name_lower, imdb_id, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tmdb_person_id) DO UPDATE SET
           name = excluded.name, name_lower = excluded.name_lower,
           imdb_id = COALESCE(excluded.imdb_id, people.imdb_id),
           updated_at = datetime('now')`
      ).bind(p.tmdbPersonId, p.name, nameLower, p.imdbId).run().catch(() => {});
    }
    await env.DB.prepare(
      `INSERT INTO people_by_name (name_lower, name, imdb_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(name_lower) DO UPDATE SET
         name = excluded.name, imdb_id = excluded.imdb_id, updated_at = datetime('now')`
    ).bind(nameLower, p.name, p.imdbId).run().catch(() => {});
  }
}

// Fill actor rows that have no imdb_id from people we already know, by name.
// Pure SQL — no TMDB requests — so it's cheap enough to run on every
// enrichment call. Returns how many rows it linked.
export async function fillActorIdsFromKnownPeople(env, limit = 500) {
  try {
    const res = await env.DB.prepare(
      `UPDATE actors SET imdb_id = (
         SELECT p.imdb_id FROM people p
          WHERE p.name_lower = LOWER(actors.name) AND p.imdb_id IS NOT NULL
          LIMIT 1)
        WHERE imdb_id IS NULL
          AND id IN (
            SELECT a.id FROM actors a
             WHERE a.imdb_id IS NULL
               AND (EXISTS (SELECT 1 FROM people p WHERE p.name_lower = LOWER(a.name) AND p.imdb_id IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM people_by_name n WHERE n.name_lower = LOWER(a.name)))
             LIMIT ?)`
    ).bind(limit).run();
    const viaPeople = res.meta?.changes || 0;
    // Second pass for names only people_by_name knows.
    const res2 = await env.DB.prepare(
      `UPDATE actors SET imdb_id = (
         SELECT n.imdb_id FROM people_by_name n WHERE n.name_lower = LOWER(actors.name) LIMIT 1)
        WHERE imdb_id IS NULL
          AND EXISTS (SELECT 1 FROM people_by_name n WHERE n.name_lower = LOWER(actors.name))`
    ).run();
    return viaPeople + (res2.meta?.changes || 0);
  } catch (_) {
    return 0;
  }
}

// The creators for a show, as {name, imdb_id} — shows store creators as one
// comma-joined string with a single id for the first credit, so a co-created
// show could never link more than one name. Capped at 4: past that it's a
// list, not a credit.
export async function creatorsForShow(env, show, cap = 4) {
  const raw = (show?.director || '').trim();
  if (!raw) return [];
  const names = raw.split(',').map(n => n.trim()).filter(Boolean).slice(0, cap);
  if (!names.length) return [];
  const known = await knownByNames(env, names);
  return names.map((name, i) => ({
    name,
    // The stored director_imdb_id belongs to the first credited person, which
    // is why it was only ever safe to use on a single-name credit.
    imdb_id: known.get(name.toLowerCase()) || (i === 0 ? (show.director_imdb_id || null) : null),
  }));
}

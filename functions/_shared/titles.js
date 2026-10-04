// One row per TMDB entry: the show itself, as opposed to a member's copy of
// it. Step 1 of normalizing the library (docs/ARCHITECTURE.md#titles).
//
// Today every member's row in `shows` carries its own copy of everything TMDB
// says about the show: overview, poster, genres, seasons, cast. 1,409 rows
// hold 570 shows, and the copies are kept in step by propagation code that
// has been the source of bug after bug. `titles` and `title_cast` hold that
// catalog data once per (tmdb_type, tmdb_id).
//
// In this step nothing reads these tables yet. They're kept in sync with
// `shows`, so the next step can switch reads over and compare:
//   - syncTitle() after any write that changes one show's catalog data
//     (add, edit, the enrichment passes), with TMDB's own name when the
//     caller has the detail payload in hand;
//   - rebuildTitles() for everything at once (the migration's backfill, and a
//     nightly pass that catches the rarer writers this step doesn't hook).
//
// Every field comes from the most recently enriched copy that has a value,
// so one stale or half-filled copy doesn't blank a field another copy has.

// The catalog columns, named as they are on `shows`. Member fields (list,
// order, notes, watching_with, recommended_by, archived, network, network_url,
// added_by) are deliberately absent: they belong to a person, not the show.
export const TITLE_FIELDS = [
  'overview', 'poster_url', 'backdrop_url', 'network_logo_url', 'tagline', 'genres',
  'director', 'director_imdb_id', 'content_rating', 'trailer_key', 'runtime', 'release_year',
  'rating', 'tmdb_rating', 'vote_count', 'seasons_released', 'episodes_released', 'full_series',
  'next_season_date', 'season_end_date', 'streaming_on', 'free_on', 'studio', 'original_language',
  'imdb_id', 'tmdb_status', 'watch_link',
];

// A copy's entry. tmdb_type can be missing on rows pinned before it was
// stored; the movie flag decides then.
const TYPE_OF = `COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;

// Most recently enriched first, then most recently edited, then newest row.
const FRESHEST = `COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC`;

function pick(field) {
  return `(SELECT s2.${field} FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.${field} IS NOT NULL AND TRIM(CAST(s2.${field} AS TEXT)) <> ''
            ORDER BY ${FRESHEST} LIMIT 1)`;
}

// INSERT … SELECT over a set of keys `k(tmdb_type, tmdb_id)`. `name` is
// TMDB's own name when the caller passes one, else the name already stored,
// else the freshest copy's title (all of which matched TMDB's names after the
// 2026-10-04 cleanup).
function upsertSql(keysSql) {
  const cols = ['tmdb_type', 'tmdb_id', 'name', ...TITLE_FIELDS];
  // A name TMDB gave us is kept until TMDB gives another: a rebuild, or a
  // sync from a writer without the detail payload, falls back to the copies'
  // titles only for an entry that has never had an official name.
  const keptName = `(SELECT t.name FROM titles t WHERE t.tmdb_type = k.tmdb_type AND t.tmdb_id = k.tmdb_id)`;
  const values = ['k.tmdb_type', 'k.tmdb_id', `COALESCE(k.name, ${keptName}, ${pick('title')})`, ...TITLE_FIELDS.map(pick)];
  return `WITH k AS (${keysSql})
    INSERT INTO titles (${cols.join(', ')}, synced_at)
    SELECT ${values.join(',\n      ')}, datetime('now') FROM k WHERE true
    ON CONFLICT (tmdb_type, tmdb_id) DO UPDATE SET
      ${['name', ...TITLE_FIELDS].map((c) => `${c} = excluded.${c}`).join(',\n      ')},
      synced_at = excluded.synced_at`;
}

// The cast of the copy that has the most of it (freshest on a tie), since a
// title-scoped refresh can leave one copy with a shallower list than another.
function castSql(keysSql) {
  return `WITH k AS (${keysSql}),
    best AS (
      SELECT k.tmdb_type, k.tmdb_id,
        (SELECT s2.id FROM shows s2
          WHERE s2.tmdb_id = k.tmdb_id
            AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
          ORDER BY (SELECT COUNT(*) FROM actors a WHERE a.show_id = s2.id) DESC, ${FRESHEST}
          LIMIT 1) AS show_id
      FROM k)
    INSERT INTO title_cast (tmdb_type, tmdb_id, ord, name, imdb_id, tmdb_person_id, character_name)
    SELECT best.tmdb_type, best.tmdb_id, COALESCE(a.ord, a.id), a.name, a.imdb_id, a.tmdb_person_id, a.character_name
      FROM best JOIN actors a ON a.show_id = best.show_id
     WHERE true
    ON CONFLICT (tmdb_type, tmdb_id, ord) DO NOTHING`;
}

const ALL_KEYS = `SELECT DISTINCT ${TYPE_OF} AS tmdb_type, s.tmdb_id AS tmdb_id, NULL AS name
  FROM shows s WHERE s.tmdb_id IS NOT NULL`;

const ONE_KEY = `SELECT ? AS tmdb_type, ? AS tmdb_id, ? AS name
  WHERE EXISTS (SELECT 1 FROM shows s WHERE s.tmdb_id = ? AND ${TYPE_OF} = ?)`;

// Bring one entry's row up to date from its copies. Never throws: this is
// bookkeeping beside a write that has already succeeded, and nothing reads
// the table yet, so a failure must not fail the member's save. The nightly
// rebuild repairs anything missed.
export async function syncTitle(env, tmdbType, tmdbId, name = null) {
  const type = tmdbType === 'movie' ? 'movie' : tmdbType === 'tv' ? 'tv' : null;
  const id = Number(tmdbId);
  if (!type || !Number.isInteger(id) || id <= 0) return false;
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : null;
  const binds = [type, id, cleanName, id, type];
  try {
    await env.DB.prepare(upsertSql(ONE_KEY)).bind(...binds).run();
    await env.DB.prepare('DELETE FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ?').bind(type, id).run();
    await env.DB.prepare(castSql(ONE_KEY)).bind(...binds).run();
    return true;
  } catch (e) {
    return false;
  }
}

// Rebuild every entry, and drop entries no copy points at any more (a show
// re-pointed elsewhere, or deleted by its last member). Used by the migration
// backfill and the nightly pass.
export async function rebuildTitles(env) {
  await env.DB.prepare(upsertSql(ALL_KEYS)).run();
  await env.DB.prepare(`DELETE FROM titles WHERE NOT EXISTS (
      SELECT 1 FROM shows s WHERE s.tmdb_id = titles.tmdb_id AND ${TYPE_OF} = titles.tmdb_type)`).run();
  await env.DB.prepare('DELETE FROM title_cast').run();
  await env.DB.prepare(castSql(ALL_KEYS)).run();
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM titles) AS titles, (SELECT COUNT(*) FROM title_cast) AS cast_rows'
  ).first();
  return row || { titles: 0, cast_rows: 0 };
}

// The SQL a migration runs for the backfill. Same statements as
// rebuildTitles(), exported so scripts/titles-test.mjs can prove the migration
// file and the function agree.
export function rebuildSql() {
  return [upsertSql(ALL_KEYS), castSql(ALL_KEYS)];
}

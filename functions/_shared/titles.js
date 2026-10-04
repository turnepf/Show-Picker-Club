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

// Fields where '' is an answer rather than a gap: TMDB was asked and named
// no service, no free service, or no status. Treating it as missing left the
// shared row NULL, which reads as "never asked" and made the nightly passes
// re-fetch every such film forever.
const EMPTY_IS_AN_ANSWER = ['streaming_on', 'free_on', 'tmdb_status'];

function pick(field) {
  const present = EMPTY_IS_AN_ANSWER.includes(field)
    ? `s2.${field} IS NOT NULL`
    : `s2.${field} IS NOT NULL AND TRIM(CAST(s2.${field} AS TEXT)) <> ''`;
  return `(SELECT s2.${field} FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND ${present}
            ORDER BY ${FRESHEST} LIMIT 1)`;
}

// INSERT … SELECT over a set of keys `k(tmdb_type, tmdb_id)`. `name` is
// TMDB's own name when the caller passes one, else the name already stored,
// else the freshest copy's title (all of which matched TMDB's names after the
// 2026-10-04 cleanup).
// `fillOnly` (the default since step 3b): a field already on the shared row
// is kept, and the copies only fill what's missing. The shared row is written
// directly from TMDB by writeTitle(), so a member's copy, which only ever had
// the data some earlier pass gave it, must not overwrite fresher facts.
// Migration 076's backfill ran into an empty table, where the two modes are
// the same; rebuildSql() still returns that original form.
function upsertSql(keysSql, { fillOnly = true } = {}) {
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
      ${['name', ...TITLE_FIELDS].map((c) => (fillOnly ? `${c} = COALESCE(titles.${c}, excluded.${c})` : `${c} = excluded.${c}`)).join(',\n      ')},
      synced_at = excluded.synced_at`;
}

// The cast of the copy that has the most of it (freshest on a tie), since a
// title-scoped refresh can leave one copy with a shallower list than another.
function castSql(keysSql, { fillOnly = true } = {}) {
  const keys = fillOnly
    ? `SELECT * FROM (${keysSql}) kk WHERE NOT EXISTS (
         SELECT 1 FROM title_cast c WHERE c.tmdb_type = kk.tmdb_type AND c.tmdb_id = kk.tmdb_id)`
    : keysSql;
  return `WITH k AS (${keys}),
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

// Create one entry's row from its copies, or fill the fields (and cast) it
// is missing. For writers that have no TMDB payload in hand (imports, URL
// cleanup's no-match path); a writer that has one calls writeTitle(). Never
// throws: this is bookkeeping beside a write that has already succeeded, so a
// failure must not fail the member's save. The nightly rebuild repairs
// anything missed.
export async function syncTitle(env, tmdbType, tmdbId, name = null) {
  const type = tmdbType === 'movie' ? 'movie' : tmdbType === 'tv' ? 'tv' : null;
  const id = Number(tmdbId);
  if (!type || !Number.isInteger(id) || id <= 0) return false;
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : null;
  const binds = [type, id, cleanName, id, type];
  try {
    await env.DB.prepare(upsertSql(ONE_KEY)).bind(...binds).run();
    await env.DB.prepare(castSql(ONE_KEY)).bind(...binds).run();
    return true;
  } catch (e) {
    return false;
  }
}

// Create a row for every entry that lacks one, fill fields and cast that
// are missing, and drop entries no copy points at any more (a show
// re-pointed elsewhere, or deleted by its last member). The nightly pass.
// Never overwrites: fresh facts arrive through writeTitle().
export async function rebuildTitles(env) {
  await env.DB.prepare(upsertSql(ALL_KEYS)).run();
  await env.DB.prepare(`DELETE FROM titles WHERE NOT EXISTS (
      SELECT 1 FROM shows s WHERE s.tmdb_id = titles.tmdb_id AND ${TYPE_OF} = titles.tmdb_type)`).run();
  await env.DB.prepare(`DELETE FROM title_cast WHERE NOT EXISTS (
      SELECT 1 FROM titles t WHERE t.tmdb_type = title_cast.tmdb_type AND t.tmdb_id = title_cast.tmdb_id)`).run();
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
  return [upsertSql(ALL_KEYS, { fillOnly: false }), castSql(ALL_KEYS, { fillOnly: false })];
}

// ---- step 3b: writers write the shared row directly ----
//
// A writer holding a fresh TMDB payload (add, edit, the enrichment passes,
// URL cleanup's re-match) writes it here, so the shared row is TMDB's answer
// rather than whatever a member's copy happens to hold. A field the payload
// carries replaces the stored one; a field it lacks (null) leaves it. An
// empty string is a value: `streaming_on = ''` means TMDB was asked and
// named no service. A cast list replaces the stored cast when non-empty.
// Never throws, like syncTitle().
export async function writeTitle(env, tmdbType, tmdbId, { name = null, fields = {}, cast = null } = {}) {
  const type = tmdbType === 'movie' ? 'movie' : tmdbType === 'tv' ? 'tv' : null;
  const id = Number(tmdbId);
  if (!type || !Number.isInteger(id) || id <= 0) return false;
  const cols = TITLE_FIELDS.filter((f) => fields[f] !== undefined);
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : null;
  try {
    // A new row needs a name. Without TMDB's, start the row from the copies
    // (which gives it the freshest copy's title), then write the payload.
    if (!cleanName) {
      const have = await env.DB.prepare('SELECT 1 FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').bind(type, id).first();
      if (!have) {
        await syncTitle(env, type, id);
        const made = await env.DB.prepare('SELECT 1 FROM titles WHERE tmdb_type = ? AND tmdb_id = ?').bind(type, id).first();
        if (!made) return false;
      }
    }
    // '' stands in for "no name given" on the insert side and never wins the
    // update: an existing row always has one.
    await env.DB.prepare(
      `INSERT INTO titles (tmdb_type, tmdb_id, name${cols.map((c) => `, ${c}`).join('')}, synced_at)
       VALUES (?, ?, ?${cols.map(() => ', ?').join('')}, datetime('now'))
       ON CONFLICT (tmdb_type, tmdb_id) DO UPDATE SET
         name = COALESCE(NULLIF(excluded.name, ''), titles.name)${cols.map((c) => `, ${c} = COALESCE(excluded.${c}, titles.${c})`).join('')},
         synced_at = excluded.synced_at`
    ).bind(type, id, cleanName || '', ...cols.map((c) => fields[c] ?? null)).run();
    if (Array.isArray(cast) && cast.length) {
      await env.DB.prepare('DELETE FROM title_cast WHERE tmdb_type = ? AND tmdb_id = ?').bind(type, id).run();
      const ins = env.DB.prepare(
        'INSERT OR IGNORE INTO title_cast (tmdb_type, tmdb_id, ord, name, imdb_id, tmdb_person_id, character_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const [i, a] of cast.entries()) {
        if (!a || !a.name) continue;
        await ins.bind(type, id, a.ord ?? i, a.name, a.imdb_id ?? null, a.tmdb_person_id ?? null,
          a.character ?? a.character_name ?? null).run();
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// The shared-row fields in an enrichment payload (_shared/enrichment.js
// fetchEnrichment / fetchEnrichmentById shape). Fields the payload doesn't
// carry are left out, so writeTitle() keeps what's stored.
export function titleFieldsFromEnrichment(e) {
  if (!e) return {};
  const status = typeof e.tmdbStatus === 'string' ? e.tmdbStatus : null;
  const f = {
    overview: e.overview, poster_url: e.posterUrl, backdrop_url: e.backdropUrl, tagline: e.tagline,
    genres: e.genres, director: e.director, director_imdb_id: e.directorImdbId,
    content_rating: e.contentRating, trailer_key: e.trailerKey, runtime: e.runtime,
    release_year: e.releaseYear, rating: e.rating ?? e.tmdbRating, tmdb_rating: e.tmdbRating,
    vote_count: e.voteCount, seasons_released: e.seasonsReleased, episodes_released: e.episodesReleased,
    full_series: status ? (status === 'Ended' || status === 'Canceled' ? 1 : 0) : undefined,
    streaming_on: Array.isArray(e.flatrateNetworks) ? e.flatrateNetworks.join(', ') : undefined,
    free_on: Array.isArray(e.freeNetworks) ? e.freeNetworks.join(', ') : undefined,
    studio: e.studio, original_language: e.originalLanguage, imdb_id: e.imdbId,
    tmdb_status: status ?? undefined, watch_link: e.watchLink,
  };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

// ---- step 2: reads go through `shows_v` ----
//
// A view with exactly the columns of `shows`, in the same order, so a read
// that switches `FROM shows` to `FROM shows_v` returns the same shape. The
// title and the show's details come from `titles` when the entry has a row
// there, and fall back to the member's own copy when it doesn't (an
// unmatched row, or an entry the nightly rebuild hasn't reached yet).
//
// Three catalog-looking columns stay per copy, because they differ by member:
//   - next_season_date and season_end_date: enrichment only computes them for
//     a copy on Watching or Awaiting, and clears them elsewhere;
//   - network_logo_url: the badge follows the service the member chose, and
//     two members can hold one film under two services.
export const PER_COPY_FIELDS = ['next_season_date', 'season_end_date', 'network_logo_url'];
export const SHARED_FIELDS = TITLE_FIELDS.filter((f) => !PER_COPY_FIELDS.includes(f));

// The columns of `shows`, in table order. scripts/titles-test.mjs fails if
// schema.sql and this list disagree, so a column added to `shows` can't be
// left out of the view.
export const SHOWS_COLUMNS = [
  'id', 'title', 'network', 'network_url', 'recommended_by', 'rating', 'list', 'notes', 'movie',
  'full_series', 'watching_with', 'next_season_date', 'season_end_date', 'seasons_released',
  'poster_url', 'network_logo_url', 'title_ok', 'sort_order', 'archived', 'member_slug', 'created_at',
  'updated_at', 'added_by', 'enriched_at', 'genres', 'overview', 'backdrop_url', 'tmdb_rating',
  'content_rating', 'trailer_key', 'director', 'director_imdb_id', 'runtime', 'release_year',
  'watch_link', 'tmdb_id', 'tmdb_type', 'episodes_released', 'vote_count', 'tagline',
  'original_language', 'studio', 'streaming_on', 'imdb_id', 'tmdb_status', 'free_on',
];

export function viewSql() {
  const cols = SHOWS_COLUMNS.map((c) => {
    if (c === 'title') return 'COALESCE(t.name, s.title) AS title';
    if (SHARED_FIELDS.includes(c)) return `COALESCE(t.${c}, s.${c}) AS ${c}`;
    return `s.${c} AS ${c}`;
  });
  return `CREATE VIEW shows_v AS
  SELECT ${cols.join(',\n    ')}
    FROM shows s
    LEFT JOIN titles t
      ON t.tmdb_id = s.tmdb_id
     AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;
}

// Bring every entry carrying a given title up to date, for a writer that
// changes copies by title rather than by one row (URL cleanup's rename and
// re-match). Never throws, like syncTitle().
export async function syncTitlesNamed(env, title, name = null) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT tmdb_id, COALESCE(tmdb_type, CASE WHEN movie = 1 THEN 'movie' ELSE 'tv' END) AS tmdb_type
         FROM shows WHERE LOWER(title) = LOWER(?) AND tmdb_id IS NOT NULL`
    ).bind(title).all();
    for (const r of results || []) await syncTitle(env, r.tmdb_type, r.tmdb_id, name);
  } catch (e) { /* bookkeeping only */ }
}

// ---- step 3a: cast reads go through `actors_v` ----
//
// The columns of `actors`, one row per (member copy, credit): the shared cast
// from `title_cast` for a copy whose entry has one, and the copy's own rows
// otherwise. `id` carries the billing order for shared rows, which is all a
// reader uses it for (ordering within one show).
export const ACTORS_COLUMNS = ['id', 'show_id', 'name', 'imdb_id', 'ord', 'tmdb_person_id', 'character_name'];

const COPY_ENTRY = `tc.tmdb_id = s.tmdb_id
       AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;

export function actorsViewSql() {
  return `CREATE VIEW actors_v AS
  SELECT tc.ord AS id, s.id AS show_id, tc.name AS name, tc.imdb_id AS imdb_id, tc.ord AS ord,
         tc.tmdb_person_id AS tmdb_person_id, tc.character_name AS character_name
    FROM shows s JOIN title_cast tc ON ${COPY_ENTRY}
  UNION ALL
  SELECT a.id, a.show_id, a.name, a.imdb_id, a.ord, a.tmdb_person_id, a.character_name
    FROM actors a
   WHERE NOT EXISTS (SELECT 1 FROM shows s JOIN title_cast tc ON ${COPY_ENTRY} WHERE s.id = a.show_id)`;
}

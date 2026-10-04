// One row per TMDB entry: the show itself, as opposed to a member's copy of
// it (docs/ARCHITECTURE.md#titles, docs/INVARIANTS.md §29).
//
// `titles` holds everything TMDB says about a show once, with TMDB's own
// name, and `title_cast` its cast. A member's row in `shows` holds only what
// is theirs: list, order, rating, notes, watching-with, recommended-by,
// archived, their service and Watch link, and four fields that differ by
// member (PER_COPY_FIELDS). Members read the two together through the views
// `shows_v` and `actors_v`, which keep the response shape the apps have
// always had.
//
// How it got here, in steps: the shared tables (076), reads through the
// views (077, 078), writers writing TMDB's payload here directly, gaps read
// from here, and finally the duplicate columns dropped from `shows` (080).
//
//   - writeTitle(): a writer holding a TMDB payload (add, edit, enrichment,
//     URL cleanup) writes it here. The only way show facts arrive.
//   - syncTitle() / syncTitlesNamed() / rebuildTitles(): make sure every
//     entry a copy points at has a row (named from the copies until TMDB
//     names it), and drop entries nothing points at.

// The columns on `titles`.
export const TITLE_FIELDS = [
  'overview', 'poster_url', 'backdrop_url', 'network_logo_url', 'tagline', 'genres',
  'director', 'director_imdb_id', 'content_rating', 'trailer_key', 'runtime', 'release_year',
  'rating', 'tmdb_rating', 'vote_count', 'seasons_released', 'episodes_released', 'full_series',
  'next_season_date', 'season_end_date', 'streaming_on', 'free_on', 'studio', 'original_language',
  'imdb_id', 'tmdb_status', 'watch_link',
];

// Catalog-looking columns that stay on the member's row, because they differ
// by member:
//   - next_season_date, season_end_date: computed only for a copy on Watching
//     or Awaiting, cleared elsewhere;
//   - network_logo_url: the badge follows the service the member chose, and
//     two members can hold one film under two services;
//   - full_series: the "Series complete" toggle on iPhone/iPad is the
//     member's (enrichment also sets it from TMDB's status).
export const PER_COPY_FIELDS = ['next_season_date', 'season_end_date', 'network_logo_url', 'full_series'];

// What the view takes from the shared row, and what `shows` no longer has.
export const SHARED_FIELDS = TITLE_FIELDS.filter((f) => !PER_COPY_FIELDS.includes(f));

// The response shape: every column `shows` had before normalizing, in order.
// shows_v returns exactly these. scripts/titles-test.mjs pins it.
export const SHOWS_COLUMNS = [
  'id', 'title', 'network', 'network_url', 'recommended_by', 'rating', 'list', 'notes', 'movie',
  'full_series', 'watching_with', 'next_season_date', 'season_end_date', 'seasons_released',
  'poster_url', 'network_logo_url', 'title_ok', 'sort_order', 'archived', 'member_slug', 'created_at',
  'updated_at', 'added_by', 'enriched_at', 'genres', 'overview', 'backdrop_url', 'tmdb_rating',
  'content_rating', 'trailer_key', 'director', 'director_imdb_id', 'runtime', 'release_year',
  'watch_link', 'tmdb_id', 'tmdb_type', 'episodes_released', 'vote_count', 'tagline',
  'original_language', 'studio', 'streaming_on', 'imdb_id', 'tmdb_status', 'free_on',
];

// The columns `shows` itself has since migration 080.
export const SHOWS_TABLE_COLUMNS = SHOWS_COLUMNS.filter((c) => !SHARED_FIELDS.includes(c));

// A copy's entry. tmdb_type can be missing on rows pinned before it was
// stored; the movie flag decides then.
const TYPE_OF = `COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;

// The freshest copy's title, for an entry TMDB hasn't named yet.
const COPY_NAME = `(SELECT s2.title FROM shows s2
    WHERE s2.tmdb_id = k.tmdb_id
      AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
    ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1)`;

function ensureSql(keysSql) {
  return `WITH k AS (${keysSql})
    INSERT INTO titles (tmdb_type, tmdb_id, name, synced_at)
    SELECT k.tmdb_type, k.tmdb_id, COALESCE(k.name, ${COPY_NAME}), datetime('now') FROM k WHERE true
    ON CONFLICT (tmdb_type, tmdb_id) DO NOTHING`;
}

const ALL_KEYS = `SELECT DISTINCT ${TYPE_OF} AS tmdb_type, s.tmdb_id AS tmdb_id, NULL AS name
  FROM shows s WHERE s.tmdb_id IS NOT NULL`;

const ONE_KEY = `SELECT ? AS tmdb_type, ? AS tmdb_id, ? AS name
  WHERE EXISTS (SELECT 1 FROM shows s WHERE s.tmdb_id = ? AND ${TYPE_OF} = ?)`;

// Make sure one entry a copy points at has a row. Never throws: this is
// bookkeeping beside a write that has already succeeded. Facts arrive
// through writeTitle(), and a row with none is a gap the nightly passes fill.
export async function syncTitle(env, tmdbType, tmdbId, name = null) {
  const type = tmdbType === 'movie' ? 'movie' : tmdbType === 'tv' ? 'tv' : null;
  const id = Number(tmdbId);
  if (!type || !Number.isInteger(id) || id <= 0) return false;
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : null;
  try {
    await env.DB.prepare(ensureSql(ONE_KEY)).bind(type, id, cleanName, id, type).run();
    return true;
  } catch (e) {
    return false;
  }
}

// Every entry a copy points at gets a row; entries nothing points at any more
// (re-pointed elsewhere, or deleted by their last member) go, with their cast.
// The nightly pass.
export async function rebuildTitles(env) {
  await env.DB.prepare(ensureSql(ALL_KEYS)).run();
  await env.DB.prepare(`DELETE FROM titles WHERE NOT EXISTS (
      SELECT 1 FROM shows s WHERE s.tmdb_id = titles.tmdb_id AND ${TYPE_OF} = titles.tmdb_type)`).run();
  await env.DB.prepare(`DELETE FROM title_cast WHERE NOT EXISTS (
      SELECT 1 FROM titles t WHERE t.tmdb_type = title_cast.tmdb_type AND t.tmdb_id = title_cast.tmdb_id)`).run();
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM titles) AS titles, (SELECT COUNT(*) FROM title_cast) AS cast_rows'
  ).first();
  return row || { titles: 0, cast_rows: 0 };
}

// ---- writers write TMDB's payload here ----
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
    // A new row needs a name. Without TMDB's, start the row from the copies'
    // title, then write the payload.
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

// Make sure every entry carrying a given title has a row, for a writer that
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

// ---- the views members read through ----
//
// shows_v has exactly SHOWS_COLUMNS, so a read that selects FROM shows_v gets
// the shape the apps have always had. The title is TMDB's name (the copy's
// own for an entry TMDB hasn't named, or a copy no entry backs), the shared
// fields come from `titles`, and everything else from the member's row.
export function viewSql() {
  const cols = SHOWS_COLUMNS.map((c) => {
    if (c === 'title') return 'COALESCE(t.name, s.title) AS title';
    if (SHARED_FIELDS.includes(c)) return `t.${c} AS ${c}`;
    return `s.${c} AS ${c}`;
  });
  return `CREATE VIEW shows_v AS
  SELECT ${cols.join(',\n    ')}
    FROM shows s
    LEFT JOIN titles t
      ON t.tmdb_id = s.tmdb_id
     AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;
}

// actors_v keeps the columns of the retired `actors` table: one row per
// (member copy, credit), from the copy's entry's shared cast. `id` carries the
// billing order, which is all a reader uses it for.
export const ACTORS_COLUMNS = ['id', 'show_id', 'name', 'imdb_id', 'ord', 'tmdb_person_id', 'character_name'];

export function actorsViewSql() {
  return `CREATE VIEW actors_v AS
  SELECT tc.ord AS id, s.id AS show_id, tc.name AS name, tc.imdb_id AS imdb_id, tc.ord AS ord,
         tc.tmdb_person_id AS tmdb_person_id, tc.character_name AS character_name
    FROM shows s
    JOIN title_cast tc
      ON tc.tmdb_id = s.tmdb_id
     AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)`;
}

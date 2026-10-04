// Test fixtures only. Many suites describe a show by writing its facts on a
// member's copy (`INSERT INTO shows (..., poster_url, genres, ...)`), the way
// the library stored them before normalizing (docs/ARCHITECTURE.md#titles).
// Production now keeps those facts once per TMDB entry in `titles` and the
// cast in `title_cast`, and members read them through shows_v / actors_v.
// liftCopiesIntoTitles() moves a fixture's copy-borne facts into the shared
// tables, the way migration 076 backfilled production: each field from the
// freshest copy that has it ('' counts for streaming_on, free_on and
// tmdb_status), the cast from the copy with the most, fill-only.
//
// `db` is the node:sqlite DatabaseSync behind the suite's D1 shim.
import { SHARED_FIELDS } from '../../functions/_shared/titles.js';

const TYPE = (a) => `COALESCE(${a}.tmdb_type, CASE WHEN ${a}.movie = 1 THEN 'movie' ELSE 'tv' END)`;
const EMPTY_IS_AN_ANSWER = ['streaming_on', 'free_on', 'tmdb_status'];

//
// `pinUnmatched`: production has no unmatched rows, and an unmatched copy now
// shows no facts at all (it's a gap the nightly passes look up). Suites whose
// fixtures never cared about TMDB ids pass this to give each unpinned title a
// stand-in pin, one per title, so its facts land somewhere a member can read.
// `pinRow` does the same for one row only, for a suite that also needs a
// deliberately unmatched row to stay unmatched.
export function liftCopiesIntoTitles(db, { pinUnmatched = false, pinRow = null } = {}) {
  if (pinUnmatched || pinRow) {
    db.prepare(`UPDATE shows SET
        tmdb_id = 9000000 + (SELECT MIN(s2.id) FROM shows s2 WHERE LOWER(s2.title) = LOWER(shows.title)),
        tmdb_type = CASE WHEN movie = 1 THEN 'movie' ELSE 'tv' END
      WHERE tmdb_id IS NULL AND (? IS NULL OR id = ?)`).run(pinRow, pinRow);
  }
  const cols = db.prepare("SELECT name FROM pragma_table_info('shows')").all().map((r) => r.name);
  const fields = SHARED_FIELDS.filter((f) => cols.includes(f));
  const pick = (f) => `(SELECT s2.${f} FROM shows s2
      WHERE s2.tmdb_id = k.tmdb_id AND ${TYPE('s2')} = k.tmdb_type
        AND s2.${f} IS NOT NULL${EMPTY_IS_AN_ANSWER.includes(f) ? '' : ` AND TRIM(CAST(s2.${f} AS TEXT)) <> ''`}
      ORDER BY COALESCE(s2.enriched_at, '') DESC, s2.id DESC LIMIT 1)`;
  db.exec(`WITH k AS (SELECT DISTINCT ${TYPE('s')} AS tmdb_type, s.tmdb_id FROM shows s WHERE s.tmdb_id IS NOT NULL)
    INSERT INTO titles (tmdb_type, tmdb_id, name${fields.map((f) => `, ${f}`).join('')}, synced_at)
    SELECT k.tmdb_type, k.tmdb_id,
      (SELECT s2.title FROM shows s2 WHERE s2.tmdb_id = k.tmdb_id AND ${TYPE('s2')} = k.tmdb_type
        ORDER BY COALESCE(s2.enriched_at, '') DESC, s2.id DESC LIMIT 1)
      ${fields.map((f) => `, ${pick(f)}`).join('')}, datetime('now')
    FROM k WHERE true
    ON CONFLICT (tmdb_type, tmdb_id) DO UPDATE SET
      ${fields.map((f) => `${f} = COALESCE(titles.${f}, excluded.${f})`).join(', ') || 'name = titles.name'}`);
  db.exec(`INSERT INTO title_cast (tmdb_type, tmdb_id, ord, name, imdb_id, tmdb_person_id, character_name)
    SELECT t.tmdb_type, t.tmdb_id, COALESCE(a.ord, a.id), a.name, a.imdb_id, a.tmdb_person_id, a.character_name
      FROM titles t
      JOIN actors a ON a.show_id = (
        SELECT s.id FROM shows s WHERE s.tmdb_id = t.tmdb_id AND ${TYPE('s')} = t.tmdb_type
         ORDER BY (SELECT COUNT(*) FROM actors a2 WHERE a2.show_id = s.id) DESC, s.id DESC LIMIT 1)
     WHERE NOT EXISTS (SELECT 1 FROM title_cast c WHERE c.tmdb_type = t.tmdb_type AND c.tmdb_id = t.tmdb_id)
    ON CONFLICT (tmdb_type, tmdb_id, ord) DO NOTHING`);
}

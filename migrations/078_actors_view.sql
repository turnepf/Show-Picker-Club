-- Step 3a of normalizing the library (docs/ARCHITECTURE.md#titles).
-- actors_v has the columns of `actors`, with each member copy's cast taken
-- from title_cast (migration 076) when its entry has one. Member-facing cast
-- reads use it; writes still go to `actors`. Generated from actorsViewSql()
-- in functions/_shared/titles.js; scripts/titles-test.mjs fails if the two
-- drift apart.
DROP VIEW IF EXISTS actors_v;
CREATE VIEW actors_v AS
  SELECT tc.ord AS id, s.id AS show_id, tc.name AS name, tc.imdb_id AS imdb_id, tc.ord AS ord,
         tc.tmdb_person_id AS tmdb_person_id, tc.character_name AS character_name
    FROM shows s JOIN title_cast tc ON tc.tmdb_id = s.tmdb_id
       AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END)
  UNION ALL
  SELECT a.id, a.show_id, a.name, a.imdb_id, a.ord, a.tmdb_person_id, a.character_name
    FROM actors a
   WHERE NOT EXISTS (SELECT 1 FROM shows s JOIN title_cast tc ON tc.tmdb_id = s.tmdb_id
       AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) WHERE s.id = a.show_id);

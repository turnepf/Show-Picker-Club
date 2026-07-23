-- Canonical TMDB identity per show row, so the same title across different
-- members' independent copies can be tied together (needed for member
-- ratings to pool across everyone's copy of a show, not just one member's
-- row). tmdb_type disambiguates movie vs. tv ids, which aren't unique
-- across each other on TMDB (movie #550 and tv #550 are different titles).
-- NULL until enrichment/backfill fills it in.

ALTER TABLE shows ADD COLUMN tmdb_id INTEGER;
ALTER TABLE shows ADD COLUMN tmdb_type TEXT;

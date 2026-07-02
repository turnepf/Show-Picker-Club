-- Operator "title is right" marker for the URL-cleanup bad-titles queue.
--
-- That queue flags any title whose enrichment never found a poster, treating
-- a missing poster as proof of a wrong title. But it also catches real,
-- correctly-spelled shows the poster databases simply don't carry (obscure
-- documentaries, brand-new specials), which then haunt the queue forever
-- with nothing to fix. title_ok = 1 records the operator's judgement that
-- the name and network are right as stored; the bad-titles queue skips any
-- title where a copy carries the marker.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/022_title_ok.sql

ALTER TABLE shows ADD COLUMN title_ok INTEGER DEFAULT 0;

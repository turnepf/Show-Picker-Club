-- Total number of seasons released so far, sourced from TMDB's
-- number_of_seasons on the TV detail. Surfaced next to the "Next up"
-- premiere date on the Watching/Waiting lists (and on the show detail),
-- on both web and iOS. NULL until the next enrichment pass fills it in.
ALTER TABLE shows ADD COLUMN seasons_released INTEGER;

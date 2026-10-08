-- free_on held paid services. TMDB's `free` and `ads` lists carry Apple TV
-- and Prime Video when a series puts an episode or two up free, and the ad
-- tiers of Peacock and Prime Video, which still need a subscription; every
-- name the network table knew was accepted, so Slow Horses read "Free on
-- Amazon Prime Video, Apple TV+". Enrichment now keeps only free services
-- (freeServiceName() in functions/_shared/enrichment.js). This rewrites the
-- stored values to the same allow-list (FREE_ON_NAMES there; the
-- enrich-imdb-status test checks the two match), so the fix doesn't wait for
-- each title's next refresh. A list left with nothing becomes '' ("asked,
-- none"), never NULL. Names keep a fixed order here; the next refresh puts
-- them back in TMDB's priority order.
UPDATE titles SET free_on = rtrim(
    CASE WHEN instr(', ' || free_on || ', ', ', Pluto TV, ') > 0 THEN 'Pluto TV, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', PBS, ') > 0 THEN 'PBS, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', YouTube, ') > 0 THEN 'YouTube, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', Tubi, ') > 0 THEN 'Tubi, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', The Roku Channel, ') > 0 THEN 'The Roku Channel, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', Plex, ') > 0 THEN 'Plex, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', Kanopy, ') > 0 THEN 'Kanopy, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', Hoopla, ') > 0 THEN 'Hoopla, ' ELSE '' END ||
    CASE WHEN instr(', ' || free_on || ', ', ', Crackle, ') > 0 THEN 'Crackle, ' ELSE '' END,
  ', ')
WHERE free_on IS NOT NULL AND free_on <> '';

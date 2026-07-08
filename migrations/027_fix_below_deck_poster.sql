-- Clear the wrong poster on the original "Below Deck" so it re-fetches.
--
-- TMDB sorts search results by popularity, not title match, so a search for
-- "Below Deck" returns the more-popular spin-off "Below Deck Mediterranean"
-- first. The poster-fill pass took results[0] blindly (functions/api/enrich.js),
-- so the original "Below Deck" ended up wearing the Mediterranean poster —
-- both rows showed the same artwork. The URL, rating, and everything else on
-- the row are correct; only the pulled poster was wrong.
--
-- tmdbSearchFirst now prefers an exact-title match over the most-popular
-- result, so re-enriching "Below Deck" lands the right poster. Null out the
-- poster and enriched_at on every copy of the original title (NOT the
-- Mediterranean rows, whose poster is correct) to send it to the front of the
-- oldest-first poster pass. syncArtworkAcrossCopies only shares artwork between
-- exact-title siblings, so nulling every "below deck" copy is safe — none can
-- pull the Mediterranean poster back in.
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/027_fix_below_deck_poster.sql
--
-- Idempotent enough: re-running clears a correct poster once more, and the next
-- enrich pass simply re-fetches the same (now correct) artwork.

UPDATE shows
SET poster_url = NULL,
    enriched_at = NULL
WHERE archived = 0
  AND LOWER(title) = 'below deck';

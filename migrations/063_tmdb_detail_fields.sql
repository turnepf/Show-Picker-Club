-- Five TMDB fields that were already arriving on the enrichment payload and
-- being discarded. append_to_response fetches details, credits, videos and
-- watch/providers in one request, so none of these costs an extra call.
--
-- episodes_released  Total episodes across all aired seasons. seasons_released
--                    alone is misleading — four seasons of Severance is 19
--                    episodes, four of Grey's Anatomy is 90 — and "how much am
--                    I signing up for" is the question a Next Up list exists to
--                    answer. Refreshed on every pass, like seasons_released.
-- vote_count         Sample size behind tmdb_rating. An 8.9 from 42,000 people
--                    and a 9.1 from 11 render identically today. Stored now,
--                    displayed nowhere yet — it exists so ratings can later be
--                    qualified or suppressed below a threshold without a
--                    re-enrichment pass.
-- tagline            The marketing one-liner. The only evocative text TMDB
--                    gives us; everything else is factual.
-- original_language  ISO code of the production language. Only informative
--                    when it isn't English, which is how it's displayed.
-- studio             First production company for a movie, first TMDB network
--                    for a series. Deliberately NOT named anything
--                    network-shaped: shows.network means the streaming
--                    service, and TMDB's "networks" means the originating
--                    broadcaster. Conflating those two is the same class of
--                    collision as Apple TV vs Apple TV+.
ALTER TABLE shows ADD COLUMN episodes_released INTEGER;
ALTER TABLE shows ADD COLUMN vote_count INTEGER;
ALTER TABLE shows ADD COLUMN tagline TEXT;
ALTER TABLE shows ADD COLUMN original_language TEXT;
ALTER TABLE shows ADD COLUMN studio TEXT;

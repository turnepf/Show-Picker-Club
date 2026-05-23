-- Rename canonical "Max" back to "HBO Max" so members see the more
-- recognized brand name in the dropdown and on their rows.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/003_rename_max_to_hbo_max.sql
--
-- Idempotent — second run is a no-op since no row will still be on 'Max'.

UPDATE shows SET network = 'HBO Max' WHERE network = 'Max';

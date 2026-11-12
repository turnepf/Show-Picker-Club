-- A daily ceiling on member-triggered /api/enrich passes (TMDB fan-out on the
-- operator's token; security audit run-2). The spend meter counts one column
-- per kind and fails open without one, so the cap needs its column. Additive;
-- existing rows start at 0.
ALTER TABLE member_spend ADD COLUMN enrich INTEGER NOT NULL DEFAULT 0;

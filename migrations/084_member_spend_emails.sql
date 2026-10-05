-- A daily ceiling on emails a member triggers to themselves: the note that
-- lists an import's unmatched titles (functions/api/import/commit.js). The
-- spend meter counts one column per kind and fails open without one, so the
-- cap needs its column. Additive; existing rows start at 0.
ALTER TABLE member_spend ADD COLUMN emails INTEGER NOT NULL DEFAULT 0;

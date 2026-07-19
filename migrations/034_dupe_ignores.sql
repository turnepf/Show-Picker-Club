-- Operator-dismissed duplicate-account matches (the "Ignore this match"
-- button on the /members Possible duplicates panel). Pairs are stored
-- sorted (slug_a <= slug_b) so either direction matches; a self-pair
-- (slug_a = slug_b) means "stop flagging this account as hidden-email-only".
--
-- NOTE: /api/admin-dupe-ignores also creates this table on demand with the
-- identical statement, so deploy order doesn't matter — this migration
-- exists for the schema record and fresh-instance setup.

CREATE TABLE IF NOT EXISTS dupe_ignores (
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (slug_a, slug_b)
);

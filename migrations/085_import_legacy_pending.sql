-- An older app's import in progress (functions/api/import/commit.js). iOS 1.6
-- and earlier post a long import in 100-row batches with no `final` marker, so
-- the server holds each batch's unmatched titles here and sends the member one
-- note when the import ends, rather than one per batch. A row lives seconds;
-- `stamp` is the last batch's, so a later batch supersedes the quiet-period
-- send of an earlier one. Additive.
CREATE TABLE IF NOT EXISTS import_pending (
  member_slug TEXT PRIMARY KEY,
  titles TEXT NOT NULL DEFAULT '[]',
  added INTEGER NOT NULL DEFAULT 0,
  stamp TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Migration 064: Watching With becomes people, not just text.
--
-- `shows.watching_with` has always been free text — "Whitt", "my sister",
-- "the group chat". It still is. What this table adds is the case where the
-- name typed in that field is a *member of the club* the owner shares a group
-- with: then the app can do something with it rather than just print it.
--
-- One row = "the owner of show_id has named member_slug as someone they're
-- watching it with". Links are written in pairs by
-- functions/_shared/watchers.js: tagging Whitt on your copy also puts the
-- title on Whitt's list and writes the mirror row pointing back at you. The
-- pair is what makes "watching with" symmetrical instead of a note one person
-- keeps about another.
--
-- Why the table rather than more columns on `shows`: a link has to survive a
-- member renaming themselves, and it has to be queryable in both directions
-- (whose rows name me / whom does this row name). A comma-joined string does
-- neither.
--
-- `watching_with` is NOT replaced. The server keeps it in sync as the
-- display string — linked members' names appended after whatever free text
-- the owner typed — so tvOS, watchOS and any already-installed build keep
-- rendering the field they always read, with no client change required.
--
-- This is the first cross-member write since suggest-a-show and
-- share-to-member were retired in 2026-07 (both still 410). The gate that
-- makes it a different proposition: you can only name someone you already
-- share a private group with. See docs/INVARIANTS.md.
CREATE TABLE IF NOT EXISTS show_watchers (
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  -- Who wrote the link. Always either the show's owner (they tagged someone)
  -- or the other member (the mirror row their tag created on this show).
  created_by TEXT REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (show_id, member_slug)
);

-- "Who does this show name" — the read on every list load and show detail.
CREATE INDEX IF NOT EXISTS idx_show_watchers_show ON show_watchers(show_id);
-- "Which rows name me" — the read that finds the mirror rows to clean up when
-- a link is dropped or a show is deleted.
CREATE INDEX IF NOT EXISTS idx_show_watchers_member ON show_watchers(member_slug);

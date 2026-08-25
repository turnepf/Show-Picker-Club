-- Migration 065: Recommend a show to a group.
--
-- JC's ask (via Jennifer, 8/23–8/25): a "Recommend to group" button on a show,
-- and the group's members get a pop-up — "JC has recommended Lanterns" — with
-- Dismiss or Add to Next Up. See docs/PRODUCT.md.
--
-- One row in `group_suggestions` = "suggested_by proposed this title to
-- group_id". The row belongs to the GROUP, not to any member's library —
-- that is the whole design. Nothing here writes to anyone's list: adding is
-- pull (the member's own tap copies the title onto their own Next Up via the
-- same ensureCopy path Watching With uses), and dismissing writes only a
-- per-member mark in `group_suggestion_responses`. So the retired 2026-07
-- suggest-a-show problem — anyone pushing a row onto anyone's list — cannot
-- recur: there is no cross-member write at all.
--
-- Identity is snapshotted (title, tmdb_id, movie, poster_url, network) from
-- the recommender's own copy at suggest time, with `show_id` kept as a
-- pointer to that copy for enrichment inheritance. The pointer nulls out if
-- they later delete their copy; the snapshot keeps the card renderable and
-- addable either way.
--
-- The note is GROUP-VISIBLE BY DESIGN — it is written to be read by the
-- group, unlike the owner-only memos (`notes`, `recommended_by`) on library
-- rows. See docs/INVARIANTS.md.
CREATE TABLE IF NOT EXISTS group_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  suggested_by TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  -- The recommender's own copy at suggest time; the source ensureCopy clones
  -- so one recommendation doesn't cost a TMDB call per group member.
  show_id INTEGER REFERENCES shows(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  tmdb_id INTEGER,
  movie INTEGER DEFAULT 0,
  poster_url TEXT,
  network TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row = "member_slug has answered this suggestion's pop-up": 'dismissed'
-- clears it from their view and nobody else's; 'added' records that their tap
-- put the title on their own Next Up (or found it already on a list). A later
-- answer replaces an earlier one — dismissing the pop-up and adding from the
-- board afterwards is fine.
CREATE TABLE IF NOT EXISTS group_suggestion_responses (
  suggestion_id INTEGER NOT NULL REFERENCES group_suggestions(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('dismissed', 'added')),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (suggestion_id, member_slug)
);

-- "This group's board" — the read on every group screen load.
CREATE INDEX IF NOT EXISTS idx_group_suggestions_group ON group_suggestions(group_id);
-- The per-member daily ceiling counts by who suggested.
CREATE INDEX IF NOT EXISTS idx_group_suggestions_by ON group_suggestions(suggested_by);
CREATE INDEX IF NOT EXISTS idx_group_suggestion_responses_member ON group_suggestion_responses(member_slug);

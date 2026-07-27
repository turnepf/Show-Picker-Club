-- Common member-list reads filter by owner + archive status and sort or
-- compare titles case-insensitively. These indexes avoid scanning the club's
-- full catalog as membership grows. Safe to apply to an existing database.

CREATE INDEX IF NOT EXISTS idx_shows_member_archived_title
  ON shows(member_slug, archived, title COLLATE NOCASE);

-- Used by duplicate detection and cross-member artwork/URL inheritance.
CREATE INDEX IF NOT EXISTS idx_shows_active_title
  ON shows(archived, title COLLATE NOCASE);

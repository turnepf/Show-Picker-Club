-- Tiny key/value store the vibe-fill cron uses to know whether a
-- background re-score is active. Set rescore_before to an ISO
-- timestamp to start; the cron picks up any title whose scored_at
-- predates that cursor and refreshes it. Server clears the key once
-- everything has caught up.

CREATE TABLE IF NOT EXISTS vibe_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

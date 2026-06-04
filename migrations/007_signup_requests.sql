-- Requests to join the club. Filed via the /join page (currently
-- unlinked — security by obscurity until we're ready to publicise).
-- Operator approves by running the existing create-member flow and
-- marks the row reviewed.

CREATE TABLE IF NOT EXISTS signup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  source TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status   ON signup_requests(status);
CREATE INDEX IF NOT EXISTS idx_signup_requests_created  ON signup_requests(created_at);

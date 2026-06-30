-- Platform usage tracking. Clients identify themselves with an
-- X-Client-Platform header on /auth/check; we stamp it onto the session row so
-- the reporting dashboard can break "active" down by platform: iOS, tvOS, and
-- web split into small- vs large-screen.
ALTER TABLE sessions ADD COLUMN platform TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);

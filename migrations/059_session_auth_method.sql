-- How each session was authenticated: 'apple' | 'google' | 'email' | 'sms' |
-- 'demo'. members.enrolled_via already records how an ACCOUNT was created, but
-- nothing recorded how someone actually gets back in — which is the number
-- that decides whether an auth channel (email codes, Twilio SMS) still earns
-- its keep. NULL for sessions minted before this column existed.
ALTER TABLE sessions ADD COLUMN auth_method TEXT;

-- Reporting counts sessions by method over a date window.
CREATE INDEX IF NOT EXISTS idx_sessions_auth_method ON sessions(auth_method, created_at);

-- The same value, kept durably on the member alongside last_login_at. Logout,
-- disable and account deletion all delete session rows, so sessions alone
-- under-report; this is what Manage members reads to say how each member
-- actually gets in.
ALTER TABLE members ADD COLUMN last_login_method TEXT;

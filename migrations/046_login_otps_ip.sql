-- Attribute login-code requests to a source. login_otps records that a code
-- was minted (member, channel, time) but not WHO asked for it, so unrequested
-- codes (someone submitting a member's email/phone to /auth/request-code)
-- couldn't be traced. Store the requester's IP + user agent on every insert so
-- a repeat can be pinned to a source and blocked at the Cloudflare edge.
ALTER TABLE login_otps ADD COLUMN ip TEXT;
ALTER TABLE login_otps ADD COLUMN user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_login_otps_ip_time ON login_otps(ip, created_at);

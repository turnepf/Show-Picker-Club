-- Remove the legacy 4-digit static login codes entirely. Login has moved fully
-- to one-time codes (phone via Twilio Verify, email via login_otps) plus Sign in
-- with Apple, none of which touch member_codes. Drop the table and its index so
-- the old codes are gone from the database and can never authenticate again.

DROP INDEX IF EXISTS idx_member_codes_code;
DROP TABLE IF EXISTS member_codes;

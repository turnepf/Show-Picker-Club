-- Is anyone actually subscribed to their calendar feed? Nothing recorded it:
-- /calendar/<slug>.ics validated the token, served the ICS, and forgot. A
-- subscribed calendar polls on its own schedule, so a last-fetch stamp
-- answers the question within a day of shipping.
ALTER TABLE members ADD COLUMN calendar_fetched_at TEXT;
ALTER TABLE members ADD COLUMN calendar_fetch_count INTEGER DEFAULT 0;

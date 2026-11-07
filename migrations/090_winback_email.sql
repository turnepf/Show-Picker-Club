-- The "we saved your spot" email to members who haven't visited in 60+ days
-- (functions/_shared/winback.js). email_opt_out is set by the unsubscribe
-- link and is honoured by every marketing email; login codes and other
-- emails a member asks for are not marketing and ignore it. winback_sent_at
-- records the last send, so a member gets it once per lapse: again only
-- after they come back and then go quiet for another 60 days.
ALTER TABLE members ADD COLUMN email_opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN winback_sent_at TEXT;

-- Give a group invite a lifecycle. Until now a token was minted, lived 7
-- days, and was never consumed, never counted and never cancellable: every
-- invite the club had issued in the preceding week was simultaneously live,
-- unlimited and uncancellable, and it kept working after the member who
-- issued it had left the group. The only way to kill a leaked link was to
-- delete the group.
--
-- The link stays shareable to several people, which is what the UI has always
-- promised ("share this link with people you want to invite") — it is now
-- bounded, countable and revocable instead of open-ended:
--
--   use_count / max_uses  how many redemptions this token has left. The
--                         claim is an atomic UPDATE guarded on
--                         `use_count < max_uses`, so concurrent redemptions
--                         cannot overshoot the ceiling.
--   revoked_at            set by the issuer or the group's creator to kill a
--                         link that got somewhere it shouldn't have, without
--                         taking the group down with it.
--
-- Existing rows get max_uses = 10 like new ones, and use_count = 0: their
-- past redemptions were never recorded and cannot be reconstructed, so they
-- start from a clean ceiling rather than a guessed one. They still expire on
-- the schedule they were minted with.
ALTER TABLE group_invites ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 10;
ALTER TABLE group_invites ADD COLUMN revoked_at TEXT;

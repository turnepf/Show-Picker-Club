-- Track which member was created when a request is approved, so the
-- /requests page can reconstruct the welcome URL + intro text any time
-- (not just in the seconds right after the operator clicked Approve).

ALTER TABLE signup_requests ADD COLUMN created_member_slug TEXT;

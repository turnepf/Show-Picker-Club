-- Processed (approved/rejected) signup requests can be dismissed from the
-- admin queue once the operator is done with them. Hidden rows stay in the
-- table as the audit trail; they just stop appearing in the admin UIs.
-- Pending rows can't be hidden — they still need a decision.
ALTER TABLE signup_requests ADD COLUMN hidden_at TEXT;

-- Per-member subscription decisions for the Subscription Audit page.
--
-- The audit itself (which services you have shows on, and the keep/pause/
-- cancel verdict for each) is DERIVED on the fly from the shows table, so no
-- data lives here for the common case. This table only stores the things that
-- can't be computed:
--   status            the member's real decision for a service
--                     (subscribed | paused | cancelled)
--   monthly_price_cents  what they actually pay; NULL falls back to the
--                     editable default in functions/_shared/networks.js
--   resubscribe_date  optional reminder date (ISO yyyy-mm-dd) — emitted into
--                     the member's calendar feed as a "Resubscribe" event
--   is_manual         1 for a service the member pays for but tracks no shows
--                     on (e.g. a sports package), so it still counts toward
--                     their monthly spend
--
-- network holds the canonical network name (see NETWORKS) for derived rows,
-- or free text for manual services. One row per (member, network).

CREATE TABLE IF NOT EXISTS member_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  network TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'subscribed',
  monthly_price_cents INTEGER,
  resubscribe_date TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (member_slug, network)
);

CREATE INDEX IF NOT EXISTS idx_member_subs_slug ON member_subscriptions(member_slug);

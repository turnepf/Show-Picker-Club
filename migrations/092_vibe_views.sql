-- Who opens Vibe, and how often. Nothing recorded a vibe read, so there was
-- no way to tell whether the feature (and its nightly Claude trait scoring)
-- earns its keep. One row per member per UTC day: `views` counts every
-- profile read, `others` the ones that were a group-mate's profile rather
-- than the member's own. Read on the admin reporting page. Additive.
CREATE TABLE IF NOT EXISTS vibe_views (
  member_slug TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  others INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_slug, day)
);

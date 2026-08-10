-- Complete schema for a new Show Picker Club D1 database.
--
-- Existing installations are upgraded through migrations/; do not apply those
-- historical ALTER TABLE files after loading this schema.

CREATE TABLE IF NOT EXISTS members (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_name TEXT,
  last_initial TEXT,
  last_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  calendar_token TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- How the account came to exist: 'email' | 'apple' | 'google'. NULL only
  -- for rows that predate self-enrollment (or a hand-seeded first member).
  enrolled_via TEXT,
  -- Origin IP of the enrollment, used for the per-IP signup cap. Deleted
  -- with the member.
  enroll_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT,
  -- How they last got in: 'apple' | 'google' | 'passkey' | 'email' | 'sms' |
  -- 'demo'. Durable for the same reason last_login_at is — session rows are
  -- deleted on logout, disable and deletion.
  last_login_method TEXT,
  -- Calendar feed usage (migration 061): a subscribed client polls on its own
  -- schedule, so these say whether the feed is actually in use.
  calendar_fetched_at TEXT,
  calendar_fetch_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (phone, member_slug)
);

CREATE TABLE IF NOT EXISTS member_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (email, member_slug)
);

CREATE TABLE IF NOT EXISTS member_apple_ids (
  apple_sub TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member_google_ids (
  google_sub TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member_passkeys (
  -- base64url credential id from the authenticator; globally unique, which is
  -- what lets sign-in resolve a member from the credential alone.
  credential_id TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  -- base64url COSE public key exactly as the authenticator produced it.
  public_key TEXT NOT NULL,
  -- Apple's platform authenticator always reports 0, so the clone check only
  -- applies when both the stored and incoming counters are non-zero.
  sign_count INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  label TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_member_passkeys_member ON member_passkeys(member_slug);

-- Single-use WebAuthn challenges, deleted as they're consumed and swept when
-- they expire. Near-empty in steady state.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,          -- 'register' | 'authenticate'
  member_slug TEXT,               -- set for registration only
  ip TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  member_slug TEXT REFERENCES members(slug),
  expires_at TEXT NOT NULL,
  created_at TEXT,
  last_seen_at TEXT,
  platform TEXT,
  -- How this session was authenticated: 'apple' | 'google' | 'passkey' |
  -- 'email' | 'sms' | 'demo'. members.enrolled_via covers account creation;
  -- this covers the ongoing cost of each channel.
  auth_method TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_auth_method ON sessions(auth_method, created_at);

CREATE TABLE IF NOT EXISTS login_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  code TEXT NOT NULL,
  channel TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS enroll_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  ip TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failed_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  member_slug TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  network TEXT,
  network_url TEXT,
  recommended_by TEXT,
  rating TEXT,
  list TEXT NOT NULL,
  notes TEXT,
  movie INTEGER DEFAULT 0,
  full_series INTEGER DEFAULT 0,
  watching_with TEXT,
  next_season_date TEXT,
  season_end_date TEXT,
  seasons_released INTEGER,
  poster_url TEXT,
  network_logo_url TEXT,
  title_ok INTEGER DEFAULT 0,
  sort_order INTEGER,
  archived INTEGER DEFAULT 0,
  member_slug TEXT REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  added_by TEXT,
  enriched_at TEXT,
  genres TEXT,
  overview TEXT,
  backdrop_url TEXT,
  tmdb_rating TEXT,
  content_rating TEXT,
  trailer_key TEXT,
  director TEXT,
  director_imdb_id TEXT,
  runtime INTEGER,
  release_year INTEGER,
  watch_link TEXT,
  tmdb_id INTEGER,
  tmdb_type TEXT,
  -- Migration 063. `studio` is the originating studio/broadcaster and is
  -- deliberately not called anything network-shaped — `network` above means
  -- the streaming service.
  episodes_released INTEGER,
  vote_count INTEGER,
  tagline TEXT,
  original_language TEXT,
  studio TEXT
);

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER REFERENCES shows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  imdb_id TEXT,
  -- TMDB billing order, 0 = top-billed. Cast is stored CAST_DEPTH deep and
  -- clients draw the first few, so this is what makes "the first few" mean
  -- the principals.
  ord INTEGER,
  tmdb_person_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_actors_show_ord ON actors(show_id, ord);

-- Canonical people (migration 060): one row per human rather than one per
-- (show, human), so an actor we've resolved on any show links on every show
-- and costs no TMDB request the next time. `people` is keyed on TMDB's person
-- id; `people_by_name` carries the name→imdb_id pairs we only know by name
-- (creators, legacy actor rows).
CREATE TABLE IF NOT EXISTS people (
  tmdb_person_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  imdb_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name_lower ON people(name_lower);

CREATE TABLE IF NOT EXISTS people_by_name (
  name_lower TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS show_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  tmdb_type TEXT NOT NULL,
  season_number INTEGER NOT NULL DEFAULT 0,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (tmdb_id, tmdb_type, season_number, member_slug)
);

CREATE TABLE IF NOT EXISTS show_traits (
  title_lower TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  warmth REAL, empathy REAL, emotional_repair REAL, moral_ambiguity REAL,
  darkness REAL, cynicism REAL, manipulation REAL, power_orientation REAL,
  chaos_intensity REAL, humor_warmth REAL, cruel_humor REAL,
  intellectual_curiosity REAL, growth_orientation REAL, violence_intensity REAL,
  comfort_coziness REAL, community_belonging REAL, satire REAL,
  prestige_energy REAL, emotional_volatility REAL, healing_redemption REAL,
  revenge_energy REAL, status_obsession REAL, optimism REAL, nihilism REAL,
  teamwork REAL, absurdism REAL,
  unknown_show INTEGER DEFAULT 0,
  generated_at TEXT DEFAULT (datetime('now')),
  scored_at TEXT
);

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

CREATE TABLE IF NOT EXISTS household_members (
  member_slug TEXT NOT NULL REFERENCES members(slug),
  other_slug TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (member_slug, other_slug)
);

CREATE TABLE IF NOT EXISTS household_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member_platforms (
  member_slug TEXT NOT NULL REFERENCES members(slug),
  platform TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (member_slug, platform)
);

CREATE TABLE IF NOT EXISTS demo_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vibe_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dupe_ignores (
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (slug_a, slug_b)
);

CREATE TABLE IF NOT EXISTS url_cleanup_ignores (
  ltitle TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tmdb_backfill_ignores (
  ltitle TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  creator_slug TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, member_slug)
);

CREATE TABLE IF NOT EXISTS group_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_enroll_ip ON members(enroll_ip, created_at);
CREATE INDEX IF NOT EXISTS idx_member_phones_phone ON member_phones(phone);
CREATE INDEX IF NOT EXISTS idx_member_phones_slug ON member_phones(member_slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_phones_primary ON member_phones(member_slug) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_member_emails_email ON member_emails(email);
CREATE INDEX IF NOT EXISTS idx_member_emails_slug ON member_emails(member_slug);
CREATE INDEX IF NOT EXISTS idx_member_apple_ids_slug ON member_apple_ids(member_slug);
CREATE INDEX IF NOT EXISTS idx_member_google_ids_slug ON member_google_ids(member_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_login_otps_lookup ON login_otps(member_slug, code, used_at);
CREATE INDEX IF NOT EXISTS idx_login_otps_expires ON login_otps(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_otps_ip_time ON login_otps(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_enroll_otps_lookup ON enroll_otps(email, code, used_at);
CREATE INDEX IF NOT EXISTS idx_enroll_otps_created ON enroll_otps(created_at);
CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_time ON failed_logins(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_shows_list ON shows(list);
CREATE INDEX IF NOT EXISTS idx_shows_archived ON shows(archived);
CREATE INDEX IF NOT EXISTS idx_shows_member ON shows(member_slug);
CREATE INDEX IF NOT EXISTS idx_shows_member_archived_title ON shows(member_slug, archived, title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_shows_active_title ON shows(archived, title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_actors_show_id ON actors(show_id);
CREATE INDEX IF NOT EXISTS idx_show_ratings_title ON show_ratings(tmdb_id, tmdb_type);
CREATE INDEX IF NOT EXISTS idx_member_subs_slug ON member_subscriptions(member_slug);
CREATE INDEX IF NOT EXISTS idx_household_member ON household_members(member_slug);
CREATE INDEX IF NOT EXISTS idx_household_invites_code ON household_invites(code);
CREATE INDEX IF NOT EXISTS idx_household_invites_inviter ON household_invites(inviter_slug);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_slug);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_slug);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_token ON group_invites(token);
CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at);

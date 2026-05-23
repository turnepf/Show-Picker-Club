CREATE TABLE IF NOT EXISTS members (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_member_phones_phone ON member_phones(phone);
CREATE INDEX IF NOT EXISTS idx_member_phones_slug ON member_phones(member_slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_phones_primary
  ON member_phones(member_slug) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS member_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_slug TEXT REFERENCES members(slug),
  code TEXT NOT NULL,
  editor_name TEXT NOT NULL
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
  archived INTEGER DEFAULT 0,
  member_slug TEXT REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER REFERENCES shows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  imdb_id TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  member_slug TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT,
  last_seen_at TEXT
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
  generated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failed_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  member_slug TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shows_list ON shows(list);
CREATE INDEX IF NOT EXISTS idx_shows_archived ON shows(archived);
CREATE INDEX IF NOT EXISTS idx_shows_member ON shows(member_slug);
CREATE INDEX IF NOT EXISTS idx_actors_show_id ON actors(show_id);
CREATE INDEX IF NOT EXISTS idx_member_codes_code ON member_codes(code);
CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_time ON failed_logins(ip, created_at);

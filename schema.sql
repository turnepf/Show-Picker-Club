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
  studio TEXT,
  -- TMDB's current US flatrate services, comma-separated canonical names.
  -- Sits BESIDE `network` rather than replacing it: `network` is the member's
  -- record and is written fill-only, so it goes stale as licensing moves.
  -- Pure derived data, refreshed authoritatively by enrichment. See
  -- migrations/069_streaming_on.sql.
  streaming_on TEXT,
  -- Migration 073. The title's IMDb id (tt…); TMDB's status string verbatim
  -- ('' when TMDB sent none, so NULL means "not stored yet"); and free /
  -- free-with-ads services, encoded like streaming_on.
  imdb_id TEXT,
  tmdb_status TEXT,
  free_on TEXT
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
  tmdb_person_id INTEGER,
  -- The role played ("Mark S."), migration 073.
  character_name TEXT
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

-- Migration 064. One row = "the owner of show_id has named member_slug as
-- someone they're watching it with". Written in mirrored pairs by
-- functions/_shared/watchers.js — tagging a group-mate also puts the title on
-- their list and writes the row pointing back at you. `shows.watching_with`
-- stays the display string (free text plus the linked names appended), so
-- clients that only read that field are unaffected.
--
-- Only members you share a private group with can be named. That gate is what
-- separates this from the cross-member writes retired in 2026-07.
CREATE TABLE IF NOT EXISTS show_watchers (
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  created_by TEXT REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (show_id, member_slug)
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
  created_at TEXT DEFAULT (datetime('now')),
  -- SF Symbol name and named accent color (migration 066). Both nullable;
  -- the API validates against its curated sets.
  icon TEXT,
  color TEXT,
  -- Migration 068: any group member may set name/icon/color, not just the
  -- creator, so the last edit is tracked here to tell everyone else once —
  -- see group_members.last_seen_change_at.
  profile_changed_by TEXT REFERENCES members(slug),
  profile_changed_at TEXT,
  profile_changed_fields TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  -- Migration 068: this member's own high-water mark against
  -- groups.profile_changed_at, so a rename/icon change notice shows exactly
  -- once per member.
  last_seen_change_at TEXT,
  PRIMARY KEY (group_id, member_slug)
);

CREATE TABLE IF NOT EXISTS group_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now')),
  -- Migration 070. A link is shareable to several people but bounded: the
  -- claim is an atomic UPDATE guarded on use_count < max_uses, so concurrent
  -- redemptions can't overshoot. revoked_at kills a leaked link without
  -- taking the group down with it.
  use_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 10,
  revoked_at TEXT
);

-- Migration 065: a title recommended to a group. The row belongs to the
-- group, not to any member's library — adding is pull (the member's own tap
-- copies it onto their own Next Up), dismissing is a per-member mark, and no
-- cross-member write exists anywhere in the feature. Identity is snapshotted
-- from the recommender's copy; show_id points at that copy for enrichment
-- inheritance and nulls out if it is deleted. The note is group-visible by
-- design, unlike the owner-only memos on library rows (docs/INVARIANTS.md).
CREATE TABLE IF NOT EXISTS group_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  suggested_by TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  show_id INTEGER REFERENCES shows(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  tmdb_id INTEGER,
  movie INTEGER DEFAULT 0,
  poster_url TEXT,
  network TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_suggestion_responses (
  suggestion_id INTEGER NOT NULL REFERENCES group_suggestions(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('dismissed', 'added')),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (suggestion_id, member_slug)
);

-- One row per TMDB entry: the show itself, as opposed to a member's copy of
-- it. Step 1 of normalizing the library (docs/ARCHITECTURE.md#titles).
-- Nothing reads these tables yet; functions/_shared/titles.js keeps them in
-- sync with `shows` so the next step can switch reads over. The backfill
-- for an existing database is in migrations/076_titles.sql.
CREATE TABLE IF NOT EXISTS titles (
  tmdb_type TEXT NOT NULL CHECK (tmdb_type IN ('tv', 'movie')),
  tmdb_id INTEGER NOT NULL,
  -- TMDB's own name for the entry.
  name TEXT NOT NULL,
  overview TEXT, poster_url TEXT, backdrop_url TEXT, network_logo_url TEXT, tagline TEXT, genres TEXT,
  director TEXT, director_imdb_id TEXT, content_rating TEXT, trailer_key TEXT, runtime INTEGER, release_year INTEGER,
  rating TEXT, tmdb_rating TEXT, vote_count INTEGER, seasons_released INTEGER, episodes_released INTEGER, full_series INTEGER,
  next_season_date TEXT, season_end_date TEXT, streaming_on TEXT, free_on TEXT, studio TEXT, original_language TEXT,
  imdb_id TEXT, tmdb_status TEXT, watch_link TEXT,
  synced_at TEXT,
  PRIMARY KEY (tmdb_type, tmdb_id)
);
CREATE TABLE IF NOT EXISTS title_cast (
  tmdb_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  imdb_id TEXT,
  tmdb_person_id INTEGER,
  character_name TEXT,
  PRIMARY KEY (tmdb_type, tmdb_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_title_cast_person ON title_cast(tmdb_person_id);
-- Every lookup from a show copy to its entry goes through this.
CREATE INDEX IF NOT EXISTS idx_shows_tmdb ON shows(tmdb_id, tmdb_type);
-- Member-facing reads go through shows_v, which takes the title and the
-- show's details from titles (migrations 077, 080; generated from viewSql()
-- in functions/_shared/titles.js).
CREATE VIEW shows_v AS
  SELECT s.id AS id,
    COALESCE(t.name, s.title) AS title,
    s.network AS network,
    s.network_url AS network_url,
    s.recommended_by AS recommended_by,
    t.rating AS rating,
    s.list AS list,
    s.notes AS notes,
    s.movie AS movie,
    s.full_series AS full_series,
    s.watching_with AS watching_with,
    s.next_season_date AS next_season_date,
    s.season_end_date AS season_end_date,
    t.seasons_released AS seasons_released,
    t.poster_url AS poster_url,
    s.network_logo_url AS network_logo_url,
    s.title_ok AS title_ok,
    s.sort_order AS sort_order,
    s.archived AS archived,
    s.member_slug AS member_slug,
    s.created_at AS created_at,
    s.updated_at AS updated_at,
    s.added_by AS added_by,
    s.enriched_at AS enriched_at,
    t.genres AS genres,
    t.overview AS overview,
    t.backdrop_url AS backdrop_url,
    t.tmdb_rating AS tmdb_rating,
    t.content_rating AS content_rating,
    t.trailer_key AS trailer_key,
    t.director AS director,
    t.director_imdb_id AS director_imdb_id,
    t.runtime AS runtime,
    t.release_year AS release_year,
    t.watch_link AS watch_link,
    s.tmdb_id AS tmdb_id,
    s.tmdb_type AS tmdb_type,
    t.episodes_released AS episodes_released,
    t.vote_count AS vote_count,
    t.tagline AS tagline,
    t.original_language AS original_language,
    t.studio AS studio,
    t.streaming_on AS streaming_on,
    t.imdb_id AS imdb_id,
    t.tmdb_status AS tmdb_status,
    t.free_on AS free_on
    FROM shows s
    LEFT JOIN titles t
      ON t.tmdb_id = s.tmdb_id
     AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END);
-- Member-facing cast reads go through actors_v: the shared cast (migrations
-- 078, 080; generated from actorsViewSql() in functions/_shared/titles.js).
CREATE VIEW actors_v AS
  SELECT tc.ord AS id, s.id AS show_id, tc.name AS name, tc.imdb_id AS imdb_id, tc.ord AS ord,
         tc.tmdb_person_id AS tmdb_person_id, tc.character_name AS character_name
    FROM shows s
    JOIN title_cast tc
      ON tc.tmdb_id = s.tmdb_id
     AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END);


-- Daily Trending snapshot (migration 067). /api/popular computes its ranking
-- once per UTC day and serves everyone else from this one-row cache — the
-- ranking query is the most expensive read in the product and the endpoint is
-- public, which is how bots burned the free-tier daily D1 read budget on
-- 2026-09-01.
CREATE TABLE IF NOT EXISTS trending_cache (
  day TEXT PRIMARY KEY,              -- UTC date, YYYY-MM-DD
  payload TEXT NOT NULL,             -- JSON array of ranked show rows
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
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
-- Serves LOWER(title) matches (Trending's daily compute, title-scoped
-- propagation); idx_shows_active_title is COLLATE NOCASE and can't.
CREATE INDEX IF NOT EXISTS idx_shows_title_lower ON shows(LOWER(title));
CREATE INDEX IF NOT EXISTS idx_actors_show_id ON actors(show_id);
CREATE INDEX IF NOT EXISTS idx_show_ratings_title ON show_ratings(tmdb_id, tmdb_type);
CREATE INDEX IF NOT EXISTS idx_show_watchers_show ON show_watchers(show_id);
CREATE INDEX IF NOT EXISTS idx_show_watchers_member ON show_watchers(member_slug);
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
CREATE INDEX IF NOT EXISTS idx_group_suggestions_group ON group_suggestions(group_id);
CREATE INDEX IF NOT EXISTS idx_group_suggestions_by ON group_suggestions(suggested_by);
CREATE INDEX IF NOT EXISTS idx_group_suggestion_responses_member ON group_suggestion_responses(member_slug);

-- MCP server + OAuth 2.1 authorization server (migration 071). See the
-- migration for what each table is for.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  registered_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  -- Set when the code is redeemed, so a replayed code can revoke what it
  -- minted (RFC 6749 §4.1.2).
  grant_id INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_usage (
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_slug, day)
);

-- Changes an admin made to another member's lists through a connected AI
-- app (members:admin scope). See migration 074.
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_slug TEXT NOT NULL,
  member_slug TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_member ON admin_actions(member_slug, created_at);

-- Per-member daily ledger of upstream spend (Claude, TMDB/Watchmode). See
-- migration 072 and _shared/spend-meter.js.
CREATE TABLE IF NOT EXISTS member_spend (
  member_slug TEXT NOT NULL,
  day TEXT NOT NULL,
  claude INTEGER NOT NULL DEFAULT 0,
  lookups INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_slug, day)
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_ip ON oauth_clients(registered_ip, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_member ON oauth_grants(member_slug);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);

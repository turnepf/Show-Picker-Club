-- Show Picker as an MCP server (docs/ARCHITECTURE.md#mcp-server). A member
-- connects an AI app (Claude, ChatGPT, Claude Code) to /mcp, and the app acts
-- on their lists with their own permissions. Remote MCP clients authenticate
-- with OAuth 2.1, so this is the club becoming its own authorization server:
--
--   oauth_clients   an AI app that registered itself (RFC 7591 dynamic client
--                   registration — Claude registers on first connect). Its
--                   name is self-declared and untrusted; the consent screen
--                   shows the redirect host beside it for that reason.
--   oauth_codes     a one-time authorization code, ten minutes, PKCE-bound.
--                   The grant is only written when a code is redeemed, so an
--                   abandoned consent never shows up as a connected app.
--   oauth_grants    one member's consent to one client — what the Connected
--                   apps screens list and revoke. Revoking the grant kills
--                   every token hanging off it at once.
--   oauth_tokens    access (1 hour) and refresh (90 days, rotated on every
--                   use) tokens. Only a SHA-256 of each is stored.
--   mcp_usage       per-member daily counters behind the MCP rate caps.
--
-- Every timestamp is SQLite's datetime('now') shape and every comparison
-- happens in SQL — mixing a JavaScript ISO string into a TEXT comparison is
-- the bug that left every hourly login cap inert (docs/INVARIANTS.md §25).

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

CREATE INDEX IF NOT EXISTS idx_oauth_clients_ip ON oauth_clients(registered_ip, created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_member ON oauth_grants(member_slug);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);

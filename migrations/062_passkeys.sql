-- Passkeys (WebAuthn). Adds a sign-in method that needs no vendor: no SMS,
-- no email delivery, no third-party identity provider. See
-- docs/ARCHITECTURE.md#passkeys.
--
-- A passkey is always an addition to an account that already exists — the
-- enrollment paths (Apple, Google, email code) are unchanged, and nothing
-- here can create a member.

CREATE TABLE IF NOT EXISTS member_passkeys (
  -- base64url credential id from the authenticator; globally unique, which is
  -- what lets sign-in resolve a member from the credential alone.
  credential_id TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  -- base64url COSE public key exactly as the authenticator produced it;
  -- re-imported into WebCrypto on each verification.
  public_key TEXT NOT NULL,
  -- Authenticator signature counter. Apple's platform authenticator always
  -- reports 0, so the clone check only applies when both sides are non-zero.
  sign_count INTEGER NOT NULL DEFAULT 0,
  -- Authenticator model id. Stored for support ("which device is this?"),
  -- not used in any decision.
  aaguid TEXT,
  -- Member-facing device name supplied by the client.
  label TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_passkeys_member ON member_passkeys(member_slug);

-- Single-use challenges. Rows are deleted as they're consumed and swept when
-- they expire, so this table stays near-empty in steady state.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  -- 'register' | 'authenticate'
  purpose TEXT NOT NULL,
  -- Set for registration (the member is already signed in); NULL for
  -- authentication, where the whole point is that we don't know who they are
  -- until the assertion verifies.
  member_slug TEXT,
  -- Origin IP, for the per-IP ceiling on outstanding challenges.
  ip TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);

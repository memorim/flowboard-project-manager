CREATE TABLE IF NOT EXISTS accounts (
  member_id INTEGER PRIMARY KEY REFERENCES members(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES accounts(member_id),
  expires_at INTEGER NOT NULL CHECK(expires_at > 0)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

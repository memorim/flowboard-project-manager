CREATE TABLE IF NOT EXISTS external_identities (
 provider TEXT NOT NULL CHECK(provider IN ('google','yandex','github','telegram')),
 subject TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES accounts(member_id),
 label TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(provider,subject)
);
CREATE INDEX IF NOT EXISTS external_identity_member ON external_identities(member_id);
CREATE TABLE IF NOT EXISTS oauth_flows (
 state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, browser_hash TEXT NOT NULL,
 verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at BIGINT NOT NULL,
 member_id INTEGER REFERENCES accounts(member_id), session_hash TEXT,
 password_version INTEGER, consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS oauth_flow_expiry ON oauth_flows(expires_at);

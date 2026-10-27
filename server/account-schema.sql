CREATE TABLE IF NOT EXISTS account_actions (
 token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES accounts(member_id),
 kind TEXT NOT NULL CHECK(kind IN ('verify','reset')), expires_at BIGINT NOT NULL,
 password_version INTEGER NOT NULL, used_at BIGINT
);
CREATE INDEX IF NOT EXISTS account_actions_expiry ON account_actions(expires_at);
CREATE TABLE IF NOT EXISTS mfa_challenges (
 token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES accounts(member_id),
 expires_at BIGINT NOT NULL, password_version INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_codes (
 member_id INTEGER NOT NULL REFERENCES accounts(member_id), code_hash TEXT NOT NULL,
 PRIMARY KEY(member_id,code_hash)
);
CREATE TABLE IF NOT EXISTS request_budgets (
 budget_key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS request_budgets_expiry ON request_budgets(expires_at);
CREATE TABLE IF NOT EXISTS mail_outbox (
 id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at BIGINT NOT NULL,
 next_attempt_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 lease_until BIGINT NOT NULL DEFAULT 0, lease_token TEXT,
 delivered_at BIGINT, failed_at BIGINT
);
CREATE INDEX IF NOT EXISTS mail_ready ON mail_outbox(delivered_at,failed_at,next_attempt_at);

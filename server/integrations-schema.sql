CREATE TABLE IF NOT EXISTS directory_tokens (
 workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id), token_hash TEXT NOT NULL UNIQUE,
 created_by INTEGER NOT NULL REFERENCES members(id), default_role TEXT NOT NULL CHECK(default_role IN ('editor','viewer')),
 created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS directory_users (
 id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
 member_id INTEGER NOT NULL REFERENCES members(id), external_id TEXT, email TEXT NOT NULL,
 name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_email ON directory_users(workspace_id,email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS directory_external_id ON directory_users(workspace_id,external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS directory_groups (
 id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), external_id TEXT,
 name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_group_external_id ON directory_groups(workspace_id,external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS directory_group_members (
 group_id TEXT NOT NULL REFERENCES directory_groups(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES directory_users(id), PRIMARY KEY(group_id,user_id)
);
CREATE TABLE IF NOT EXISTS workspace_payments (
 id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
 created_by INTEGER NOT NULL REFERENCES members(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 provider_id TEXT UNIQUE, request_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
 confirmation_url TEXT, created_at BIGINT NOT NULL, applied_at BIGINT, is_test INTEGER NOT NULL DEFAULT 1,
 next_check_at BIGINT NOT NULL DEFAULT 0, check_lease_until BIGINT NOT NULL DEFAULT 0, check_lease_token TEXT
);
CREATE INDEX IF NOT EXISTS payment_reconcile ON workspace_payments(status,next_check_at,check_lease_until);
CREATE TABLE IF NOT EXISTS workspace_plans (
 workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id), valid_until BIGINT NOT NULL
);

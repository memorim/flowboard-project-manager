ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_enabled INTEGER NOT NULL DEFAULT 1 CHECK(password_enabled IN (0,1));

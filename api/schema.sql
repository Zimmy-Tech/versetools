-- VerseTools database schema (Phase 1 Stage B)
--
-- Phase 1 strategy: store ships and items as JSONB documents keyed by
-- className, with a `source` column to distinguish extracted vs curated
-- entries. This gives us a round-trippable database without committing
-- to a normalized schema before we know what the admin editor needs.
--
-- Phase 2 will add normalized columns alongside the JSONB blob as the
-- editor grows — JSONB can be queried with -> / ->> in the meantime.

CREATE TABLE IF NOT EXISTS ships (
  class_name      TEXT PRIMARY KEY,
  data            JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'extracted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  class_name      TEXT PRIMARY KEY,
  data            JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'extracted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mining_locations (
  id              SERIAL PRIMARY KEY,
  data            JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS mining_elements (
  id              SERIAL PRIMARY KEY,
  data            JSONB NOT NULL
);

-- Singleton row holding the top-level meta blob
CREATE TABLE IF NOT EXISTS meta (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data            JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log (used in Phase 2 once admin writes are added)
CREATE TABLE IF NOT EXISTS audit_log (
  id              SERIAL PRIMARY KEY,
  user_name       TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_key      TEXT,
  field_name      TEXT,
  old_value       TEXT,
  new_value       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users table (Phase 2 auth)
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

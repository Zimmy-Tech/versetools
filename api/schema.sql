-- VerseTools database schema (Phase 1 Stage B)
--
-- Phase 1 strategy: store ships and items as JSONB documents keyed by
-- className, with a `source` column to distinguish extracted vs curated
-- entries. This gives us a round-trippable database without committing
-- to a normalized schema before we know what the admin editor needs.
--
-- Phase 2 will add normalized columns alongside the JSONB blob as the
-- editor grows — JSONB can be queried with -> / ->> in the meantime.
--
-- Tables live in the `versedb` schema because DigitalOcean's dev-tier
-- Postgres user has no CREATE permission on `public`.

CREATE SCHEMA IF NOT EXISTS versedb;
SET search_path TO versedb;

-- ships and items both keep two complete copies — one per `mode`. The
-- composite primary key (class_name, mode) lets us treat live and ptu
-- as fully independent datasets. Most rows are duplicates day-to-day,
-- which is fine: storage is cheap and the simplicity wins everywhere.
CREATE TABLE IF NOT EXISTS ships (
  class_name      TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'live',
  data            JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'extracted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_name, mode)
);

CREATE TABLE IF NOT EXISTS items (
  class_name      TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'live',
  data            JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'extracted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_name, mode)
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

-- Audit log (used in Phase 2 once admin writes are added).
-- entity_mode lets us see which side (live or ptu) a change touched.
CREATE TABLE IF NOT EXISTS audit_log (
  id              SERIAL PRIMARY KEY,
  user_name       TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_key      TEXT,
  entity_mode     TEXT,
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

-- Generic key/value site settings (PTU toggle, PTU label, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Build-import changelog. One row per imported build, recorded
-- automatically when an admin applies a diff. The snapshot columns
-- store the full ships/items arrays from THIS build so the next
-- import can compute its diff against the previous build's content
-- (independent of any manual edits made to the live tables since).
CREATE TABLE IF NOT EXISTS changelog_entries (
  id              SERIAL PRIMARY KEY,
  from_version    TEXT,
  from_channel    TEXT,
  to_version      TEXT NOT NULL,
  to_channel      TEXT NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ship_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_added      JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_added      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_removed    JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_removed    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_snapshot   JSONB,
  item_snapshot   JSONB,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS changelog_entries_id_desc_idx ON changelog_entries (id DESC);

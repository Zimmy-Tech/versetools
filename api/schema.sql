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

-- Community submissions: ship acceleration data tested in-game.
-- A public POST endpoint inserts pending rows; the admin reviews and
-- approves or rejects each. Approval applies the values to the ship
-- and marks the ship's accel fields as curated.
CREATE TABLE IF NOT EXISTS accel_submissions (
  id              SERIAL PRIMARY KEY,
  ship_class_name TEXT NOT NULL,
  ship_name       TEXT,
  submitter_name  TEXT NOT NULL,
  accel_fwd       NUMERIC,
  accel_ab_fwd    NUMERIC,
  accel_retro     NUMERIC,
  accel_ab_retro  NUMERIC,
  accel_strafe    NUMERIC,
  accel_ab_strafe NUMERIC,
  accel_up        NUMERIC,
  accel_ab_up     NUMERIC,
  accel_down      NUMERIC,
  accel_ab_down   NUMERIC,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
                  -- 'pending', 'approved', 'rejected'
  reviewer_note   TEXT,
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS accel_submissions_status_idx ON accel_submissions (status, submitted_at DESC);

-- Generic feedback table for the existing feedback form
CREATE TABLE IF NOT EXISTS feedback_submissions (
  id              SERIAL PRIMARY KEY,
  feedback_type   TEXT,
  feedback_text   TEXT NOT NULL,
  submitter_name  TEXT,
  submitter_email TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE
);

-- Changelog entries. Two kinds, distinguished by `entry_type`:
--   * 'build_import' — recorded when an admin applies a build-import diff.
--     The ship/item snapshot columns store full arrays from THIS build so
--     the next import diffs against build-to-build content (independent of
--     manual edits made to the live tables since).
--   * 'price_refresh' — recorded when an admin clicks "Refresh shop prices
--     from UEX". The price_* columns store the changes; price_snapshot is
--     the full set of UEX-sourced prices for diffing against the next refresh.
-- to_version/to_channel are repurposed for price refreshes: to_version holds
-- an ISO timestamp of the refresh, to_channel holds 'uex'.
CREATE TABLE IF NOT EXISTS changelog_entries (
  id              SERIAL PRIMARY KEY,
  entry_type      TEXT NOT NULL DEFAULT 'build_import',
  from_version    TEXT,
  from_channel    TEXT,
  to_version      TEXT NOT NULL,
  to_channel      TEXT NOT NULL,
  actor           TEXT,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ship_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_added      JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_added      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_removed    JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_removed    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ship_snapshot   JSONB,
  item_snapshot   JSONB,
  price_changes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_added     JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_removed   JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_snapshot  JSONB,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS changelog_entries_id_desc_idx ON changelog_entries (id DESC);
-- Note: changelog_entries_type_idx is created by migrateExtractShopPrices()
-- after the entry_type column is added (existing DBs predate the column).

-- Shop prices for ships and items, extracted from UEX or manually entered.
-- Stored in a standalone table (not embedded in ships/items JSONB) so that:
--   (1) prices are mode-agnostic — one row applies to both LIVE and PTU,
--   (2) UEX refresh is a fast atomic DELETE+INSERT,
--   (3) cross-entity queries like "what does Lorville sell?" are trivial,
--   (4) manual overrides (source='manual') survive UEX refreshes that only
--       touch source='uex' rows.
CREATE TABLE IF NOT EXISTS shop_prices (
  id               SERIAL PRIMARY KEY,
  entity_type      TEXT NOT NULL,             -- 'ship' or 'item'
  entity_class     TEXT NOT NULL,             -- e.g. 'aegs_avenger_titan'
  shop_nickname    TEXT NOT NULL,             -- e.g. 'New Deal Lorville' (display string)
  shop_company     TEXT,                      -- e.g. 'New Deal' (operator)
  star_system      TEXT,
  planet           TEXT,
  moon             TEXT,
  orbit            TEXT,
  space_station    TEXT,
  city             TEXT,
  outpost          TEXT,
  price_buy        INTEGER NOT NULL,
  price_sell       INTEGER,                   -- nullable; UEX provides for items, not vehicles
  source           TEXT NOT NULL DEFAULT 'uex',  -- 'uex' or 'manual'
  uex_terminal_id  INTEGER,                   -- UEX's id_terminal (null for manual)
  notes            TEXT,                      -- free-form, useful for manual entries
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_class, shop_nickname, source)
);
CREATE INDEX IF NOT EXISTS shop_prices_entity_idx   ON shop_prices (entity_type, entity_class);
CREATE INDEX IF NOT EXISTS shop_prices_nickname_idx ON shop_prices (shop_nickname);
CREATE INDEX IF NOT EXISTS shop_prices_company_idx  ON shop_prices (shop_company);
CREATE INDEX IF NOT EXISTS shop_prices_system_idx   ON shop_prices (star_system);
CREATE INDEX IF NOT EXISTS shop_prices_source_idx   ON shop_prices (source);

-- Cooling observations: admin-submitted in-game cooling gauge readings.
-- Used to validate and refit the cooling demand weight formula.
-- Default loadout is assumed unless noted; pip_allocation captures the
-- power distribution state at time of observation.
CREATE TABLE IF NOT EXISTS cooling_observations (
  id                   SERIAL PRIMARY KEY,
  ship_class_name      TEXT NOT NULL,
  ship_name            TEXT,                          -- display name at time of submission
  build_version        TEXT NOT NULL,                 -- SC build version (e.g. '4.0.2')
  pip_allocation       JSONB,                         -- {slotId: pipCount} snapshot
  reported_cooling_pct INTEGER NOT NULL,              -- in-game gauge reading (0-100+)
  reported_ir_value    REAL,                          -- in-game IR signature reading
  predicted_cooling_pct INTEGER,                      -- what our formula predicts (computed on insert)
  loadout_note         TEXT,                          -- "swapped coolers to XYZ" etc.
  notes                TEXT,                          -- general observations
  submitter            TEXT NOT NULL DEFAULT 'admin',
  status               TEXT NOT NULL DEFAULT 'active',-- 'active', 'outlier', 'rejected'
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cooling_obs_ship_idx ON cooling_observations (ship_class_name);
CREATE INDEX IF NOT EXISTS cooling_obs_status_idx ON cooling_observations (status);

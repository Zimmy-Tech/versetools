# VerseTools Database Schema & Conventions

This document describes the live database powering the VerseTools API: what tables exist, how schema changes are made, how data flows in, and how recovery works. It is intentionally written for someone who is **not** a database engineer.

If you are reading this as a contributor: read sections 1, 2, and 6 first. If you are reading this as a future Claude instance making a schema change: read section 4 carefully and follow the convention exactly.

---

## 1. Where the database lives

- **Provider:** Neon (managed Postgres, PG 17)
- **Schema name (Postgres-level):** `versedb`
  - Not `public`. Neon's dev-tier user has no `CREATE` permission on `public`, so everything lives under a dedicated namespace.
  - All queries must either `SET search_path TO versedb` (which `db.js` does once per connection at startup, in effect) or fully qualify table names as `versedb.ships`, `versedb.items`, etc.
- **Connection:** Single `DATABASE_URL` env var, set in DigitalOcean App Platform for the API and as a GitHub Actions secret for the backup workflow. Same value in both places.
- **Environments:** Production only. There is no staging database. The "live" vs "ptu" split is *inside* the same database (see section 3), not two separate databases.

---

## 2. Tables at a glance

All table definitions live in `api/schema.sql`. The list below is a human-readable summary; the SQL file is the source of truth for column types and constraints.

| Table | Purpose | Notable shape |
|---|---|---|
| `ships` | One row per ship per mode. Stores the full ship object as a JSONB blob. | Composite PK `(class_name, mode)` |
| `items` | One row per component per mode (weapons, shields, coolers, etc.) | Composite PK `(class_name, mode)` |
| `mining_locations` | Mineral spawn locations from the extraction pipeline. JSONB. | `id SERIAL` |
| `mining_elements` | Mineral / element reference data. JSONB. | `id SERIAL` |
| `meta` | Single-row table holding the top-level meta blob (game version, counts, etc.) | Singleton: `id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)` |
| `audit_log` | One row per admin write. Records who changed what, when, and on which mode. | `entity_mode` distinguishes live vs ptu writes |
| `users` | Admin auth users. Username + bcrypt password hash + role. | Phase 2 auth |
| `settings` | Generic key/value store for site config (PTU toggle, PTU label, etc.) | `key TEXT PRIMARY KEY`, value JSONB |
| `accel_submissions` | Community-submitted ship acceleration measurements awaiting admin review | `status` ∈ `pending` / `approved` / `rejected` |
| `feedback_submissions` | Generic feedback form inbox | Acknowledged flag for triage |
| `changelog_entries` | One row per imported game build. Stores the diff against the previous build *and* a full snapshot of ships/items for the next diff. | See section 5 for the snapshot mechanism |

The JSONB-heavy approach is deliberate: ships and items are still evolving, and committing to a fully normalized schema before the admin editor is mature would lock in choices we don't want yet. Querying JSONB with `data->>'fieldName'` is fine for now; if any field becomes hot enough to need indexing, we can add a generated column or expression index without restructuring.

---

## 3. The dual-mode (live / ptu) split

VerseTools tracks two parallel datasets in the same tables:

- **`mode = 'live'`** — the values from the currently shipped Star Citizen build
- **`mode = 'ptu'`** — the values from the public test build (when one is active)

This lets the site show both at once and lets admins compare or sync between them. A ship is identified by the pair `(class_name, mode)`, so `('ANVL_Ballista', 'live')` and `('ANVL_Ballista', 'ptu')` are two independent rows.

**Implication for queries:** every query against `ships`, `items`, or `audit_log` should specify a mode (or the API layer should be supplying it from the request context). Forgetting to filter by mode is the most likely source of "why am I seeing duplicates" bugs.

**Sync direction:** there is a one-way `syncPtuFromLive(userName)` helper in `db.js` that overwrites the entire PTU side with a fresh copy of the LIVE side. This is the "reset PTU" button. There is *no* automatic sync the other direction — PTU is treated as a scratch space that admins can mutate freely without affecting LIVE.

**Why a single composite key instead of two tables?** Two tables (`ships_live` and `ships_ptu`) would double the surface area of every query and make it easy for the LIVE side and the PTU side to drift in shape. With one table and a `mode` column, the schema is guaranteed identical, and a query that wants both can be `WHERE mode IN ('live', 'ptu')` instead of a `UNION`.

---

## 4. Convention for schema changes (current, intentionally informal)

> ⚠️ **Read this whole section before changing the schema.**

This project does **not** currently use a formal migrations framework (no Knex, no Flyway, no migrations directory). The reasons are explained in section 7 — short version: the schema is still being validated against real-world workflows, and we want the freedom to make corrections without accumulating a permanent history of mistakes.

Until we adopt formal migrations, the convention is:

### Case A: purely additive change (new table, new column, new index)

1. Add the new `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` to `api/schema.sql`.
2. That's it. The next API restart will run `initSchema()`, which executes `schema.sql`, which is idempotent — it adds the new thing if missing and does nothing if it's already there.
3. Adding a column to an *existing* table cannot be done this way (see Case B). `CREATE TABLE IF NOT EXISTS` only does anything when the table doesn't exist at all.

### Case B: altering an existing table (new column on an existing table, type change, default change, primary key change, data backfill, anything destructive)

1. Add the new column to `schema.sql` so fresh installs get it.
2. Write a new exported async function in `api/db.js` named `migrateXyz()` (e.g. `migrateAddInsuranceColumn`, `migrateRenameAccelLateral`).
3. The function **must be idempotent**: it should query `information_schema` to detect whether the change has already been applied and bail out if so. See `migrateAddModeColumn` (db.js) as the canonical example. Without an idempotency guard, the function will crash on the second startup.
4. The function **must use a transaction** (`BEGIN` / `COMMIT` / `ROLLBACK`). If any step fails, the whole change rolls back, leaving the database in its prior state. Never apply schema changes outside a transaction.
5. Call the new function from `ensureReady()` in `db.js`, in order, *after* `initSchema()` and after any migrations it depends on. Order matters: a migration that depends on another migration must run after it.
6. Test on a local database first if at all possible. If not, deploy carefully and watch the API startup logs.
7. Add a one-line entry to the **change log** at the bottom of this file (section 8) so future readers can see the history at a glance.

### Naming convention

`migrate<Verb><Subject>` — e.g. `migrateAddModeColumn`, `migrateRenameAccelLateral`, `migrateBackfillSubmittedAt`. Past tense ("migrated...") implies it has run; present tense ("migrate...") implies "this is the operation."

### What you must never do

- **Never edit `schema.sql` to change an existing column or constraint** and assume it will take effect. `schema.sql` only runs through `CREATE TABLE IF NOT EXISTS`, which is a no-op for tables that already exist. The change will silently fail to apply on production while appearing to work locally on a fresh install.
- **Never run a destructive `ALTER` directly against the production database** without writing a migration function for it. If you do, the next person who provisions a fresh environment will get a different schema than production has, and that drift is invisible until something breaks.
- **Never edit a `migrate*()` function after it has run on production.** If you need to fix something, write a new migration function. Editing an applied migration breaks the idempotency check and confuses future readers about what the database actually looks like.

---

## 5. The diff / import flow (how data gets in)

The schema is one half of the story. The other half is *how data gets into* these tables. This section is high-level so you understand the coupling between the schema and the import system.

### Initial seeding

When a brand-new API starts up against an empty database, `importIfEmpty()` runs once. It:

1. Checks if `ships` has any rows. If yes, skips (seeding is one-time-only).
2. Reads `api/data/versedb_data.json` — a static JSON file shipped with the API that contains a recent extraction.
3. Inserts every ship into `ships` twice (once as `mode = 'live'`, once as `mode = 'ptu'`). Same for items.
4. Loads mining locations, mining elements, and the meta blob.
5. Commits in a single transaction.

After this point, `importIfEmpty()` is a no-op. Subsequent imports go through the diff/approve flow below.

### Build imports (the diff & approve flow)

When the user uploads a new extracted JSON via the admin panel:

1. The admin UI compares the uploaded build against the *current* state of the live database, producing a list of additions, removals, and per-field changes.
2. The admin reviews the diff and chooses to apply or reject it.
3. If applied, the API writes the new ship/item rows into the `live` side, overwriting fields the admin approved.
4. **`recordChangelogEntry()` is called**, which:
   - Diffs the newly applied build against the *previous build's snapshot* stored in `changelog_entries`
   - Inserts a new row into `changelog_entries` with the diff lists *and* a fresh snapshot of every ship and item from this build
   - Prunes older entries beyond `CHANGELOG_RETENTION`

### Why snapshots?

Each `changelog_entries` row stores the full ship and item arrays from the build it represents. This is intentional: it means the *next* import can compute its diff against the previous *build's* content rather than against the current *live* tables. That matters because admins may have manually edited the live tables in between imports — and we don't want those manual edits to show up as fake "changes" the next time a build is imported.

In other words: build-to-build diffs are computed from snapshots; manual edits do not pollute the changelog.

### Coupling between schema and imports

This is where the migrations question gets interesting. If a future schema change reshapes the contents of the `data` JSONB column (say, splitting one field into three), then:

- Existing rows in `ships` and `items` need to be migrated (data migration)
- Old snapshots in `changelog_entries.ship_snapshot` and `item_snapshot` will still have the *old* shape
- The diff function `diffArraysForChangelog` in `db.js` needs to handle both shapes, or the snapshots need to be migrated too

This is why we are not adopting formal migrations tooling yet (see section 7). We want to fully exercise the diff/import system at least once on each side (LIVE and PTU) before locking in a schema baseline that might need to be reshaped once we discover what the import flow actually demands.

---

## 6. Backups & recovery

### Backups

- **Where:** GitHub Actions workflow at `.github/workflows/db-backup.yml`
- **When:** Daily at 03:17 UTC (off-peak, randomized minute)
- **How:** `pg_dump --schema=versedb --no-owner --no-acl --format=plain` against the production database via the `DATABASE_URL` secret
- **Retention:** 90 days as workflow artifacts (GitHub Actions default)
- **Verification:** the workflow grep-checks that the dump contains `CREATE TABLE versedb.ships` before uploading, so a corrupt dump fails loudly
- **Manual run:** Actions tab → Database Backup → Run workflow

### Recovery procedure

If the production database is lost or corrupted:

1. Go to the GitHub Actions tab → Database Backup → most recent successful run → download the artifact
2. Provision a new Postgres host (Neon project, DigitalOcean managed Postgres, anything)
3. `psql "$NEW_DATABASE_URL" < versedb-backup-YYYYMMDD-HHMMSS.sql`
4. Update `DATABASE_URL` in DigitalOcean App Platform → API component → Environment Variables
5. Let the API redeploy. On startup, `initSchema()` will see the tables already exist (no-op), `migrateAddModeColumn()` will see the migration is already applied (no-op), and `importIfEmpty()` will see ships are already populated (no-op). The API will come up against the restored data with no further intervention.

### What backups DO cover

- All tables in the `versedb` schema
- All data in those tables
- Indexes, constraints, defaults

### What backups DO NOT cover

- The `users` table contents will be restored, but if you provisioned a brand-new database without restoring from backup, you'd need to recreate the admin user via whatever bootstrap path the API exposes.
- DigitalOcean App Platform configuration (env vars, source dirs, build commands) is not in the backup. Keep an export of the App Spec elsewhere if you want full disaster recovery.
- The static seed file `api/data/versedb_data.json` is in git, not in the backup, but the backup contains the imported version of that data so it's not load-bearing for recovery.

---

## 7. Future work: when to adopt formal migrations

We are intentionally **not** using a formal migrations framework yet. The current convention (section 4) is enough for now and will eventually become painful enough that the upgrade is obviously worth it.

### Conditions under which we should upgrade

Adopt a real migrations system (likely a small DIY runner with a `versedb.schema_migrations` ledger table and an `api/migrations/*.sql` directory — see the conversation history that produced this doc, or ask Claude to refresh the proposal) when **any** of the following becomes true:

1. **The pipeline has been validated end-to-end at least once on each side.** This means: a real LIVE import has run through the new backend successfully, a real PTU import has run successfully (requires CIG to push a PTU build), at least one diff has been approved, and at least one diff has been rejected. Until all four boxes are checked, the schema is still under validation and we want the freedom to reshape it without accumulating migration history.
2. **A second contributor starts making schema changes.** The current convention is fine for one person; it falls apart fast with two, because there's no enforced ordering.
3. **There are more than ~3 ad-hoc `migrate*()` functions piled up in `db.js`.** That's the point where they become hard to reason about and hard to verify ordering.
4. **The first time you have to roll back a schema change in production.** That experience will sell the value of having a structured system more effectively than this document can.

### What "adopting migrations" would actually look like

The plan, when we get there, is the smallest thing that solves the problem:

- Add a `versedb.schema_migrations` table with `(id INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ)`
- Create `api/migrations/` with numbered SQL files: `0001_initial.sql`, `0002_dual_mode.sql`, etc.
- The first migration is a `pg_dump --schema-only` of the **actual current production schema**, not a guess at what it should be
- A small runner in `db.js` scans the directory at startup, queries the ledger, runs anything unapplied in numerical order, each in a transaction
- The existing `schema.sql` and `migrateAddModeColumn()` get retired in favor of the migration files

No new dependencies. ~80 lines of new code. Total disruption: one risky session to convert, and one rule to remember forever ("never edit an applied migration file"). The conversion is much safer once the conditions in the previous subsection are met, because we'll have confidence the baseline we're locking in is actually correct.

---

## 8. Schema change log

Append a one-line entry to the bottom of this list every time the schema changes. Format: `YYYY-MM-DD — brief description — (commit hash if applicable)`

- **2026-04-07** — Initial documentation written. Schema as of merge commit `b24103c`. Tables: `ships`, `items`, `mining_locations`, `mining_elements`, `meta`, `audit_log`, `users`, `settings`, `accel_submissions`, `feedback_submissions`, `changelog_entries`. Single ad-hoc migration in place: `migrateAddModeColumn` (added the live/ptu mode column to ships, items, audit_log).

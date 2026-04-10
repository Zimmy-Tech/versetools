---
name: data-flow
description: Reference for how data moves from extraction to the user's browser — JSON files, Postgres database, API endpoints, admin diff/import, and fallback chains. Use when debugging why data isn't showing up, understanding the deploy process, or figuring out which data source the app is reading from.
allowed-tools: Read, Grep, Glob, Bash
---

# VerseTools Data Flow

## Architecture Overview

```
Star Citizen Data.p4k
        ↓
  Python extractor (versedb_extract.py)
        ↓
  PY SCRIPTS/versedb_data.json  (raw extraction output)
        ↓  (auto-copied)
  app/public/live/versedb_data.json   (static fallback, bundled with app)
  app/public/ptu/versedb_data.json    (PTU equivalent)
        ↓
  Admin panel uploads JSON → diff preview → selective apply
        ↓
  Postgres database (versedb schema)
        ↓
  API: GET /api/db?mode=live  (exportFullDb assembles from DB)
        ↓
  Angular frontend (data.service.ts)
```

## The Frontend Does NOT Read Static JSON in Production

This is the most common misconception. On the production site:

1. The frontend calls `/api/db?mode=live` (or `?mode=ptu`)
2. The API queries Postgres and assembles the response from the database
3. The static JSON files in `app/public/live/` are **fallbacks only** — used when:
   - The API is down
   - Running on a static host (GitHub Pages)
   - `DATABASE_URL` is not configured

**Implication**: Updating `app/public/live/versedb_data.json` alone does NOT update production data. You must also import through the admin panel to update the database.

## Data Sources

| File/System | Role | Updated By |
|-------------|------|-----------|
| `PY SCRIPTS/versedb_data.json` | Extractor output | `versedb_extract.py` |
| `app/public/live/versedb_data.json` | Static fallback (LIVE) | Extractor auto-copy |
| `app/public/ptu/versedb_data.json` | Static fallback (PTU) | Extractor auto-copy |
| `api/data/versedb_data.json` | DB seed file (first boot only) | Manual copy |
| Postgres `versedb.ships` | Production ship data | Admin diff/import |
| Postgres `versedb.items` | Production item data | Admin diff/import |
| Postgres `versedb.meta` | Game version, counts | Admin diff/import |
| Postgres `versedb.shop_prices` | Shop locations + prices | UEX refresh endpoint |

## Getting Data to Production

### Step 1: Extract

```bash
python3 "PY SCRIPTS/versedb_extract.py"
```

This writes to `PY SCRIPTS/versedb_data.json` and auto-copies to `app/public/live/` and `app/public/ptu/`.

### Step 2: Preview Locally

```bash
cd app && npx ng serve
```

The dev server reads from `app/public/live/versedb_data.json` directly (no API/DB).

### Step 3: Commit and Push

```bash
git add PY SCRIPTS/versedb_data.json PY SCRIPTS/versedb_baseline.json \
       app/public/live/versedb_data.json app/public/ptu/versedb_data.json
git commit -m "description"
git push
```

This updates the static fallback files on the deployed site.

### Step 4: Admin Diff/Import (Updates the Database)

1. Open the admin panel on the production site
2. Navigate to Diff Review
3. Upload the new `versedb_data.json`
4. Review the diff — accept/reject individual changes
5. Apply selected changes

This is the step that actually updates what production users see (since the frontend reads from the API/database).

### Step 5: Verify

Check the live site. The API serves from the database, so changes should be immediate after the diff apply.

## API Endpoints

### Data Serving

| Endpoint | Source | Notes |
|----------|--------|-------|
| `GET /api/db?mode=live` | Postgres (or static JSON fallback) | Main data endpoint |
| `GET /api/config` | Postgres settings table | PTU toggle |
| `GET /api/health` | Server status | Includes `db: true/false` |

### Admin (requires auth)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/admin/diff/preview?mode=live` | Upload JSON, get field-level diff |
| `POST /api/admin/diff/apply?mode=live` | Apply selected changes to DB |
| `POST /api/admin/shop-prices/refresh` | Pull latest prices from UEX API |
| `GET /api/admin/cooling-observations` | List cooling observation data |

## Database Details

### Dual-Mode Schema

Ships and items are stored with a `mode` column (`live` or `ptu`). The composite primary key is `(class_name, mode)`. Each entity exists twice in the database.

### Source Tracking

The `source` column on ships/items tracks whether data is `extracted` or `curated`. This is informational — it helps identify what's been hand-edited vs what came from the pipeline.

### DB Initialization

On first API startup with `DATABASE_URL` set:

1. `initSchema()` — creates tables from `api/schema.sql`
2. `migrateAddModeColumn()` — adds dual-mode support (idempotent)
3. `importIfEmpty()` — seeds from `api/data/versedb_data.json` if tables are empty
4. Additional migrations run (shop prices, cooling IR column, etc.)

All migrations are idempotent — safe to re-run.

### The `api/data/versedb_data.json` File

This is the **DB seed file**. It's only read once (on first boot when the DB is empty). It is NOT the same as `app/public/live/versedb_data.json` and is often older. Updating it is low priority — it only matters for fresh database deployments.

## Fallback Chain

### Frontend (data.service.ts)

```
Production host:
  1. GET /api/db?mode=live
     ├─ Success → use DB data (normal path)
     └─ Failure → GET /live/versedb_data.json
        ├─ Success → use static fallback
        └─ Failure → error state

Static host (GitHub Pages):
  1. GET /live/versedb_data.json (skips API entirely)
```

### API Server

```
DATABASE_URL set:
  → Serve from Postgres via exportFullDb()

DATABASE_URL not set:
  → Serve from api/data/versedb_data.json
  → Admin endpoints return 503
```

## Changelog System

The extraction pipeline generates `versedb_changelog.json` by diffing against the previous extraction. This tracks **item-level** adds/removes and **field value** changes on tracked fields. It does NOT track per-ship hardpoint composition changes.

The admin panel also records changelog entries when diffs are applied, stored in the `changelog_entries` database table.

## Common Pitfalls

1. **"I updated the JSON but production didn't change"** — You need to import through the admin panel. The JSON is just the fallback.
2. **"The dev preview looks right but production is wrong"** — Dev reads static JSON, production reads from DB. They can diverge.
3. **"I imported but the changelog shows weird entries"** — The changelog tracks field-level diffs. Hardpoint structural changes (add/remove) are not changelog events.
4. **"The API returns old data"** — Check if `dbEnabled` is true (`GET /api/health`). If false, it's serving the stale `api/data/versedb_data.json` seed file.

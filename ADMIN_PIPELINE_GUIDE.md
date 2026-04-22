# Build Import Pipeline — ships, items, FPS, missions

This document is the operating manual for promoting freshly-extracted
game data from the destructive JSON files into the DB-backed production
pipeline. Every data stream in the app flows through one unified
mechanism:

- **Ship pipeline** — `versedb_data.json` (ships + items, the main
  catalog). Oldest pipeline in the repo.
- **FPS pipeline** — three files (`versedb_fps.json`,
  `versedb_fps_gear.json`, `versedb_fps_armor.json`) promoted together
  as one atomic bundle.
- **Missions pipeline** — `versedb_missions.json` split into the
  contracts array (className-keyed, diffable) and the reference-data
  blob (factions, reputation ladders, mission givers, etc. —
  overwritten wholesale like `meta`).

All streams flow through the same `/admin` diff-review UI and the same
`/api/admin/diff/preview` + `/api/admin/diff/apply` endpoints. The only
difference is which arrays live in the uploaded JSON.

**Audience:** the admin operating the import flow, *and* future Claude
instances handed a new CIG build. Claude instances should read this
end-to-end before proposing extractor or pipeline changes.

---

## Table of contents

1. [Mental model](#mental-model)
2. [The six streams + one singleton](#the-six-streams--one-singleton)
3. [Preview vs prod — where data actually comes from](#preview-vs-prod--where-data-actually-comes-from)
4. [Extracting a fresh build](#extracting-a-fresh-build)
5. [Building the merged payload](#building-the-merged-payload)
6. [Importing into the database](#importing-into-the-database)
7. [Atomic transaction semantics](#atomic-transaction-semantics)
8. [Curation protection](#curation-protection)
9. [Rollback procedure](#rollback-procedure)
10. [When things go wrong](#when-things-go-wrong)
11. [Handing off to a future Claude session](#handing-off-to-a-future-claude-session)

---

## Mental model

Three layers, in order of trust:

1. **Extractor output** (JSON on disk) — what CIG shipped. Regenerated
   from scratch each build. *Destructive* — each run overwrites the
   prior output. No audit, no review.
2. **Database** (Postgres `versedb` schema) — the curated + audited
   view. Changes flow through the admin diff/import UI. Every change
   logged to `audit_log`. `source='curated'` rows are protected from
   overwrites.
3. **Production app** (`/api/db?mode=live|ptu`) — reads the DB and
   serves the full payload to the Angular frontend.

JSON → DB is a *manual* step. Curated values survive re-extraction
because the diff UI defaults curated rows to unselected.

Preview deployments (GitHub Pages) *skip the DB* — they read the JSON
files directly. This is intentional: fast iteration for UI/feature
work without a DB round-trip. Only the prod host enforces curation.

---

## The six streams + one singleton

| Stream key    | Payload array    | Backend table   | Source file                   |
|---------------|-----------------|-----------------|-------------------------------|
| `ships`       | `ships[]`       | `ships`         | `versedb_data.json`           |
| `items`       | `items[]`       | `items`         | `versedb_data.json`           |
| `fpsItems`    | `fpsItems[]`    | `fps_items`     | `versedb_fps.json`            |
| `fpsGear`     | `fpsGear[]`     | `fps_gear`      | `versedb_fps_gear.json`       |
| `fpsArmor`    | `fpsArmor[]`    | `fps_armor`     | `versedb_fps_armor.json`      |
| `missions`    | `missions[]`    | `missions`      | `versedb_missions.json` (contracts) |

All six entity tables share the same schema shape: `(class_name, mode,
data JSONB, source)`. `mode` is `'live'` or `'ptu'`. `source` is
`'extracted'` or `'curated'`.

Plus two singletons (not entity-diffable — overwritten wholesale like
the `meta` blob):

| Singleton key  | Backend table   | Source                                  |
|----------------|-----------------|-----------------------------------------|
| `meta`         | `meta`          | `versedb_data.json → meta`              |
| `missionRefs`  | `mission_refs`  | `versedb_missions.json → {factions, reputationLadders, missionGivers, contractorProfiles, reputationRanks, reputationTiers, scopeToLadder}` |

`fpsItems` is special: the extractor writes three sub-arrays in
`versedb_fps.json` (`weapons`, `magazines`, `attachments`), but the
pipeline flattens them into a single `fpsItems[]` tagged with a
`_kind` field (`'weapon' | 'magazine' | 'attachment'`). The merge
script does this automatically. The Angular components filter by
`_kind` on read.

Registry location (single source of truth for stream names in code):

- **Backend** — `api/server.js`, constant `DIFF_ENTITY_TYPES`
- **Frontend** — `app/src/app/components/admin/admin.service.ts`,
  exported array `DIFF_STREAMS`

Adding a new stream = one entry in each + a new table in `schema.sql`.
The diff preview/apply handlers and the admin UI iterate these
registries; nothing else hard-codes the stream list.

---

## Preview vs prod — where data actually comes from

The Angular app's `DataService` (`app/src/app/services/data.service.ts`)
picks a source at runtime:

- **Static host (`*.github.io`)** — reads `versedb_data.json` directly.
  No API calls. FPS + missions components fall through to their own
  `versedb_fps*.json` / `versedb_missions.json` fetches.
- **Dynamic host (the DO droplet)** — reads `/api/db?mode=<mode>`
  which calls `exportFullDb(mode)` in `api/db.js`. Response shape:

  ```ts
  {
    meta: DbMeta,
    ships: Ship[],
    items: Item[],
    miningLocations: [...],
    miningElements: [...],
    fpsItems: unknown[],         // weapons + magazines + attachments (tagged)
    fpsGear:  unknown[],
    fpsArmor: unknown[],
    missions: unknown[],         // contracts (className-keyed)
    missionRefs: {                // factions, ladders, givers, … (singleton blob)
      missionGivers, factions, contractorProfiles,
      reputationRanks, reputationLadders, reputationTiers,
      scopeToLadder,
    } | null,
  }
  ```

Every pipeline-backed component (FPS items, FPS loadout, missions view,
rep builder, blueprint finder, crafting view) prefers the DataService
payload when populated and falls back to HTTP JSON fetch otherwise. All
use a race-guard so a late-arriving JSON response can't clobber a
successful DB hydration.

This means preview *never* sees curated data, and prod *always*
sees it. Any time you change the JSON without running the admin
import, the preview will show the new values but prod will not.

---

## Extracting a fresh build

When CIG ships a new build, run the extractors in this order against
the `SC FILES/sc_data_forge_live` forge dump + `sc_data_xml_live`
localization dump. All extractors default to `--target live`; use
`--target ptu` for the PTU branch.

```bash
# From the repo root.
python3 "PY SCRIPTS/versedb_extract.py"           --target live
python3 "PY SCRIPTS/extract_fps_weapons.py"       --target live
python3 "PY SCRIPTS/extract_fps_gear.py"          --target live
python3 "PY SCRIPTS/extract_fps_armor.py"         --target live
# Missions extractor is part of versedb_extract.py — no separate step.
```

Outputs land at `app/public/live/`:

- `versedb_data.json` — ships + items + meta + mining locations/elements
- `versedb_fps.json` — `{ meta, weapons, magazines, attachments }`
- `versedb_fps_gear.json` — `{ meta, items }`
- `versedb_fps_armor.json` — `{ meta, armor }`
- `versedb_missions.json` — `{ meta, contracts, missionGivers, factions, contractorProfiles, reputationRanks, reputationLadders, reputationTiers, scopeToLadder }`

At this point the preview deployment will pick up the new data on next
reload. Prod still serves whatever is in the DB.

---

## Building the merged payload

The admin diff UI accepts **one** JSON file per upload, so every
import goes through the merge helper. It stitches the raw extractor
outputs (`versedb_data.json` + the three FPS files +
`versedb_missions.json`) into a single blob the diff engine
understands:

```bash
python3 "PY SCRIPTS/merge_build_payload.py" --target live
```

**Re-run the merge script any time an extractor re-runs.** The merged
file is a regenerable artifact — it's committed alongside the other
`app/public/live/*.json` extractor outputs purely so the preview
deployment has a consistent snapshot, not because it's authoritative.
Authoritative source is always the individual extractor JSONs + the
DB.

### What the script does internally

- Ships + items flow through unchanged from `versedb_data.json`.
- FPS weapons, magazines, and attachments are flattened into a
  single `fpsItems[]` array with each record stamped `_kind:
  'weapon' | 'magazine' | 'attachment'`. This is why you can't just
  upload `versedb_fps.json` directly — the diff engine needs a flat
  className-keyed array, not three sub-arrays.
- FPS gear and armor pass through as-is.
- Missions split: `contracts[]` becomes `missions[]` (diffable);
  everything else (`missionGivers`, `factions`, `reputationLadders`,
  `reputationRanks`, `reputationTiers`, `contractorProfiles`,
  `scopeToLadder`) bundles into `missionRefs` (singleton blob,
  overwritten wholesale like `meta`).
- The top-level `meta` blob is promoted from whichever extractor
  output has one (they all ship the same game version).

Output: `app/public/live/versedb_merged.json` with shape:

```json
{
  "meta":        { "version": "...", "shipCount": 200, ... },
  "ships":       [ ... ],
  "items":       [ ... ],
  "fpsItems":    [ /* weapons + mags + attachments, tagged with _kind */ ],
  "fpsGear":     [ ... ],
  "fpsArmor":    [ ... ],
  "missions":    [ /* contracts, className-keyed */ ],
  "missionRefs": { /* factions, ladders, givers, contractorProfiles, … */ }
}
```

You can also upload partial payloads — the diff engine only proposes
deletes for streams that are actually present in the uploaded JSON.
So a ships-only upload (`versedb_data.json` directly) will propose
ship/item changes and leave every other stream alone. FPS-only and
missions-only payloads work the same way (omit the streams you don't
want to touch).

### The `--out` flag

If you want the merged file somewhere other than `versedb_merged.json`
in the target dir:

```bash
python3 "PY SCRIPTS/merge_build_payload.py" --target live --out /tmp/4.8-import.json
```

---

## Importing into the database

1. Log into `/admin` (auth-gated).
2. Navigate to **Diff & Import Review**.
3. Choose the merged JSON file (or a raw single-stream file for a
   narrower review — `versedb_data.json` for ships/items, any FPS
   file, or `versedb_missions.json`).
4. Click **Compute Diff**.
5. Review the per-stream change lists. Each stream renders as its own
   section (Ships, Items, FPS Items, FPS Gear, FPS Armor, Missions).
   Filters on the top bar let you narrow by stream, action, or source.
6. Check/uncheck entities + individual fields. Defaults:
   - Non-curated creates + modifies: **checked**
   - Curated rows: **unchecked** (explicit opt-in required)
   - Deletes: **unchecked** (explicit opt-in required)
7. Click **Apply Selected**.

### What the apply does

- Opens one Postgres transaction.
- Walks every stream's selected changes in registry order (ships,
  items, fpsItems, fpsGear, fpsArmor, missions).
- For each change: `create` → INSERT; `modify` → merge selected
  fields into existing JSONB; `delete` → DELETE row.
- Writes one `audit_log` row per change.
- Overwrites the `meta` singleton row (version bump visible in the
  public header after reload).
- Overwrites the `mission_refs` singleton row when the upload supplied
  one (factions, ladders, etc. aren't diffable — always wholesale).
- Commits.
- Records one `changelog_entries` row summarizing the delta (post-
  commit, outside the transaction so a changelog failure can't roll
  back a successful apply).

---

## Atomic transaction semantics

All six entity streams commit inside a single `BEGIN...COMMIT`, along
with the `meta` and `mission_refs` singleton writes. This is the
critical guarantee that distinguishes the pipeline from a naive
per-stream refresh approach:

> Armor port types drive which items fit which slots. Attachment mods
> reference weapon ports. Missions reference faction ladders. If any
> stream lands without its cross-referenced partners, the app renders
> broken until the rest catches up.

With the atomic transaction, *any* failure anywhere in the apply step
rolls back the whole thing — you're back to exactly what was in the
DB before the import. Meta, ships, items, all three FPS tables, both
mission tables. Nothing half-applied.

The same holds if you select changes from some streams but not others.
The selected changes from every stream commit together.

---

## Curation protection

Each row has a `source` column:

- `extracted` — imported from the game. Next re-extract may overwrite it.
- `curated` — marked by an admin edit. The diff UI defaults curated
  rows to **unselected** so re-extraction never silently clobbers
  hand-curated values.

Rows become curated via:

- The admin editor (ship hardpoint editor, item editor) — any PATCH
  through `/api/admin/items/:className` or `/api/admin/ships/:className`
  flips the source. (See `ADMIN_EDITOR_GUIDE.md`.)
- Explicit curate endpoints — `POST /api/admin/items/:className/curate`.

For FPS + missions tables: no curate endpoints exist yet (pending —
those streams are currently 100% extracted). Adding one is a
three-line change mirroring the ship/item equivalent.

---

## Rollback procedure

If a bad import lands:

1. **If you haven't committed yet** — reject the diff UI's apply step
   by closing the modal or clicking Cancel on the confirm prompt.
   Nothing changes.
2. **If the apply ran but you don't like the result** — the easiest
   rollback is to **re-import the prior build**. Generate the merged
   payload from the last-known-good extract (either from git history
   of `app/public/live/versedb_merged.json` or by rerunning the
   extractors against the prior `SC FILES` dump), then run the import
   again. The curated rows are still protected.
3. **If a single entity is bad** — edit it via the admin editor. Its
   `source` flips to `curated`, making it resistant to the next
   import.
4. **Hard rollback (DB-level)** — the `changelog_entries` table
   captures a snapshot column per stream on every build import:
   `ship_snapshot`, `item_snapshot`, `fps_items_snapshot`,
   `fps_gear_snapshot`, `fps_armor_snapshot`, `missions_snapshot`,
   `mission_refs_snapshot`. Streams absent from a given import
   carry forward the prior row's snapshot byte-identical, so history
   is never destroyed by a partial import. You can restore by
   reading the desired snapshot and re-importing it — no canned
   "restore from changelog" button yet.

---

## When things go wrong

### Diff preview shows way more deletes than expected

Check that your merged payload actually contains the stream. The
diff engine only proposes deletes for streams that were present in
the upload — a missing `fpsGear` array means "don't touch FPS Gear,"
whereas an empty `fpsGear: []` array means "delete every FPS Gear row."

The merge script always writes all six arrays + missionRefs, so if
you see this pattern after uploading the merged file, double-check
the extractor outputs.

### Apply fails with `"entity not found in mode"`

A modify change referenced a className that doesn't exist in the DB.
Usually means the previous import's delete applied to this row but
the current import didn't re-create it. Re-run the diff — the missing
row should show up as a create now.

### FPS shows stale data after import

Hard-refresh the page. The service worker caches `/api/db` responses
for the preview deployment, and cache-busting only kicks in on the
next navigation. `Ctrl-Shift-R` on the affected page.

### Preview shows correct FPS but prod doesn't

You re-extracted but didn't import. That's the expected behavior of
the two-layer system. Run the import.

### `_kind` filtering shows empty weapons list

The merge script tags each weapon/mag/attachment with `_kind` before
flattening. If the DB has untagged entries (e.g., from a manually-
inserted row), they won't match any filter. Check
`SELECT DISTINCT (data->>'_kind') FROM fps_items` — any NULL rows
need their `_kind` added.

---

## Handing off to a future Claude session

If you're Claude being asked to help with a new build:

1. **Read this guide first.** Don't guess at the pipeline.
2. **Check the extractor outputs exist and are current** — timestamp
   on `app/public/live/versedb_*.json`. If they're stale, the
   extractors need to run before anything else.
3. **If the user asks for "a merged payload" or "the import file":**
   run `PY SCRIPTS/merge_build_payload.py --target live` and point
   them at `app/public/live/versedb_merged.json`. Under 500 words
   of instruction unless they ask for more.
4. **If the user reports "prod doesn't match preview":** assume
   unimported changes. Instruct the user to upload the merged payload
   through `/admin`. Don't try to directly SQL into the DB.
5. **If the user reports a pipeline bug:** read `api/server.js`
   around `DIFF_ENTITY_TYPES`, `api/db.js` around `exportFullDb` and
   `recordChangelogEntry`, then the diff-review component. The
   pipeline has two sides (preview + diff, and apply + changelog);
   know which side is broken before proposing a fix.
6. **If the user wants to add a new stream** (e.g., new mission
   table promotion, new blueprints table):
   - Add an entry to `DIFF_ENTITY_TYPES` in `api/server.js`.
   - Add a matching entry to `DIFF_STREAMS` in `admin.service.ts`.
   - Add a table to `schema.sql` with the same shape.
   - Add three lines to `exportFullDb` (one SELECT + one array in
     the return object).
   - Update the merge script to include the new stream.
   - Update this guide with the new stream + source file mapping.

### The single most important thing

**The JSON files are disposable. The DB is not.** Every admin action
on the DB is audited. Every admin import generates a changelog entry.
The extractor can be re-run anytime. The DB can't be rebuilt from
scratch without losing curated values.

Treat the DB with care. The rest is reproducible.

---
name: extraction-pipeline
description: Run the full VerseTools data extraction pipeline. Use when new Star Citizen game files (Data.p4k) are available and data needs to be re-extracted, or when the user says "run the pipeline", "extract data", "new files uploaded", or "update the data".
allowed-tools: Bash, Read, Write, Grep, Glob
---

# VerseTools Data Extraction Pipeline

This skill runs the complete data extraction pipeline for VerseTools. It extracts all game data from Star Citizen's Data.p4k file and prepares it for the web app.

## When to use

- User says "new files uploaded", "run the pipeline", "extract data", "update the data"
- A new Star Citizen patch has dropped (LIVE or PTU)
- User has placed new Data.p4k and build_manifest.id files

## Prerequisites

Before running, verify:
1. `unp4k` is on PATH: `which unp4k`
2. Data.p4k exists at the expected location
3. Python 3.10+ is available

## File Locations

```
Source files:
  /home/bryan/projects/SC Raw Data/LIVE/Data.p4k
  /home/bryan/projects/SC Raw Data/LIVE/build_manifest.id
  /home/bryan/projects/SC Raw Data/PTU/Data.p4k        (if PTU)
  /home/bryan/projects/SC Raw Data/PTU/build_manifest.id (if PTU)

Intermediate extraction (auto-managed):
  /home/bryan/projects/versedb/SC FILES/sc_data_xml_live/
  /home/bryan/projects/versedb/SC FILES/sc_data_live/
  /home/bryan/projects/versedb/SC FILES/sc_data_forge_live/

Output files:
  app/public/live/versedb_data.json        (ships, components, mining)
  app/public/live/versedb_missions.json    (contracts/missions)
  app/public/live/versedb_crafting.json    (crafting blueprints/recipes)
  app/public/live/versedb_fps.json         (FPS weapons)
  app/public/live/versedb_fps_armor.json   (FPS armor)

Root copies (active data when PTU mode is off):
  app/public/versedb_data.json
  app/public/versedb_missions.json
  app/public/versedb_crafting.json
```

## Pipeline Steps

Run all commands from `/home/bryan/projects/versedb`.

### Step 1: Main Extraction (ships, components, loadouts, mining)

```bash
python3 "PY SCRIPTS/versedb_extract.py" --mode live
```

This is the longest step. It:
- Extracts from Data.p4k via unp4k (if intermediate dirs are missing or stale)
- Forges DCB into XML records
- Parses all vehicle XMLs, components, default loadouts, mining locations
- Applies variant filtering (HP_EXCLUSIONS) and enrichments
- Runs integrity checks (blocks output if known-good data is missing)
- Writes output non-interactively (no prompts)

Wait for the script to complete and the output file to be written before proceeding.

### Step 2: Missions Extraction

```bash
VERSEDB_DATA_MODE=live python3 "PY SCRIPTS/versedb_missions.py"
```

### Step 3: Crafting Extraction

```bash
VERSEDB_DATA_MODE=live python3 "PY SCRIPTS/crafting_extract.py"
```

### Step 4: FPS Weapons Extraction

```bash
python3 "PY SCRIPTS/extract_fps_weapons.py" --target live
```

The `--target` flag controls which forge tree the script reads.
Without it the script defaults to LIVE — running it in a PTU pipeline
without the flag silently extracts from the LIVE forge and drops any
PTU-only weapons/throwables (e.g. new grenades).

### Step 5: FPS Armor Extraction

```bash
python3 "PY SCRIPTS/extract_fps_armor.py" --target live
```

### Step 5b: FPS Gear / Items Extraction

Grenades, mines, deployables, multi-tools, medical and consumables.
Throwables (grenades) end up in BOTH this output AND in
`versedb_fps.json` — distinct surfaces in the UI: FPS Weapons DB
shows them as weapons; FPS Items / Throwable tab reads from this
file. Skipping this step means new throwables won't appear in the
Items tab even if they're correct in the Weapons tab.

```bash
python3 "PY SCRIPTS/extract_fps_gear.py" --target live
```

### Step 6: Copy to Root

The app reads from `app/public/` root when PTU mode is off. Copy LIVE data there:

```bash
cp app/public/live/versedb_data.json     app/public/versedb_data.json
cp app/public/live/versedb_missions.json app/public/versedb_missions.json
cp app/public/live/versedb_crafting.json  app/public/versedb_crafting.json
```

### Step 7: Verify

Start the dev server and spot-check:

```bash
cd /home/bryan/projects/versedb/app && npx ng serve --port 4200
```

Check: ship list loads, loadout works, DPS numbers reasonable, mining locations correct, missions load, crafting loads, FPS tabs load.

### Step 8: Commit and Deploy

```bash
cd /home/bryan/projects/versedb
git add app/public/
git commit -m "Update data files for SC <version>"
git push
```

Push to main triggers GitHub Actions → builds Angular app → deploys to GitHub Pages.
Deployment takes 2-3 minutes.

## PTU Builds

For PTU extraction, replace `live` with `ptu` in all commands:
- `--mode ptu` for versedb_extract.py
- `VERSEDB_DATA_MODE=ptu` for missions and crafting
- `--target ptu` for FPS weapons AND FPS armor (both scripts use the
  same flag)

To enable PTU mode on the live site, edit `app/public/config.json`:
```json
{ "ptuEnabled": true, "ptuLabel": "4.0.2 PTU" }
```

## Force Re-extraction

If intermediate data is corrupted or you want a clean start:

```bash
python3 "PY SCRIPTS/versedb_extract.py" --mode live --reextract
```

This deletes all intermediate directories and re-extracts everything from the p4k.

## Troubleshooting

- **"unp4k: command not found"** → Install unp4k, add to PATH
- **"Data.p4k not found"** → Check /home/bryan/projects/SC Raw Data/LIVE/Data.p4k exists (case-sensitive)
- **Integrity check failed** → The extractor refused to write. Fix the issue described in the error, then re-run.
- **Stale data after deploy** → Browser cache. Hard refresh (Ctrl+Shift+R). GitHub Pages CDN may take a few minutes.
- **Data looks wrong** → Check `git diff app/public/` to see changes. Restore with `git checkout -- app/public/` if needed.

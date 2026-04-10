---
name: baseline-system
description: Reference for the VerseTools extraction baseline system — how the baseline diff works, why fixes get lost, integrity checks, and how to safely run re-extractions. Use when running the extractor, debugging missing data, or understanding why a known fix disappeared.
allowed-tools: Read, Grep, Glob, Bash
---

# Baseline System

The extraction pipeline has a **baseline diff/merge** step that compares each new extraction against a saved snapshot. This is the #1 source of accidental data regressions.

## How It Works

### Files

| File | Purpose |
|------|---------|
| `PY SCRIPTS/versedb_baseline.json` | Saved snapshot of the last accepted extraction |
| `PY SCRIPTS/versedb_baseline_diff.py` | Diff engine that compares new vs saved |
| `PY SCRIPTS/versedb_extract.py` ~line 5750 | Calls `run_baseline_update()` after extraction |

### Flow

```
Extraction produces ship_list, item_list
        ↓
run_baseline_update() compares against versedb_baseline.json
        ↓
Auto-accepts: stat value changes (DPS, HP, speed, etc.)
        ↓
Prompts for review: structural changes (hardpoint add/remove, ship add/remove)
        ↓
  "y" = accept change, update baseline
  "n" = reject change, KEEP OLD BASELINE VALUE (overrides extraction)
  "q" = abort entirely, nothing written
        ↓
Returns final ship_list, item_list → written to JSON
```

### Critical Detail: "n" Overrides the Extractor

When you answer "n" to a removal, the baseline's version of that data is what gets written to the output JSON — **not** what the extractor produced. This means:

- If the extractor correctly removes a hardpoint (via `HP_EXCLUSIONS`), but the baseline still has it, answering "n" puts it back
- If the extractor adds a new field, but the baseline doesn't have it, answering "n" drops it

This is why fixes applied only in `HP_EXCLUSIONS` or extractor logic can be silently undone by baseline review.

## Why Fixes Get Lost

The typical failure mode:

1. A fix is applied (e.g., Aurora DM module shield added to baseline manually)
2. Someone re-runs the extractor for an unrelated reason
3. The baseline review shows "HARDPOINT REMOVED — RSI Aurora Mk II" because the extractor doesn't natively produce that hardpoint
4. User answers "y" thinking they're accepting a legitimate game change
5. The fix is gone from both the baseline and the output

### How to Prevent This

1. **Fix in the extractor, not the baseline** — If the extractor produces the correct data, the baseline diff won't flag it
2. **Integrity checks** — `INTEGRITY_CHECKS` list (search for it in `versedb_extract.py`) blocks output if known-good data is missing
3. **Curate in the admin panel** — Mark ships as curated so the DB won't accept changes without explicit review

## Integrity Checks

Located in `versedb_extract.py`, search for `INTEGRITY_CHECKS`. These run after the baseline merge but before writing output. If any check fails, the extractor refuses to write and prints what's wrong.

```python
INTEGRITY_CHECKS = [
    ("Aurora DM shield on module",
     lambda: _item_has_subport("rsi_aurora_mk2_module_missile", "hardpoint_shield_generator_back")),
    ("C2 lacks bridge turret",
     lambda: _ship_lacks_hp("crus_starlifter_c2", "hardpoint_bridge_remote_turret")),
    # ... more checks
]
```

**When you fix a data regression, always add an integrity check so it can't happen again.**

## Running the Extractor Safely

### Piping Answers

The extractor is interactive. To automate:

```bash
# Accept first 2 changes, reject the rest
printf 'y\ny\nn\nn\nn\nn\n' | python3 "PY SCRIPTS/versedb_extract.py"

# Reject all baseline changes (safe default)
yes "n" | python3 "PY SCRIPTS/versedb_extract.py"
```

### The Extractor Runs Twice

The script extracts for both LIVE and PTU in sequence. Each has its own baseline review round. When piping answers, account for both rounds.

### Reading the Review Output

```
[1] HARDPOINT REMOVED — Crusader C2 Hercules Starlifter
    hardpoint_bridge_remote_turret (Turret 6)
    Was: Size 5-5 Turret
    → Reject = keep hardpoint (likely scrape issue)
    → Accept = remove hardpoint (CIG removed it)
    Accept? (y/n/q):
```

- "REMOVED" means the extractor no longer produces this but the baseline has it
- "ADDED" means the extractor produces something new not in the baseline
- "CHANGED" means a structural field changed (flags, size, type)

## HP_EXCLUSIONS

The `HP_EXCLUSIONS` dict (search in `versedb_extract.py`) removes variant-specific hardpoints before the baseline step. This is applied during extraction, so the baseline never sees the excluded hardpoints. This is the correct place to filter shared-vehicle-XML hardpoints.

See the `variant-exclusions` skill for details.

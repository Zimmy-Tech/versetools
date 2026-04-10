---
name: baseline-system
description: "REMOVED: The baseline diff/merge system was deleted on 2026-04-10. The extractor now writes output directly with no interactive review. Data review happens in the admin panel diff/import flow. Integrity checks in the extractor are the safety net. See the data-flow and variant-exclusions skills instead."
allowed-tools: Read, Grep, Glob, Bash
---

# Baseline System — REMOVED

The interactive baseline diff/merge system (`versedb_baseline_diff.py` and `versedb_baseline.json`) was removed on 2026-04-10. It was a legacy gate from before the admin panel existed, and it repeatedly caused data regressions by undoing extractor fixes.

## What Replaced It

1. **Integrity checks** in `versedb_extract.py` (search for `INTEGRITY_CHECKS`) — hard assertions that block output if known-good data is missing. The extractor refuses to write if any check fails.

2. **Admin panel diff/import** — the human review step now happens when importing data to the production database, not during extraction. This gives field-level diffs, selective accept/reject, and an audit trail.

3. **Curation in the admin panel** — ships/items marked as curated in the database are protected from bulk overwrites.

## Current Extractor Behavior

The extractor runs non-interactively. No prompts, no baseline comparison. It:

1. Extracts from game files
2. Applies enrichments (armor, power, signatures, etc.)
3. Applies `HP_EXCLUSIONS` for variant filtering
4. Runs integrity checks (blocks output on failure)
5. Writes JSON output
6. Generates changelog by diffing against the previous extraction output

## Adding Safety Checks

When you fix a data regression, add an integrity check:

```python
INTEGRITY_CHECKS = [
    ("description of what must be true",
     lambda: _some_check_function()),
]
```

Available helpers: `_find_ship(cls)`, `_find_item(cls)`, `_ship_has_hp(cls, hp_id)`, `_ship_lacks_hp(cls, hp_id)`, `_item_has_subport(cls, sp_id)`, `_ship_hp_count(cls, id_fragment)`.

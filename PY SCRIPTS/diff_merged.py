"""
diff_merged.py — changelog generator

Diffs the current `versedb_merged.json` against its previous snapshot
(`versedb_merged_prev.json`) and prepends a new entry to
`versedb_changelog.json`. Covers every stream that the merged file
carries (ships + items + fpsItems + fpsGear + fpsArmor + missions +
missionRefs + meta), so any content change in any stream surfaces on
the /changelog page.

Design notes:
- The changelog file is hand-editable static JSON. This script only
  prepends new entries; existing entries are preserved byte-identical
  across runs. Safe to edit wording, merge duplicates, reorder, or
  delete noise between runs.
- Dedup key is (fromVersion, toVersion, contentHash). Same version
  pair + identical content delta → skip. Same version pair + DIFFERENT
  content delta (e.g. CIG reshipping under the same version string,
  like the 4.7.2 / NMP2 case) → new entry is written.
- Retention is unbounded; prune by hand if it gets long.
- Ship + item diffs drill into a whitelist of user-relevant fields to
  keep the signal-to-noise ratio high. FPS and mission streams emit
  coarse `{className, name}` change markers matching the app's
  DB-backed changelog shape — users see "which entities changed" and
  click through to the DB page for current values.

Usage:
    python3 diff_merged.py --target live    # default
    python3 diff_merged.py --target ptu
    python3 diff_merged.py --dry-run        # print entry, don't write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PUB = REPO_ROOT / "app" / "public"

# Fields we drill into for ship/item diffs. Keeping the whitelist tight
# means power-fluctuation noise from extraction-pipeline tweaks doesn't
# pollute the user-facing changelog. Mirrors the set previously
# embedded in versedb_extract.py.
TRACKED_FIELDS: dict[str, list[str]] = {
    "ship": [
        "mass", "hp", "cargoCapacity", "weaponPowerPoolSize",
        "thrusterPowerBars", "armorPhysical", "armorEnergy",
        "armorDistortion", "armorThermal",
    ],
    "WeaponGun": [
        "dps", "alphaDamage", "fireRate", "projectileSpeed", "range",
        "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
        "maxRegenPerSec", "powerDraw",
    ],
    "WeaponTachyon": [
        "dps", "alphaDamage", "fireRate", "projectileSpeed", "range",
        "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
        "maxRegenPerSec", "powerDraw",
    ],
    "TractorBeam": ["dps", "alphaDamage", "fireRate", "powerDraw"],
    "Shield": [
        "hp", "regenRate", "damagedRegenDelay", "downedRegenDelay",
        "resistPhysMax", "resistPhysMin", "resistEnrgMax", "resistEnrgMin",
        "resistDistMax", "resistDistMin",
    ],
    "PowerPlant": ["powerOutput"],
    "Cooler": ["coolingRate"],
    "QuantumDrive": ["speed", "spoolTime", "fuelRate"],
    "Radar": ["aimMin", "aimMax"],
    "MissileLauncher": ["missileSize", "capacity"],
    "Missile": ["alphaDamage", "speed", "lockTime", "lockRangeMax"],
}

# Maps item `type` → display category used by the /changelog page.
ITEM_TYPE_TO_CATEGORY: dict[str, str] = {
    "WeaponGun": "weapon",
    "WeaponTachyon": "weapon",
    "TractorBeam": "tractor",
    "Shield": "shield",
    "PowerPlant": "powerplant",
    "Cooler": "cooler",
    "QuantumDrive": "quantumdrive",
    "Radar": "radar",
    "Missile": "missile",
    "MissileLauncher": "missilelauncher",
    "BombLauncher": "missilelauncher",
}


def _item_category(item: dict) -> str:
    t = item.get("type", "")
    return ITEM_TYPE_TO_CATEGORY.get(t, t.lower() or "item")


def _fps_category(fps_item: dict) -> str:
    # versedb_merged.json tags every fpsItem with `_kind`
    # ('weapon' | 'magazine' | 'attachment'). Separating the three in
    # the changelog makes it easier to scan "which weapons changed".
    kind = fps_item.get("_kind", "")
    return f"fps_{kind}" if kind else "fps_item"


def _deep_diff(old: dict, new: dict, fields: list[str]) -> list[dict]:
    out = []
    for f in fields:
        ov, nv = old.get(f), new.get(f)
        if ov is None and nv is None:
            continue
        if ov != nv:
            out.append({"field": f, "old": ov, "new": nv})
    return out


def _diff_ship_item_stream(
    prev_list: list[dict],
    new_list: list[dict],
    *,
    is_ship: bool,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Field-level diff for ships/items. Tracked-field whitelist keeps
    noise out. Returns (changes, added, removed)."""
    prev_map = {e["className"]: e for e in prev_list if e.get("className")}
    new_map = {e["className"]: e for e in new_list if e.get("className")}
    changes, added, removed = [], [], []
    for key in sorted(set(prev_map) | set(new_map)):
        p, n = prev_map.get(key), new_map.get(key)
        if not p and n:
            cat = "ship" if is_ship else _item_category(n)
            added.append({"category": cat, "className": key, "name": n.get("name", key)})
            continue
        if p and not n:
            cat = "ship" if is_ship else _item_category(p)
            removed.append({"category": cat, "className": key, "name": p.get("name", key)})
            continue
        etype = "ship" if is_ship else n.get("type", "")
        fields = TRACKED_FIELDS.get(etype, [])
        if not fields:
            continue
        field_diffs = _deep_diff(p, n, fields)
        if field_diffs:
            cat = "ship" if is_ship else _item_category(n)
            changes.append({
                "category": cat,
                "className": key,
                "name": n.get("name", key),
                "fields": field_diffs,
            })
    return changes, added, removed


def _diff_shallow_stream(
    prev_list: list[dict],
    new_list: list[dict],
    *,
    category_fn,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Coarse className diff for FPS + missions. Matches
    diffFpsStreamForChangelog in api/db.js — signals "this entity
    changed" without field-level drill (the Items DB / Missions page
    shows current values directly).

    `category_fn(entity)` returns the display category per entry.
    """
    prev_map = {e["className"]: e for e in prev_list if e.get("className")}
    new_map = {e["className"]: e for e in new_list if e.get("className")}
    changes, added, removed = [], [], []
    for key in sorted(set(prev_map) | set(new_map)):
        p, n = prev_map.get(key), new_map.get(key)
        if not p and n:
            added.append({"category": category_fn(n), "className": key, "name": n.get("name", n.get("title", key))})
            continue
        if p and not n:
            removed.append({"category": category_fn(p), "className": key, "name": p.get("name", p.get("title", key))})
            continue
        # Shallow content compare — any field difference triggers a
        # "changed" entry. Stable key order so re-extracts with the
        # same content don't spuriously diff on dict ordering.
        if json.dumps(p, sort_keys=True) != json.dumps(n, sort_keys=True):
            changes.append({"category": category_fn(n), "className": key, "name": n.get("name", n.get("title", key))})
    return changes, added, removed


def _content_hash(entry: dict) -> str:
    # Hash the diff arrays (not the whole entry — exclude date/version).
    # Used as a dedup key so same-version-different-content reships
    # (e.g. NMP2) still generate a new changelog entry.
    key_fields = {k: entry[k] for k in ("changes", "added", "removed") if k in entry}
    return hashlib.sha256(json.dumps(key_fields, sort_keys=True).encode()).hexdigest()[:12]


def build_entry(prev_merged: dict, new_merged: dict) -> dict:
    """Compute the complete changelog entry from two merged snapshots."""
    changes, added, removed = [], [], []

    # Ships
    c, a, r = _diff_ship_item_stream(
        prev_merged.get("ships", []), new_merged.get("ships", []), is_ship=True,
    )
    changes += c; added += a; removed += r

    # Items (ship components)
    c, a, r = _diff_ship_item_stream(
        prev_merged.get("items", []), new_merged.get("items", []), is_ship=False,
    )
    changes += c; added += a; removed += r

    # FPS items (weapons + magazines + attachments, tagged by _kind)
    c, a, r = _diff_shallow_stream(
        prev_merged.get("fpsItems", []), new_merged.get("fpsItems", []),
        category_fn=_fps_category,
    )
    changes += c; added += a; removed += r

    # FPS gear
    c, a, r = _diff_shallow_stream(
        prev_merged.get("fpsGear", []), new_merged.get("fpsGear", []),
        category_fn=lambda _: "fps_gear",
    )
    changes += c; added += a; removed += r

    # FPS armor
    c, a, r = _diff_shallow_stream(
        prev_merged.get("fpsArmor", []), new_merged.get("fpsArmor", []),
        category_fn=lambda _: "fps_armor",
    )
    changes += c; added += a; removed += r

    # Missions (contracts)
    c, a, r = _diff_shallow_stream(
        prev_merged.get("missions", []), new_merged.get("missions", []),
        category_fn=lambda _: "mission",
    )
    changes += c; added += a; removed += r

    # Mission refs (singleton blob: factions, ladders, givers, etc.).
    # Emit a single synthetic "changed" marker if the blob differs.
    prev_refs = prev_merged.get("missionRefs") or {}
    new_refs = new_merged.get("missionRefs") or {}
    if json.dumps(prev_refs, sort_keys=True) != json.dumps(new_refs, sort_keys=True):
        changes.append({
            "category": "mission_refs",
            "className": "missionRefs",
            "name": "Mission reference data",
        })

    prev_version = (prev_merged.get("meta") or {}).get("version", "unknown")
    new_version = (new_merged.get("meta") or {}).get("version", "unknown")

    return {
        "fromVersion": prev_version,
        "toVersion": new_version,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "changes": changes,
        "added": added,
        "removed": removed,
    }


def main():
    parser = argparse.ArgumentParser(description="Diff merged.json against its previous snapshot and update versedb_changelog.json")
    parser.add_argument("--target", choices=["live", "ptu"], default="live")
    parser.add_argument("--dry-run", action="store_true", help="Print the entry without writing it")
    args = parser.parse_args()

    pub = APP_PUB / args.target
    merged_path = pub / "versedb_merged.json"
    prev_path = pub / "versedb_merged_prev.json"
    changelog_path = pub / "versedb_changelog.json"

    if not merged_path.exists():
        print(f"[diff_merged] {merged_path} not found — run merge_build_payload.py first", file=sys.stderr)
        sys.exit(1)

    if not prev_path.exists():
        # First run: no baseline, just snapshot and exit quietly. The
        # next extraction will have a prev to diff against.
        shutil.copy2(merged_path, prev_path)
        print(f"[diff_merged] baseline snapshot saved -> {prev_path.name} (no changelog entry on first run)")
        return

    with open(prev_path, encoding="utf-8") as f:
        prev_merged = json.load(f)
    with open(merged_path, encoding="utf-8") as f:
        new_merged = json.load(f)

    entry = build_entry(prev_merged, new_merged)

    # Short-circuit if nothing changed at all.
    if not entry["changes"] and not entry["added"] and not entry["removed"]:
        print(f"[diff_merged] no deltas between {entry['fromVersion']} and {entry['toVersion']} — no entry written")
        # Still refresh the snapshot so next run doesn't see a stale baseline.
        if not args.dry_run:
            shutil.copy2(merged_path, prev_path)
        return

    print(f"[diff_merged] {entry['fromVersion']} -> {entry['toVersion']}")
    print(f"  changes: {len(entry['changes'])}, added: {len(entry['added'])}, removed: {len(entry['removed'])}")

    if args.dry_run:
        print(json.dumps(entry, indent=2)[:2000])
        return

    # Load existing changelog (preserves hand-edits across runs).
    changelog = {"meta": {"generatedAt": "", "entries": 0}, "changelog": []}
    if changelog_path.exists():
        try:
            with open(changelog_path, encoding="utf-8") as f:
                changelog = json.load(f)
        except Exception as e:
            print(f"[diff_merged] warning: couldn't parse existing changelog ({e}); starting fresh")

    # Dedup by (fromVersion, toVersion, contentHash). Same-version
    # reships with different content produce a new entry; identical
    # content redundant runs skip.
    new_hash = _content_hash(entry)
    for existing in changelog["changelog"]:
        if (existing.get("fromVersion") == entry["fromVersion"]
                and existing.get("toVersion") == entry["toVersion"]
                and _content_hash(existing) == new_hash):
            print(f"[diff_merged] identical entry already present — skipping")
            shutil.copy2(merged_path, prev_path)
            return

    changelog["changelog"].insert(0, entry)
    changelog["meta"]["generatedAt"] = datetime.now(timezone.utc).isoformat()
    changelog["meta"]["entries"] = len(changelog["changelog"])

    with open(changelog_path, "w", encoding="utf-8") as f:
        json.dump(changelog, f, indent=2, ensure_ascii=False)
    print(f"[diff_merged] wrote entry to {changelog_path.name}")

    # Roll the snapshot forward for next time.
    shutil.copy2(merged_path, prev_path)


if __name__ == "__main__":
    main()

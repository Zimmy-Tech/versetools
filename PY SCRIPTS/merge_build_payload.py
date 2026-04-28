"""
merge_build_payload.py
======================

Combines the extractor outputs into ONE JSON file the admin diff/import
flow at `/admin` consumes. This is the "merged payload" the DB-backed
pipeline expects.

Input files (all under app/public/{live,ptu}/):
  - versedb_data.json       (ships + items, the main catalog)
  - versedb_fps.json        (FPS weapons + magazines + attachments)
  - versedb_fps_gear.json   (FPS gear: knives, consumables, tools, …)
  - versedb_fps_armor.json  (FPS armor pieces)
  - versedb_missions.json   (contracts + reference data: factions,
                             reputation ladders, mission givers, …)

Output: one JSON blob with:
  { meta, ships, items, fpsItems, fpsGear, fpsArmor,
    missions, missionRefs }

`fpsItems` is weapons + magazines + attachments flattened and tagged
with `_kind` ('weapon' | 'magazine' | 'attachment') so the Angular
components can split them back out when reading from the DB.
`fpsGear` and `fpsArmor` pass through as-is (each record already keys
on className). `missions` is the contracts array (className-keyed,
diffable); `missionRefs` is the non-entity reference data bundled
into one blob (overwritten wholesale on import like meta).

Usage:
  python3 "PY SCRIPTS/merge_build_payload.py" --target live
  python3 "PY SCRIPTS/merge_build_payload.py" --target live --out merged.json
"""

import argparse
import json
import sys
from pathlib import Path

_parser = argparse.ArgumentParser(description="Merge extractor outputs for admin diff/import")
_parser.add_argument("--target", choices=["live", "ptu"], default="live")
_parser.add_argument("--out", default=None, help="Output path (defaults to <target>/versedb_merged.json)")
_args = _parser.parse_args()

_BASE = Path(__file__).resolve().parent.parent
_PUB  = _BASE / "app" / "public" / _args.target

DATA_FILE     = _PUB / "versedb_data.json"
FPS_FILE      = _PUB / "versedb_fps.json"
GEAR_FILE     = _PUB / "versedb_fps_gear.json"
ARMOR_FILE    = _PUB / "versedb_fps_armor.json"
MISSIONS_FILE = _PUB / "versedb_missions.json"

OUT_FILE   = Path(_args.out) if _args.out else (_PUB / "versedb_merged.json")


def _load(path: Path) -> dict | None:
    if not path.exists():
        print(f"  WARN: missing {path.name}, skipping")
        return None
    with open(path) as f:
        return json.load(f)


def main() -> None:
    print("=" * 60); print(f"Build payload merge ({_args.target})"); print("=" * 60)

    data     = _load(DATA_FILE) or {}
    fps      = _load(FPS_FILE) or {}
    gear     = _load(GEAR_FILE) or {}
    armor    = _load(ARMOR_FILE) or {}
    missions = _load(MISSIONS_FILE) or {}

    # Tag weapons / mags / attachments with `_kind` so consumers can
    # split a flat fpsItems[] back into the shapes they expect. Each
    # record already has a unique className, so the tag is purely a
    # consumer hint — no effect on the diff engine's className-keyed
    # uniqueness check.
    fps_items: list = []
    for w in fps.get("weapons", []):
        fps_items.append({**w, "_kind": "weapon"})
    for m in fps.get("magazines", []):
        fps_items.append({**m, "_kind": "magazine"})
    for a in fps.get("attachments", []):
        fps_items.append({**a, "_kind": "attachment"})

    fps_gear  = list(gear.get("items", []))
    fps_armor = list(armor.get("armor", []))

    # Missions split into two pieces:
    #   contracts[] → className-keyed, rides the generic diff engine
    #   missionRefs → non-entity reference data (factions, ladders,
    #                 givers, contractor profiles, …) bundled into
    #                 one blob and overwritten wholesale on import.
    mission_contracts = list(missions.get("contracts", []))
    mission_refs = {
        k: missions[k] for k in (
            "missionGivers", "factions", "contractorProfiles",
            "reputationRanks", "reputationLadders", "reputationTiers",
            "scopeToLadder",
        ) if k in missions
    }

    # Share one meta blob across streams. Promote the most recent
    # meta.version we have — the extractors all write the same game
    # version, so any of them is fine.
    meta = (data.get("meta") or fps.get("meta") or gear.get("meta")
            or armor.get("meta") or missions.get("meta") or {})

    out = {
        "meta": meta,
        "ships": data.get("ships", []),
        "items": data.get("items", []),
        "fpsItems": fps_items,
        "fpsGear": fps_gear,
        "fpsArmor": fps_armor,
        "missions": mission_contracts,
        "missionRefs": mission_refs if mission_refs else None,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Snapshot the previous merged file as the changelog baseline BEFORE
    # we overwrite it. diff_merged.py reads this sibling to compute the
    # stream-wide delta after the new merged is written. Only snapshotted
    # when writing to the canonical location (the --out override is
    # treated as a side-channel and doesn't affect changelog state).
    is_canonical_out = (OUT_FILE == (_PUB / "versedb_merged.json"))
    if is_canonical_out and OUT_FILE.exists():
        import shutil
        shutil.copy2(OUT_FILE, _PUB / "versedb_merged_prev.json")

    with open(OUT_FILE, "w") as f:
        # Sorted keys → admin diff doesn't see insertion-order shuffles
        # as "every dict completely different." See versedb_extract.py
        # for the same fix on the upstream JSON.
        json.dump(out, f, indent=2, sort_keys=True)

    print(f"  ships:     {len(out['ships'])}")
    print(f"  items:     {len(out['items'])}")
    print(f"  fpsItems:  {len(out['fpsItems'])}  "
          f"(weapons={sum(1 for x in fps_items if x.get('_kind') == 'weapon')}, "
          f"mags={sum(1 for x in fps_items if x.get('_kind') == 'magazine')}, "
          f"attachments={sum(1 for x in fps_items if x.get('_kind') == 'attachment')})")
    print(f"  fpsGear:   {len(out['fpsGear'])}")
    print(f"  fpsArmor:  {len(out['fpsArmor'])}")
    print(f"  missions:  {len(out['missions'])}  (contracts)")
    print(f"  missionRefs: {'present' if out['missionRefs'] else 'none'}  "
          f"({len(mission_refs)} ref categories)")
    print()
    print(f"Wrote {OUT_FILE}")

    # Generate the changelog entry (diff current merged vs previous
    # snapshot). Skipped silently for non-canonical --out overrides,
    # since those are typically dry-runs or one-off exports.
    if is_canonical_out:
        import subprocess
        print()
        subprocess.run(
            [sys.executable, str(_BASE / "PY SCRIPTS" / "diff_merged.py"),
             "--target", _args.target],
            check=False,
        )


if __name__ == "__main__":
    main()

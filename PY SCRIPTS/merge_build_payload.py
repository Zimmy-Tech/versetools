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

Output: one JSON blob with:
  { meta, ships, items, fpsItems, fpsGear, fpsArmor }

`fpsItems` is weapons + magazines + attachments flattened and tagged
with `_kind` ('weapon' | 'magazine' | 'attachment') so the Angular
components can split them back out when reading from the DB.
`fpsGear` and `fpsArmor` pass through as-is (each record already keys
on className).

Usage:
  python3 "PY SCRIPTS/merge_build_payload.py" --target live
  python3 "PY SCRIPTS/merge_build_payload.py" --target live --out merged.json
"""

import argparse
import json
from pathlib import Path

_parser = argparse.ArgumentParser(description="Merge extractor outputs for admin diff/import")
_parser.add_argument("--target", choices=["live", "ptu"], default="live")
_parser.add_argument("--out", default=None, help="Output path (defaults to <target>/versedb_merged.json)")
_args = _parser.parse_args()

_BASE = Path(__file__).resolve().parent.parent
_PUB  = _BASE / "app" / "public" / _args.target

DATA_FILE  = _PUB / "versedb_data.json"
FPS_FILE   = _PUB / "versedb_fps.json"
GEAR_FILE  = _PUB / "versedb_fps_gear.json"
ARMOR_FILE = _PUB / "versedb_fps_armor.json"

OUT_FILE   = Path(_args.out) if _args.out else (_PUB / "versedb_merged.json")


def _load(path: Path) -> dict | None:
    if not path.exists():
        print(f"  WARN: missing {path.name}, skipping")
        return None
    with open(path) as f:
        return json.load(f)


def main() -> None:
    print("=" * 60); print(f"Build payload merge ({_args.target})"); print("=" * 60)

    data = _load(DATA_FILE) or {}
    fps  = _load(FPS_FILE) or {}
    gear = _load(GEAR_FILE) or {}
    armor = _load(ARMOR_FILE) or {}

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

    # Share one meta blob across streams. Promote the most recent
    # meta.version we have — the FPS extractors write the same game
    # version, so any of them is fine.
    meta = data.get("meta") or fps.get("meta") or gear.get("meta") or armor.get("meta") or {}

    out = {
        "meta": meta,
        "ships": data.get("ships", []),
        "items": data.get("items", []),
        "fpsItems": fps_items,
        "fpsGear": fps_gear,
        "fpsArmor": fps_armor,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(out, f, indent=2)

    print(f"  ships:     {len(out['ships'])}")
    print(f"  items:     {len(out['items'])}")
    print(f"  fpsItems:  {len(out['fpsItems'])}  "
          f"(weapons={sum(1 for x in fps_items if x.get('_kind') == 'weapon')}, "
          f"mags={sum(1 for x in fps_items if x.get('_kind') == 'magazine')}, "
          f"attachments={sum(1 for x in fps_items if x.get('_kind') == 'attachment')})")
    print(f"  fpsGear:   {len(out['fpsGear'])}")
    print(f"  fpsArmor:  {len(out['fpsArmor'])}")
    print()
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()

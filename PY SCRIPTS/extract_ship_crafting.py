"""
extract_ship_crafting.py — pull ship-component recipes from forge XMLs

Walks `crafting/blueprints/crafting/vehiclegear/<category>/` blueprint
records, resolves each blueprint's `entityClass` GUID to its target
item className (via the scitem entity records), and emits one
CraftingRecipe entry per blueprint into versedb_crafting.json's
existing `recipes` array.

The full DCB-binary crafting extractor (crafting_extract.py) handles
qualityModifiers + ingredient resource resolution by reading the
DCB binary directly. That parser breaks against tech-preview's
schema (DCB v8), so this script is a leaner XML-only fallback that
produces enough data for the frontend CRAFT/NO RECIPE button to
activate per-item — quality sliders and full ingredient details fill
in once the patch lands in LIVE (DCB v6) and the binary extractor
runs naturally.

Output recipe shape matches CraftingRecipe (see
quality-simulator.ts):
- className:        target item's className (so frontend can match by item.className)
- itemName:         display name of the target item
- category:         "ShipCooler", "ShipShield", "ShipPowerPlant", etc.
- subtype:          empty (full ingredient extraction adds this)
- tier:             0
- craftTimeSeconds: parsed from the blueprint's craftTime element
- ingredients:      []  (empty until binary extractor re-runs)

Usage:
    python3 extract_ship_crafting.py --target tech-preview
    python3 extract_ship_crafting.py --target live           # default

Idempotent — replaces any prior ship recipes in the output JSON,
preserves FPS recipes untouched.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SC_FILES = REPO_ROOT / "SC FILES"
APP_PUB = REPO_ROOT / "app" / "public"

# Map vehiclegear/<dirname> → display category. Mirrors the existing
# FPSWeapons/FPSArmours buckets the binary extractor produces; the
# `Ship` prefix keeps frontend filtering and DPS-panel routing
# unambiguous.
VEHICLEGEAR_CATEGORIES = {
    "cooler":       "ShipCooler",
    "shield":       "ShipShield",
    "powerplant":   "ShipPowerPlant",
    "radar":        "ShipRadar",
    "quantumdrive": "ShipQuantumDrive",
    "weapons":      "ShipWeapon",
    "mininglaser":  "ShipMiningLaser",
    "tractorbeam":  "ShipTractorBeam",
    "salvage":      "ShipSalvage",
}


def _read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def _parse_craft_time_seconds(blueprint_xml: str) -> int:
    """Sum the <TimeValue_Partitioned> attributes (days/hours/minutes/
    seconds) on the FIRST tier's craftTime block. Per-tier scaling is
    a future concern — the simulator only needs a base figure."""
    m = re.search(
        r'<craftTime>.*?<TimeValue_Partitioned\s+([^/>]+)/>',
        blueprint_xml, re.S,
    )
    if not m:
        return 0
    attrs = m.group(1)
    def attr(name: str) -> int:
        am = re.search(rf'\b{name}="(\d+)"', attrs)
        return int(am.group(1)) if am else 0
    return attr("days") * 86400 + attr("hours") * 3600 + attr("minutes") * 60 + attr("seconds")


def _build_guid_to_item(forge_dir: Path) -> dict[str, dict]:
    """Walk every entities/scitem record once, return
    { __ref GUID → {className, displayName?} } so blueprints can
    resolve their entityClass → item.

    Display name comes from the EntityClassDefinition's Localization
    label key when present, otherwise falls back to the className.
    The frontend doesn't strictly need a display name (it joins
    against item.className), but keeping one in the recipe JSON
    helps the binary-extractor's downstream merges and the eventual
    crafting-page browsing UI.
    """
    out: dict[str, dict] = {}
    scitem_dir = forge_dir / "entities" / "scitem"
    if not scitem_dir.exists():
        return out
    for f in scitem_dir.rglob("*.xml.xml"):
        txt = _read_text(f)
        if not txt:
            continue
        ref_m = re.search(r'__ref="([0-9a-f-]+)"', txt)
        if not ref_m:
            continue
        cls_m = re.search(r'<EntityClassDefinition\.([^\s"<>]+)', txt)
        if not cls_m:
            continue
        class_name = cls_m.group(1)
        # Best-effort display name from <Localization> within the entity record.
        name_m = re.search(r'<Localization\s+name="([^"]+)"', txt)
        out[ref_m.group(1)] = {
            "className": class_name,
            "locName": name_m.group(1) if name_m else None,
        }
    return out


def _load_localization(target: str) -> dict[str, str]:
    """Load global.ini so we can resolve @-keys to display strings."""
    loc = {}
    p = SC_FILES / f"sc_data_xml_{target}" / "Data" / "Localization" / "english" / "global.ini"
    if not p.exists():
        return loc
    with p.open(encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            if "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.split(",")[0].strip()
            loc[k.lower()] = v.strip()
    return loc


def _resolve_display(loc_key: str | None, loc: dict[str, str], fallback: str) -> str:
    if not loc_key:
        return fallback
    key = loc_key.lstrip("@").lower()
    val = loc.get(key)
    if val and not val.startswith("@"):
        return val
    return fallback


def _load_item_names(write_to: str) -> dict[str, str]:
    """Load className → display name from the destination's already-
    extracted versedb_data.json. The pipeline's main extractor has
    already resolved names through proper localization + manufacturer
    enrichment, so reusing those values is more reliable than
    re-resolving from entity XML Localization tags (which often hold
    placeholder strings like "@LOC_PLACEHOLDER" or the raw className)."""
    out: dict[str, str] = {}
    p = APP_PUB / write_to / "versedb_data.json"
    if not p.exists():
        return out
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
        for it in data.get("items") or []:
            cls = it.get("className")
            name = it.get("name")
            if cls and name:
                out[cls.lower()] = name
    except Exception:
        pass
    return out


def extract(target: str, write_to: str) -> list[dict]:
    forge_dir = SC_FILES / f"sc_data_forge_{target}" / "libs" / "foundry" / "records"
    bp_root = forge_dir / "crafting" / "blueprints" / "crafting" / "vehiclegear"
    if not bp_root.exists():
        print(f"[ship-craft] vehiclegear blueprints not found at {bp_root}")
        return []

    print(f"[ship-craft] scanning forge: {forge_dir}")
    print(f"[ship-craft] building scitem GUID map…")
    guid_to_item = _build_guid_to_item(forge_dir)
    print(f"  scitem records mapped: {len(guid_to_item):,}")

    item_names = _load_item_names(write_to)
    print(f"  live-item display names indexed: {len(item_names):,}")

    loc = _load_localization(target)
    print(f"  localization entries:  {len(loc):,}")

    recipes: list[dict] = []
    unresolved = 0
    by_category: dict[str, int] = {}

    for cat_dir in sorted(bp_root.iterdir()):
        if not cat_dir.is_dir():
            continue
        cat_name = cat_dir.name
        category = VEHICLEGEAR_CATEGORIES.get(cat_name, f"Ship{cat_name.title()}")
        for f in cat_dir.rglob("*.xml.xml"):
            txt = _read_text(f)
            if not txt:
                continue
            entity_m = re.search(
                r'<CraftingProcess_Creation\s+entityClass="([0-9a-f-]+)"',
                txt,
            )
            if not entity_m:
                continue
            target_guid = entity_m.group(1)
            item = guid_to_item.get(target_guid)
            if not item:
                unresolved += 1
                continue

            craft_time = _parse_craft_time_seconds(txt)
            class_lower = item["className"].lower()
            # Prefer the live items' resolved display name (e.g.
            # "Glacier") over the entity XML's Localization tag,
            # which is often a placeholder. Falls back through the
            # raw loc lookup, then the className as a last resort.
            display_name = (
                item_names.get(class_lower)
                or _resolve_display(item.get("locName"), loc, item["className"])
            )

            recipes.append({
                # Live item classNames are lowercase (e.g.
                # `cool_lplt_s02_fullfrost_scitem`), but the
                # EntityClassDefinition tag uses CIG's source-case
                # (`COOL_LPLT_S02_FullFrost_SCItem`). Normalize so
                # the frontend `r.className === item.className`
                # match succeeds.
                "className":        class_lower,
                "itemName":         display_name,
                "category":         category,
                "subtype":          "",
                "tier":             0,
                "craftTimeSeconds": craft_time,
                "ingredients":      [],
            })
            by_category[category] = by_category.get(category, 0) + 1

    print(f"\n[ship-craft] extracted {len(recipes)} recipes ({unresolved} unresolved GUIDs)")
    for cat, n in sorted(by_category.items(), key=lambda x: -x[1]):
        print(f"  {n:4}  {cat}")
    return recipes


def merge_into_crafting_json(target: str, ship_recipes: list[dict]) -> None:
    """Replace prior 'Ship*' category recipes in versedb_crafting.json
    with the freshly-extracted set. FPS rows are preserved verbatim
    so this script can be re-run without disturbing them.
    """
    out_path = APP_PUB / target / "versedb_crafting.json"
    if not out_path.exists():
        print(f"[ship-craft] {out_path} not found — aborting (run crafting_extract.py first)")
        return
    with out_path.open(encoding="utf-8") as f:
        bundle = json.load(f)

    existing = bundle.get("recipes") or []
    non_ship = [r for r in existing if not str(r.get("category", "")).startswith("Ship")]
    merged = non_ship + ship_recipes
    bundle["recipes"] = merged

    meta = bundle.setdefault("meta", {})
    meta["totalRecipes"] = len(merged)
    cats: dict[str, int] = {}
    for r in merged:
        c = r.get("category", "Unknown")
        cats[c] = cats.get(c, 0) + 1
    meta["categories"] = cats

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, ensure_ascii=False)
    print(f"\n[ship-craft] wrote {len(merged)} total recipes to {out_path}")
    print(f"  FPS preserved: {len(non_ship)},  Ship added: {len(ship_recipes)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="live", choices=["live", "ptu", "tech-preview"],
                        help="Forge dump to read blueprints from")
    parser.add_argument("--write-to", default=None, choices=["live", "ptu", "tech-preview"],
                        help="Where to write the merged versedb_crafting.json. "
                             "Defaults to --target. Useful today: --target tech-preview "
                             "--write-to live so the frontend (which reads live JSON) "
                             "sees ship recipes before CIG ships them.")
    args = parser.parse_args()
    write_to = args.write_to or args.target
    recipes = extract(args.target, write_to)
    if recipes:
        merge_into_crafting_json(write_to, recipes)


if __name__ == "__main__":
    main()

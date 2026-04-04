#!/usr/bin/env python3
"""Extract FPS armor data from Star Citizen forge files."""

import xml.etree.ElementTree as ET
import json, re, sys
from pathlib import Path
from collections import defaultdict

# ── Paths ──────────────────────────────────────────────────────────────────────
_SC = Path(__file__).parent / ".." / "SC FILES"
FORGE_DIR = _SC / "sc_data_forge/libs/foundry/records"
GLOBAL_INI = _SC / "sc_data_xml_live/Data/Localization/english/global.ini"
OUT_LIVE = Path(__file__).parent / ".." / "app/public/live/versedb_fps_armor.json"
OUT_PTU  = Path(__file__).parent / ".." / "app/public/ptu/versedb_fps_armor.json"

ARMOR_BASE = FORGE_DIR / "entities/scitem/characters/human/armor/pu_armor"
HELMET_BASE = FORGE_DIR / "entities/scitem/characters/human/starwear/helmet"
UNDERSUIT_BASE = ARMOR_BASE / "undersuit"

# Manufacturer UUID → name
MFR_MAP = {
    "5b97404f-d715-8a7b-08f6-93c50c0d2eb0": "Clark Defense Systems",
    "3b214046-d887-65a5-bec3-c7c0126918a7": "Behring",
    "eb2c462a-74bf-cf4a-d231-4c72f2f7789b": "Aegis Dynamics",
}

# Manufacturer prefix from className
MFR_PREFIX = {
    "cds": "Clark Defense Systems",
    "ccc": "CCC",
    "rsi": "RSI",
    "ksar": "Kastak Arms",
    "srvl": "Survival",
    "ovkl": "Overkill",
    "arma": "Arma",
    "trsm": "TrueSec",
    "aril": "Aril",
    "none": "Unknown",
    "sw": "Starwear",
}

# Skip patterns for skin/variant files
SKIP_PATTERN = re.compile(
    r'_(?:tint|mat|black|green|tan|luminalia|xenothreat|yellow|store|contestedzone|'
    r'iae\d|cc\d|invictus|lovestruck|shinsei|firerats|bis\d|citizencon|'
    r'showdown|fleetweek|fw_|gamemaster|collector|chrome|gold|silver|'
    r'valentine|halloween|subscriber|stpatricks|pirate|red\d|blue\d|'
    r'pink\d|white\d|orange\d|grey\d|opaque)\d*$',
    re.IGNORECASE
)


def load_localization(ini_path):
    loc = {}
    if not ini_path.exists():
        return loc
    with open(ini_path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            loc[key.strip().lower()] = val.strip()
    return loc


def resolve_name(loc, loc_key):
    """Resolve display name from localization key."""
    if not loc_key:
        return ""
    key = loc_key.lower().lstrip("@")
    val = loc.get(key, "")
    if val and not val.startswith("@") and not val.startswith("PH-"):
        return val
    # Try without PH- prefix
    ph_key = f"ph-{key}"
    val = loc.get(ph_key, "")
    if val:
        return val
    return ""


def get_damage_reduction(loc, loc_key):
    """Extract damage reduction % from localization description."""
    desc_key = loc_key.replace("item_Name_", "item_Desc_").replace("item_name_", "item_desc_")
    desc = loc.get(desc_key.lower(), "")
    if not desc:
        # Try shared desc
        parts = desc_key.rsplit("_", 1)
        if len(parts) == 2:
            shared_key = parts[0] + "_Shared"
            desc = loc.get(shared_key.lower(), "")
    m = re.search(r'Damage Reduction:\s*(\d+)%', desc)
    return int(m.group(1)) if m else None


def get_mfr(class_name):
    """Get manufacturer from className prefix."""
    prefix = class_name.split("_")[0].lower()
    return MFR_PREFIX.get(prefix, prefix.upper())


def is_skin_variant(stem):
    """Check if a file is a skin/paint variant."""
    # Strip the slot suffix to check the variant part
    return bool(SKIP_PATTERN.search(stem))


def parse_armor_piece(xml_path, loc, slot, weight):
    """Parse a single armor piece XML."""
    stem = xml_path.stem.replace(".xml", "")

    # Skip skin variants
    if is_skin_variant(stem):
        return None

    try:
        tree = ET.parse(xml_path)
    except ET.ParseError:
        return None

    root = tree.getroot()
    txt = ET.tostring(root, encoding='unicode')

    # Get localization name
    name_match = re.search(r'Name="@(item_[Nn]ame[^"]+)"', txt)
    loc_key = name_match.group(1) if name_match else ""
    display_name = resolve_name(loc, loc_key) if loc_key else ""

    if not display_name:
        return None  # Can't identify this piece

    # Get damage reduction from description
    dmg_reduction = get_damage_reduction(loc, loc_key) if loc_key else None

    # Temperature resistance
    min_temp = None
    max_temp = None
    m_min = re.search(r'MinResistance="(-?\d+)"', txt)
    m_max = re.search(r'MaxResistance="(-?\d+)"', txt)
    if m_min:
        min_temp = int(m_min.group(1))
    if m_max:
        max_temp = int(m_max.group(1))

    # Get manufacturer
    manufacturer = get_mfr(stem)

    # Determine armor set name (strip slot suffix)
    set_name = display_name
    for suffix in [" Arms", " Core", " Legs", " Helmet", " Backpack"]:
        if set_name.endswith(suffix):
            set_name = set_name[:-len(suffix)]
            break

    return {
        "className": stem,
        "name": display_name,
        "setName": set_name,
        "manufacturer": manufacturer,
        "weight": weight,  # light/medium/heavy
        "slot": slot,  # arms/core/legs/helmet/backpack
        "damageReduction": dmg_reduction,
        "tempMin": min_temp,
        "tempMax": max_temp,
    }


def main():
    print("Loading localization...")
    loc = load_localization(GLOBAL_INI)
    print(f"  {len(loc):,} entries")

    armor_pieces = []
    skipped = 0

    # Scan armor by weight/slot
    for weight in ["light", "medium", "heavy"]:
        for slot in ["arms", "core", "legs", "backpack"]:
            d = ARMOR_BASE / weight / slot
            if not d.exists():
                continue
            for xml_path in sorted(d.glob("*.xml*")):
                piece = parse_armor_piece(xml_path, loc, slot, weight)
                if piece:
                    armor_pieces.append(piece)
                else:
                    skipped += 1

    # Scan helmets
    for weight in ["light", "medium", "heavy"]:
        d = HELMET_BASE / weight
        if not d.exists():
            continue
        for xml_path in sorted(d.glob("*.xml*")):
            piece = parse_armor_piece(xml_path, loc, "helmet", weight)
            if piece:
                armor_pieces.append(piece)
            else:
                skipped += 1

    # Also check top-level helmet files
    for xml_path in sorted(HELMET_BASE.glob("sw_*.xml*")):
        # Determine weight from filename
        if "_heavy_" in xml_path.stem:
            w = "heavy"
        elif "_medium_" in xml_path.stem:
            w = "medium"
        else:
            w = "light"
        piece = parse_armor_piece(xml_path, loc, "helmet", w)
        if piece:
            armor_pieces.append(piece)
        else:
            skipped += 1

    # Scan undersuits
    for xml_path in sorted(UNDERSUIT_BASE.glob("*.xml*")):
        piece = parse_armor_piece(xml_path, loc, "undersuit", "undersuit")
        if piece:
            armor_pieces.append(piece)
        else:
            skipped += 1

    print(f"\nExtracted {len(armor_pieces)} armor pieces ({skipped} skipped)")

    # Stats
    from collections import Counter
    by_weight = Counter(p["weight"] for p in armor_pieces)
    by_slot = Counter(p["slot"] for p in armor_pieces)
    print("\nBy weight:")
    for w, c in sorted(by_weight.items()):
        print(f"  {w}: {c}")
    print("\nBy slot:")
    for s, c in sorted(by_slot.items()):
        print(f"  {s}: {c}")

    # Unique sets
    sets = defaultdict(list)
    for p in armor_pieces:
        sets[p["setName"]].append(p)
    print(f"\nUnique armor sets: {len(sets)}")

    # Output
    output = {
        "meta": {
            "totalPieces": len(armor_pieces),
            "uniqueSets": len(sets),
        },
        "armor": armor_pieces,
    }

    for out_path in [OUT_LIVE, OUT_PTU]:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(output, f, separators=(",", ":"))
        print(f"  Saved to {out_path}")


if __name__ == "__main__":
    main()

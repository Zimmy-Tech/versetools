#!/usr/bin/env python3
"""Extract FPS armor data from Star Citizen forge files."""

import xml.etree.ElementTree as ET
import json, re, sys
from pathlib import Path
from collections import defaultdict

# ── Target mode ──────────────────────────────────────────────────────────────
import argparse as _ap
_parser = _ap.ArgumentParser(description="Extract FPS armor data")
_parser.add_argument("--target", choices=["live", "ptu"], default="live", help="Target build (live or ptu)")
_args = _parser.parse_args()
_MODE = _args.target

# ── Paths ──────────────────────────────────────────────────────────────────────
_BASE = Path(__file__).resolve().parent.parent
_SC = _BASE / "SC FILES"

FORGE_DIR = _SC / f"sc_data_forge_{_MODE}" / "libs" / "foundry" / "records"
GLOBAL_INI = _SC / f"sc_data_xml_{_MODE}" / "Data" / "Localization" / "english" / "global.ini"
OUT_FILE = _BASE / "app" / "public" / _MODE / "versedb_fps_armor.json"

# Fallback: if mode-specific dirs don't exist, try generic (backward compat)
if not FORGE_DIR.exists():
    FORGE_DIR = _SC / "sc_data_forge" / "libs" / "foundry" / "records"
if not GLOBAL_INI.exists():
    GLOBAL_INI = _SC / "sc_data_xml_live" / "Data" / "Localization" / "english" / "global.ini"

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


def parse_ports(txt):
    """Extract SItemPortDef entries from an armor XML.

    Each port becomes: {name, displayName, minSize, maxSize, types[], flags, selectTag}.
    - types[] are the AttachDef Types accepted (WeaponPersonal, FPS_Consumable, etc.)
    - selectTag (from SItemPortDefExtensionFPS) hints at visual placement (backLeft,
      hipRight, chestFront, etc.) — useful for paper-doll anchor positioning.
    """
    ports = []
    for m in re.finditer(r'<SItemPortDef\s+([^>]+?)>(.*?)</SItemPortDef>', txt, re.DOTALL):
        attrs = m.group(1)
        body = m.group(2)

        def _a(n):
            mm = re.search(rf'(?<![A-Za-z]){n}="([^"]*)"', attrs)
            return mm.group(1) if mm else ""

        try:
            min_size = int(_a("MinSize") or 0)
            max_size = int(_a("MaxSize") or 0)
        except ValueError:
            min_size = max_size = 0

        # Dedup accepted types (game files sometimes list a type twice)
        raw_types = re.findall(r'<SItemPortDefTypes\s+Type="([^"]+)"', body)
        seen = set(); types = []
        for t in raw_types:
            if t not in seen:
                seen.add(t); types.append(t)

        select_tag = ""
        m_st = re.search(r'<SItemPortDefExtensionFPS[^>]*SelectTag="([^"]*)"', body)
        if m_st:
            select_tag = m_st.group(1)

        ports.append({
            "name": _a("Name"),
            "displayName": _a("DisplayName").lstrip("@"),
            "minSize": min_size,
            "maxSize": max_size,
            "types": types,
            "flags": _a("Flags"),
            "selectTag": select_tag,
        })
    return ports


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

    # Fallback: CIG sometimes ships entity files with @LOC_UNINITIALIZED
    # / @item_Name_… keys that have no localization entry yet (e.g. the
    # VGL flightsuits in 4.8 PTU). Rather than drop them, derive a
    # humanish label from the className so the row still appears.
    # Strip the trailing _NN_NN texture/color suffix (last two purely
    # numeric segments) so we keep the set number but lose the
    # variant indices.
    if not display_name:
        parts = stem.split("_")
        for _ in range(2):
            if parts and parts[-1].isdigit():
                parts.pop()
        if not parts:
            return None
        mfr_token = parts[0].upper()
        rest = " ".join(p.capitalize() for p in parts[1:])
        display_name = f"{mfr_token} {rest}".strip()
        if not display_name:
            return None

    # Get damage reduction from description
    dmg_reduction = get_damage_reduction(loc, loc_key) if loc_key else None

    # Default DR by weight if not found in description
    DEFAULT_DR = {"light": 20, "medium": 30, "heavy": 40, "undersuit": 10}
    if dmg_reduction is None:
        dmg_reduction = DEFAULT_DR.get(weight)

    # Temperature resistance
    min_temp = None
    max_temp = None
    m_min = re.search(r'MinResistance="(-?\d+)"', txt)
    m_max = re.search(r'MaxResistance="(-?\d+)"', txt)
    if m_min:
        min_temp = int(m_min.group(1))
    if m_max:
        max_temp = int(m_max.group(1))

    # Radiation protection from description
    radiation_protection = None
    radiation_scrub = None
    desc_key = loc_key.replace("item_Name_", "item_Desc_").replace("item_name_", "item_desc_").lower()
    desc = loc.get(desc_key, "")
    if not desc:
        # Try shared desc
        parts = desc_key.rsplit("_", 1)
        if len(parts) == 2:
            desc = loc.get(parts[0] + "_shared", "")
    m_rad = re.search(r'Radiation Protection:\s*([\d,]+)', desc)
    m_scrub = re.search(r'Radiation Scrub Rate:\s*([\d.]+)', desc)
    if m_rad:
        radiation_protection = int(m_rad.group(1).replace(",", ""))
    if m_scrub:
        radiation_scrub = float(m_scrub.group(1))

    # Carrying capacity from description
    carrying = None
    m_carry = re.search(r'Carrying Capacity:\s*([\d.]+)', desc)
    if m_carry:
        carrying = float(m_carry.group(1))

    # Damage resistance UUID (for future DCB per-type resistance lookup)
    dr_uuid = None
    m_dr = re.search(r'damageResistance="([0-9a-f-]+)"', txt, re.IGNORECASE)
    if m_dr:
        dr_uuid = m_dr.group(1)

    # Get manufacturer
    manufacturer = get_mfr(stem)

    # Determine armor set name: strip slot keyword and everything after it
    set_name = display_name
    for slot_word in [" Arms", " Core", " Legs", " Helmet", " Backpack", " Undersuit"]:
        idx = set_name.find(slot_word)
        if idx > 0:
            set_name = set_name[:idx].strip()
            break

    # Mass (loadout weight)
    mass = None
    m_mass = re.search(r'<SEntityRigidPhysicsControllerParams[^>]*Mass="([^"]+)"', txt)
    if m_mass:
        try: mass = float(m_mass.group(1))
        except ValueError: mass = None

    # G-force resistance — clothing/armor flight performance modifier.
    # Lives on SCItemClothingFlightParams. Positive = improves G
    # tolerance (flight suits); negative = restricts (heavy armor).
    # Per-piece values sum across the worn outfit (sign convention
    # observed from the data: -0.875…+0.975 range, halving sequence
    # on negatives strongly suggests additive composition).
    g_force = None
    m_g = re.search(r'gForceResistance="(-?[\d.]+)"', txt)
    if m_g:
        try: g_force = float(m_g.group(1))
        except ValueError: g_force = None

    # Port schema — drives the paper-doll slot layout + picker filters
    ports = parse_ports(txt)

    return {
        "className": stem,
        "name": display_name,
        "setName": set_name,
        "manufacturer": manufacturer,
        "weight": weight,
        "slot": slot,
        "damageReduction": dmg_reduction,
        "tempMin": min_temp,
        "tempMax": max_temp,
        "radiationProtection": radiation_protection,
        "radiationScrub": radiation_scrub,
        "carryingCapacity": carrying,
        "mass": round(mass, 4) if mass is not None else None,
        "gForceResistance": g_force,
        "ports": ports,
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

    # Inherit radiation/carrying from base pieces to color variants
    # Group by className prefix (strip trailing _XX color suffix)
    base_data = {}  # (weight, slot, base_prefix) -> {rad, scrub, carry}
    for p in armor_pieces:
        if p["radiationProtection"] is not None or p["carryingCapacity"] is not None:
            # Extract base prefix: e.g., "cds_armor_medium_core_01_01" from "cds_armor_medium_core_01_01_01"
            parts = p["className"].rsplit("_", 1)
            base_key = (p["weight"], p["slot"], parts[0])
            base_data[base_key] = {
                "rad": p["radiationProtection"],
                "scrub": p["radiationScrub"],
                "carry": p["carryingCapacity"],
            }

    inherited = 0
    for p in armor_pieces:
        if p["radiationProtection"] is None:
            parts = p["className"].rsplit("_", 1)
            base_key = (p["weight"], p["slot"], parts[0])
            if base_key in base_data:
                bd = base_data[base_key]
                p["radiationProtection"] = bd["rad"]
                p["radiationScrub"] = bd["scrub"]
                p["carryingCapacity"] = bd["carry"]
                inherited += 1

    print(f"\nExtracted {len(armor_pieces)} armor pieces ({skipped} skipped, {inherited} inherited stats)")

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

    # Group color variants under base pieces
    # Base name = everything up to and including the slot word (Arms/Core/Legs/Helmet/Backpack)
    from collections import OrderedDict
    grouped = OrderedDict()
    for p in armor_pieces:
        name = p["name"]
        base_name = name
        for slot_word in ["Arms", "Core", "Legs", "Helmet", "Backpack", "Undersuit"]:
            idx = name.find(slot_word)
            if idx >= 0:
                base_name = name[:idx + len(slot_word)]
                break

        key = (p["weight"], p["slot"], base_name)
        if key not in grouped:
            grouped[key] = {**p, "baseName": base_name, "variants": []}

        variant_suffix = name[len(base_name):].strip()
        if variant_suffix:
            grouped[key]["variants"].append(variant_suffix)
        # Use stats from whichever piece has them
        entry = grouped[key]
        if p["radiationProtection"] is not None and entry["radiationProtection"] is None:
            entry["radiationProtection"] = p["radiationProtection"]
            entry["radiationScrub"] = p["radiationScrub"]
        if p["carryingCapacity"] is not None and entry["carryingCapacity"] is None:
            entry["carryingCapacity"] = p["carryingCapacity"]

    base_pieces = list(grouped.values())
    print(f"  Base pieces (grouped): {len(base_pieces)} (from {len(armor_pieces)} total)")

    # ── Baseline protection: prevent armor from disappearing ──────────
    new_classes = {p["className"] for p in base_pieces}
    if OUT_FILE.exists():
        try:
            prev = json.loads(OUT_FILE.read_text())
            prev_armor = prev.get("armor", [])
            kept = 0
            for pa in prev_armor:
                if pa["className"] not in new_classes:
                    base_pieces.append(pa)
                    new_classes.add(pa["className"])
                    kept += 1
            if kept:
                print(f"  ⚠ Baseline protection: kept {kept} armor pieces that would have disappeared")
        except Exception:
            pass

    # Output
    output = {
        "meta": {
            "totalPieces": len(armor_pieces),
            "basePieces": len(base_pieces),
        },
        "armor": base_pieces,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, separators=(",", ":"))
    print(f"  Saved to {OUT_FILE} ({_MODE})")


if __name__ == "__main__":
    main()

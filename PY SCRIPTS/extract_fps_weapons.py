"""
extract_fps_weapons.py
======================
Extracts FPS weapon data from Star Citizen's forged DCB records and outputs
versedb_fps.json for the VerseDB app.

Usage:
  python3 extract_fps_weapons.py

Reads from:
  - Forged weapon XMLs:  SC FILES/sc_data_forge/libs/foundry/records/entities/scitem/weapons/fps_weapons/
  - Magazine XMLs:        SC FILES/sc_data_forge/libs/foundry/records/entities/scitem/weapons/magazines/
  - Ammo XMLs:            SC FILES/sc_data_forge/libs/foundry/records/ammoparams/fps/
  - DCB binary:           SC FILES/sc_data_forge.dcb  (for DamageInfo via BulletProjectileParams)
  - Localization:         SC FILES/sc_data_xml_live/Data/Localization/english/global.ini

Outputs to:
  - app/public/live/versedb_fps.json
  - app/public/ptu/versedb_fps.json
"""

import json
import os
import re
import struct
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

# ── Paths ────────────────────────────────────────────────────────────────────

_BASE = Path(__file__).resolve().parent.parent
_SC   = _BASE / "SC FILES"

FORGE_DIR    = _SC / "sc_data_forge" / "libs" / "foundry" / "records"
FPS_WPN_DIR  = FORGE_DIR / "entities" / "scitem" / "weapons" / "fps_weapons"
MAG_DIR      = FORGE_DIR / "entities" / "scitem" / "weapons" / "magazines"
AMMO_DIR     = FORGE_DIR / "ammoparams" / "fps"
DCB_FILE     = _SC / "sc_data" / "Data" / "Game2.dcb"
GLOBAL_INI   = _SC / "sc_data_xml_live" / "Data" / "Localization" / "english" / "global.ini"

OUT_LIVE = _BASE / "app" / "public" / "live" / "versedb_fps.json"
OUT_PTU  = _BASE / "app" / "public" / "ptu"  / "versedb_fps.json"

# ── Manufacturer prefix mapping ─────────────────────────────────────────────

MANUFACTURER_MAP = {
    "behr": "Behring",
    "gmni": "Gemini",
    "ksar": "Kastak Arms",
    "klwe": "Klaus & Werner",
    "volt": "Voltaire",
    "lbco": "Lightning Bolt Co.",
    "grin": "Greycat Industrial",
    "crlf": "Crusader",
    "kegr": "Klaus & Werner",
    "apar": "Apocalypse Arms",
    "none": "Unknown",
    "hdgw": "Hedgeway",
    "sasu": "Sakura Sun",
    "yorm": "Yormandi",
    "glsn": "Gallenson",
}

# ── Skin/variant skip patterns ──────────────────────────────────────────────

# Known base weapon classNames — anything not in this set that parses as WeaponPersonal
# gets checked against skip patterns. We build this set dynamically, but also have a
# hardcoded skip list for known variant patterns.
#
# Regex that matches variant suffixes anywhere in the stem.
# The pattern uses word-boundary-like logic: each variant keyword must be preceded by '_'.
SKIP_VARIANT_RE = re.compile(
    r'_(?:tint|mat|black|green|tan|luminalia|xenothreat|yellow|store|'
    r'contestedzone|300|firerats|collector|cen\d|imp\d|shin\d|blue|pink|red|white|'
    r'orange|grey|chrome|gold|silver|purple|arctic|urban|engraved|chromic|'
    r'acid|sunset|lumi|uee|camo|headhunters|spc|tow|reward|msn_rwd|prop|'
    r'ea_elim|brown|digi|iae\d{4}|cc\d{2}|optic_)'
)

SKIP_DIRS = ["dev"]

# Tools / non-weapon items to exclude
SKIP_CLASSNAMES = {
    "behr_binoculars_01",
    "grin_multitool_01", "grin_multitool_01_ai",
    "grin_multitool_01_default_charge_drain",
    "grin_multitool_01_default_cutter",
    "grin_multitool_01_default_cutter_ai",
    "grin_multitool_01_default_grapple",
    "grin_multitool_01_default_healing",
    "grin_multitool_01_default_mining",
    "grin_multitool_01_default_salvage_repair",
    "grin_multitool_01_default_tractorbeam",
    "grin_multitool_01_default_tractorbeam_maelstromtest",
    "grin_multitool_01_energy_placeholder",
    "grin_cutter_01",
    "grin_salvage_repair_01",
    "grin_tractor_01",
    "kegr_fire_extinguisher_01",
    "kegr_fire_extinguisher_01_igniter",
    "sasu_pistol_toy_01",
    "yormandi_weapon",
}

# ── Weapon type from className ───────────────────────────────────────────────

def classify_weapon_type(class_name: str) -> str:
    cn = class_name.lower()
    if "_pistol_" in cn:     return "Pistol"
    if "_rifle_" in cn:      return "Rifle"
    if "_smg_" in cn:        return "SMG"
    if "_shotgun_" in cn:    return "Shotgun"
    if "_sniper_" in cn:     return "Sniper"
    if "_lmg_" in cn:        return "LMG"
    if "_glauncher_" in cn:  return "Grenade Launcher"
    if "_railgun_" in cn:    return "Railgun"
    if "_medgun_" in cn:     return "Medical Tool"
    if "_special_" in cn:    return "Special"
    return "Unknown"


def classify_ammo_type(class_name: str, ammo_name: str = "") -> str:
    combined = (class_name + " " + ammo_name).lower()
    if "_energy_" in combined or "_laser_" in combined or "_plasma_" in combined or "_electron_" in combined:
        return "Energy"
    if "_thermal_" in combined:
        return "Thermal"
    return "Ballistic"


def get_manufacturer(class_name: str) -> str:
    prefix = class_name.split("_")[0].lower()
    return MANUFACTURER_MAP.get(prefix, prefix.upper())


def safe_float(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ── Localization ─────────────────────────────────────────────────────────────

def load_localization(ini_path: Path) -> dict:
    loc = {}
    if not ini_path.exists():
        print(f"  WARNING: localization file not found: {ini_path}")
        return loc
    with open(ini_path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#") and not line.startswith(";"):
                key, _, val = line.partition("=")
                loc[key.strip().lower()] = val.strip()
    print(f"  Loaded {len(loc)} localization entries")
    return loc


def resolve_name(loc: dict, class_name: str) -> str:
    key = f"item_name{class_name}".lower()
    name = loc.get(key, "")
    if name:
        # Strip trailing " Rifle", " Pistol", etc. from display name if desired
        return name
    return class_name


# ── Magazine index ───────────────────────────────────────────────────────────

def build_magazine_index(mag_dir: Path) -> dict:
    """Build map: weapon_tag -> (maxAmmoCount, ammoParamsRecord_guid)

    Prefer canonical magazine files (whose name matches {weapon}_mag) over
    other files that happen to share a tag (e.g. vlk_spewgun mags).
    """
    index = {}
    # Track which tags came from canonical mags so we don't overwrite them
    canonical_tags = set()
    if not mag_dir.exists():
        return index

    # Sort files so canonical mags (shorter names) are processed;
    # then process non-canonical only if tag not already claimed
    all_files = sorted(mag_dir.iterdir(), key=lambda p: len(p.name))

    for f in all_files:
        if not f.name.endswith(".xml.xml"):
            continue
        try:
            xml_text = f.read_text(errors="replace")
            stem = f.stem.replace(".xml", "").lower()

            # Get maxAmmoCount
            m_ammo = re.search(r'maxAmmoCount="(\d+)"', xml_text)
            if not m_ammo:
                continue
            max_ammo = int(m_ammo.group(1))

            # Get ammoParamsRecord GUID
            m_apr = re.search(r'ammoParamsRecord="([^"]+)"', xml_text)
            ammo_guid = m_apr.group(1) if m_apr else ""

            # Get weapon tag from AttachDef Tags
            m_tags = re.search(r'<AttachDef[^>]*Tags="([^"]+)"', xml_text)
            if m_tags:
                tags = m_tags.group(1).split()
                for t in tags:
                    # Skip generic tags
                    if t in ("stocked", "pistol", "rifle", "smg", "shotgun", "sniper", "lmg"):
                        continue
                    # Check if this is the canonical mag for this tag
                    is_canonical = stem == f"{t}_mag" or stem.startswith(f"{t}_mag")
                    if is_canonical:
                        index[t] = (max_ammo, ammo_guid)
                        canonical_tags.add(t)
                    elif t not in canonical_tags:
                        # Only set non-canonical if not already claimed
                        if t not in index:
                            index[t] = (max_ammo, ammo_guid)
        except Exception:
            pass
    return index


# ── Ammo index ───────────────────────────────────────────────────────────────

def build_ammo_index(ammo_dir: Path) -> dict:
    """Build map: ammo_stem -> {speed, lifetime, bpp_ref, bulletType}"""
    index = {}
    if not ammo_dir.exists():
        return index
    for f in ammo_dir.iterdir():
        if not f.name.endswith(".xml.xml"):
            continue
        try:
            xml_text = f.read_text(errors="replace")
            stem = f.stem.replace(".xml", "").lower()

            speed = 0.0
            lifetime = 0.0
            bpp_ref = ""
            bullet_type = ""

            m = re.search(r'speed="([^"]+)"', xml_text)
            if m:
                speed = safe_float(m.group(1))
            m = re.search(r'lifetime="([^"]+)"', xml_text)
            if m:
                lifetime = safe_float(m.group(1))
            m = re.search(r'projectileParams="BulletProjectileParams\[([0-9A-Fa-f]+)\]"', xml_text)
            if m:
                bpp_ref = m.group(1)
            m = re.search(r'bulletType="([^"]+)"', xml_text)
            if m:
                bullet_type = m.group(1)

            index[stem] = {
                "speed": speed,
                "lifetime": lifetime,
                "bpp_ref": bpp_ref,
                "bulletType": bullet_type,
            }
        except Exception:
            pass
    return index


def find_ammo_for_weapon(weapon_class: str, ammo_index: dict) -> dict | None:
    """Find matching ammo entry for a weapon className."""
    # Direct match: {weapon_class}_ammo_*
    for key, val in ammo_index.items():
        if key.startswith(weapon_class + "_ammo"):
            return val

    # Try base weapon name (strip _civilian etc.)
    base = re.sub(r'_civilian$', '', weapon_class)
    if base != weapon_class:
        for key, val in ammo_index.items():
            if key.startswith(base + "_ammo"):
                return val

    return None


# ── DCB binary damage lookup ────────────────────────────────────────────────

def _dcb_parse_header(d):
    """Minimal DCB header parser (same approach as versedb_extract.py)."""
    p = 4
    version = struct.unpack_from("<i", d, p)[0]; p += 4
    if version >= 6:
        p += 8
    n_structs, n_props, n_enums, n_mappings, n_records = [
        struct.unpack_from("<i", d, p + i * 4)[0] for i in range(5)
    ]
    p += 20
    counts = [struct.unpack_from("<i", d, p + i * 4)[0] for i in range(19)]; p += 76
    (c_bool, c_i8, c_i16, c_i32, c_i64, c_u8, c_u16, c_u32, c_u64, c_f32,
     c_f64, c_guid, c_str, c_loc, c_enum, c_strong, c_weak, c_ref, c_enum_opts) = counts
    text_len = struct.unpack_from("<I", d, p)[0]; p += 4
    blob_len = struct.unpack_from("<I", d, p)[0]; p += 4

    struct_defs = []
    for _ in range(n_structs):
        struct_defs.append((
            struct.unpack_from("<I", d, p)[0],
            struct.unpack_from("<I", d, p + 4)[0],
            struct.unpack_from("<H", d, p + 8)[0],
            struct.unpack_from("<H", d, p + 10)[0],
            struct.unpack_from("<I", d, p + 12)[0],
        ))
        p += 16
    prop_defs = []
    for _ in range(n_props):
        prop_defs.append((
            struct.unpack_from("<I", d, p)[0],
            struct.unpack_from("<H", d, p + 6)[0],
            struct.unpack_from("<H", d, p + 8)[0],
        ))
        p += 12
    p += n_enums * 8
    mappings = []
    for _ in range(n_mappings):
        mappings.append((
            struct.unpack_from("<I", d, p)[0],
            struct.unpack_from("<I", d, p + 4)[0],
        ))
        p += 8
    rec_start = p; p += n_records * 32
    va_f32 = (p + c_i8 + c_i16 * 2 + c_i32 * 4 + c_i64 * 8
              + c_u8 + c_u16 * 2 + c_u32 * 4 + c_u64 * 8 + c_bool)
    text_start = (va_f32 + c_f32 * 4 + c_f64 * 8 + c_guid * 16
                  + c_str * 4 + c_loc * 4 + c_enum * 4
                  + c_strong * 8 + c_weak * 8 + c_ref * 20 + c_enum_opts * 4)
    blob_start = text_start + text_len
    data_start = blob_start + blob_len

    def blob(off):
        q = blob_start + off
        return d[q:d.index(b'\x00', q)].decode('utf-8', 'replace')

    struct_by_name = {}
    for i, (name_off, _, _, _, _) in enumerate(struct_defs):
        try:
            struct_by_name[blob(name_off)] = i
        except Exception:
            pass

    struct_data = {}
    off = data_start
    for cnt, si in mappings:
        if si < len(struct_defs):
            struct_data[si] = (off, cnt)
            off += struct_defs[si][4] * cnt

    return {
        "d": d,
        "n_records": n_records, "rec_start": rec_start,
        "struct_by_name": struct_by_name, "struct_data": struct_data,
        "struct_defs": struct_defs,
        "blob_start": blob_start, "blob": blob,
    }


def build_damage_lookup(dcb_path: Path) -> dict:
    """Read DCB and build BPP hex index -> damage dict.

    Uses the same approach as versedb_extract.py:
      - AmmoParams records map to BulletProjectileParams instances
      - BPP instances contain DamageInfo pointers at bytes +16/+20
      - DamageInfo is 6 × f32 (24 bytes): physical, energy, distortion, thermal, biochemical, stun
    """
    if not dcb_path.exists():
        print(f"  WARNING: DCB file not found: {dcb_path}")
        return {}

    print(f"  Reading DCB: {dcb_path}")
    with open(dcb_path, "rb") as f:
        d = f.read()

    h = _dcb_parse_header(d)
    sd = h["struct_data"]
    sdefs = h["struct_defs"]

    def si(name):
        return h["struct_by_name"].get(name)

    def f32at(p):
        return struct.unpack_from("<f", d, p)[0]

    def u32at(p):
        return struct.unpack_from("<I", d, p)[0]

    def u16at(p):
        return struct.unpack_from("<H", d, p)[0]

    di_si = si("DamageInfo")
    bpp_si = si("BulletProjectileParams")

    if bpp_si is None or di_si is None:
        print("  WARNING: DamageInfo or BulletProjectileParams struct not found in DCB")
        return {}

    # Build BPP index -> damage map
    damage_map = {}  # hex_index_str -> damage_dict

    if bpp_si in sd and di_si in sd:
        b_off, b_cnt = sd[bpp_si]
        b_rs = sdefs[bpp_si][4]
        di_off, di_cnt = sd[di_si]

        for bpp_idx in range(b_cnt):
            inst = b_off + bpp_idx * b_rs
            ptr_si2 = u32at(inst + 16)
            ptr_ii2 = u32at(inst + 20)
            if ptr_si2 != di_si:
                continue
            if ptr_ii2 >= di_cnt:
                continue
            base = di_off + ptr_ii2 * 24
            v = struct.unpack_from("<6f", d, base)
            hex_key = format(bpp_idx, "04X")
            damage_map[hex_key] = {
                "physical":    round(v[0], 4),
                "energy":      round(v[1], 4),
                "distortion":  round(v[2], 4),
                "thermal":     round(v[3], 4),
                "biochemical": round(v[4], 4),
                "stun":        round(v[5], 4),
            }

    print(f"  BPP damage entries: {len(damage_map)}")

    # Build SProjectileLauncher pellet count map: hex_index -> pellet_count
    pellet_map = {}
    spl_si = si("SProjectileLauncher")
    if spl_si is not None and spl_si in sd:
        spl_off, spl_cnt = sd[spl_si]
        spl_rs = sdefs[spl_si][4]
        for spl_idx in range(spl_cnt):
            inst = spl_off + spl_idx * spl_rs
            pellets = u32at(inst + 12)
            if pellets > 1:
                hex_key = format(spl_idx, "04X")
                pellet_map[hex_key] = pellets
        print(f"  SPL pellet entries (>1): {len(pellet_map)}")

    # Build beam DPS map: hex_index -> damage_dict
    beam_map = {}
    beam_si = si("SWeaponActionFireBeamParams")
    if beam_si is not None and beam_si in sd and di_si in sd:
        beam_off, beam_cnt = sd[beam_si]
        beam_rs = sdefs[beam_si][4]
        di_off2, di_cnt2 = sd[di_si]
        for beam_idx in range(beam_cnt):
            inst = beam_off + beam_idx * beam_rs
            # DamageInfo pointer at bytes +94 (struct_idx u16) and +98 (instance_idx u16)
            try:
                ptr_si3 = u16at(inst + 94)
                ptr_ii3 = u16at(inst + 98)
                if ptr_si3 == di_si and ptr_ii3 < di_cnt2:
                    base = di_off2 + ptr_ii3 * 24
                    v = struct.unpack_from("<6f", d, base)
                    if any(vv > 0 for vv in v):
                        hex_key = format(beam_idx, "04X")
                        beam_map[hex_key] = {
                            "physical":    round(v[0], 4),
                            "energy":      round(v[1], 4),
                            "distortion":  round(v[2], 4),
                            "thermal":     round(v[3], 4),
                            "biochemical": round(v[4], 4),
                            "stun":        round(v[5], 4),
                        }
            except struct.error:
                pass
        print(f"  Beam DPS entries: {len(beam_map)}")

    return {"damage": damage_map, "pellets": pellet_map, "beam": beam_map}


# ── Main weapon parsing ──────────────────────────────────────────────────────

def is_skin_variant(filename: str) -> bool:
    """Return True if the filename looks like a skin/cosmetic variant."""
    stem = filename.replace(".xml.xml", "").lower()
    return bool(SKIP_VARIANT_RE.search(stem))


def parse_weapon_xml(xml_path: Path) -> dict | None:
    """Parse a single FPS weapon XML and extract key data."""
    try:
        xml_text = xml_path.read_text(errors="replace")
    except Exception:
        return None

    stem = xml_path.stem.replace(".xml", "").lower()

    # Extract AttachDef info
    m_attach = re.search(
        r'<AttachDef\s+Type="([^"]*)".*?SubType="([^"]*)".*?Size="([^"]*)"',
        xml_text
    )
    if not m_attach:
        return None

    attach_type = m_attach.group(1)
    sub_type = m_attach.group(2)
    size = int(m_attach.group(3)) if m_attach.group(3).isdigit() else 0

    # Only process WeaponPersonal items
    if attach_type != "WeaponPersonal":
        return None

    # Get localization key
    m_name = re.search(r'Name="(@item_Name[^"]+)"', xml_text)
    loc_key = m_name.group(1) if m_name else f"@item_Name{stem}"

    # Extract fire modes
    fire_modes = []
    fire_mode_pattern = re.compile(
        r'SWeaponActionFire(\w+)Params\b[^>]*name="([^"]*)"[^>]*fireRate="([^"]*)"'
    )
    for m in fire_mode_pattern.finditer(xml_text):
        mode_type = m.group(1)  # Single, Rapid, Burst, Charged
        mode_name = m.group(2)
        fire_rate = safe_float(m.group(3))
        fire_modes.append({
            "name": mode_name,
            "type": mode_type,
            "fireRate": fire_rate,
        })

    # Best fire rate
    best_fire_rate = max((fm["fireRate"] for fm in fire_modes), default=0)

    # Get ammoContainerRecord for magazine matching
    m_acr = re.search(r'ammoContainerRecord="([^"]+)"', xml_text)
    ammo_container_guid = m_acr.group(1) if m_acr else ""

    # Extract SProjectileLauncher refs (for pellet counts)
    spl_refs = re.findall(r'SProjectileLauncher\[([0-9A-Fa-f]+)\]', xml_text)

    # Extract SWeaponActionFireBeamParams refs (for beam DPS)
    beam_refs = re.findall(r'SWeaponActionFireBeamParams\[([0-9A-Fa-f]+)\]', xml_text)

    return {
        "className": stem,
        "locKey": loc_key.lstrip("@").lower(),
        "type": attach_type,
        "subType": sub_type,
        "size": size,
        "fireModes": fire_modes,
        "bestFireRate": best_fire_rate,
        "ammoContainerGuid": ammo_container_guid,
        "splRefs": spl_refs,
        "beamRefs": beam_refs,
    }


# ── Extraction pipeline ─────────────────────────────────────────────────────

def extract_fps_weapons():
    print("=" * 60)
    print("FPS Weapon Extraction")
    print("=" * 60)

    # 1. Load localization
    print("\n[1] Loading localization...")
    loc = load_localization(GLOBAL_INI)

    # 2. Build magazine index
    print("\n[2] Building magazine index...")
    mag_index = build_magazine_index(MAG_DIR)
    print(f"  Magazine entries: {len(mag_index)}")

    # 3. Build ammo index
    print("\n[3] Building ammo index...")
    ammo_index = build_ammo_index(AMMO_DIR)
    print(f"  Ammo entries: {len(ammo_index)}")

    # 4. Build DCB damage lookup
    print("\n[4] Building DCB damage lookup...")
    dcb_data = build_damage_lookup(DCB_FILE)
    damage_map = dcb_data.get("damage", {})
    pellet_map = dcb_data.get("pellets", {})
    beam_map = dcb_data.get("beam", {})

    # 5. Parse weapon XMLs
    print("\n[5] Parsing weapon XMLs...")
    weapons = []
    skipped = 0

    if not FPS_WPN_DIR.exists():
        print(f"  ERROR: Weapon directory not found: {FPS_WPN_DIR}")
        return

    for xml_file in sorted(FPS_WPN_DIR.iterdir()):
        if xml_file.is_dir():
            continue
        if not xml_file.name.endswith(".xml.xml"):
            continue

        stem = xml_file.stem.replace(".xml", "").lower()

        # Skip known non-weapons
        if stem in SKIP_CLASSNAMES:
            skipped += 1
            continue

        # Skip skin variants
        if is_skin_variant(xml_file.name):
            skipped += 1
            continue

        wpn = parse_weapon_xml(xml_file)
        if wpn is None:
            skipped += 1
            continue

        class_name = wpn["className"]

        # Resolve display name
        display_name = loc.get(wpn["locKey"], "")
        if not display_name:
            display_name = class_name

        # Determine weapon type and ammo type
        weapon_type = classify_weapon_type(class_name)

        # Find magazine
        mag_info = mag_index.get(class_name)
        if not mag_info:
            # Try base name without trailing _civilian etc.
            base = re.sub(r'_(civilian|ai)$', '', class_name)
            mag_info = mag_index.get(base)
        magazine_size = mag_info[0] if mag_info else 0

        # Find ammo data
        ammo_data = find_ammo_for_weapon(class_name, ammo_index)
        projectile_speed = ammo_data["speed"] if ammo_data else 0
        ammo_lifetime = ammo_data["lifetime"] if ammo_data else 0
        bpp_ref = ammo_data["bpp_ref"] if ammo_data else ""
        ammo_type = classify_ammo_type(class_name, "")

        # Manual BPP overrides for weapons whose ammo names don't match
        MANUAL_BPP = {
            "behr_glauncher_ballistic_01": "00A3",  # GP-33 grenade (40mm)
        }
        # Killshot: alternates 22 phys + 19 enrg per shot pair
        # Store per-shot average for DPS calc, full breakdown for display
        MANUAL_DAMAGE = {
            "none_rifle_multi_01": {"physical": 11.0, "energy": 9.5, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0},
            "apar_special_ballistic_01": {"physical": 6000.0, "energy": 0, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0},  # Scourge: 20 base × 300 charge mult
            "none_special_ballistic_01": {"physical": 1000.0, "energy": 0, "distortion": 0, "thermal": 500.0, "biochemical": 0, "stun": 0},  # Boomtube: explosion DamageInfo[0191]
        }
        # Anti-ship weapons (vs anti-personnel)
        ANTI_SHIP = {"apar_special_ballistic_01", "apar_special_ballistic_02", "none_special_ballistic_01"}
        if class_name in MANUAL_DAMAGE:
            damage = MANUAL_DAMAGE[class_name]
        else:
            if not bpp_ref and class_name in MANUAL_BPP:
                bpp_ref = MANUAL_BPP[class_name]

            # Look up damage from DCB
            damage = {"physical": 0, "energy": 0, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0}
            if bpp_ref:
                dcb_damage = damage_map.get(bpp_ref.upper())
                if dcb_damage:
                    damage = dcb_damage

        # Calculate alpha damage and DPS
        alpha_damage = round(sum(damage.values()), 4)
        fire_rate_rpm = wpn["bestFireRate"]

        # Fallback fire rates for weapons using charge/sequence/beam fire modes
        # These store fire rate in DCB-referenced structs, not inline XML
        FALLBACK_RATES = {
            "ksar_shotgun_energy_01": 60,       # Devastator - charged shotgun
            "ksar_shotgun_ballistic_01": 120,    # Ravager-212 - pump action
            "ksar_sniper_ballistic_01": 40,      # Scalpel - bolt action
            "klwe_smg_energy_01": 600,           # Lumin V - burst energy
            "klwe_sniper_energy_01": 60,         # Arrowhead - charged sniper
            "none_rifle_multi_01": 300,          # Killshot - semi-auto
            "none_shotgun_ballistic_01": 80,     # Deadrig - pump action
            "volt_shotgun_energy_01": 120,       # Prism - semi-auto energy
            "volt_sniper_energy_01": 45,         # Zenith - charged sniper
            "hdgw_pistol_ballistic_01": 120,     # Salvo Frag Pistol
            "apar_special_ballistic_01": 30,     # Scourge Railgun
            "apar_special_ballistic_02": 60,     # Animus Missile Launcher
        }
        # Beam weapons — continuous DPS, not RPM-based
        BEAM_WEAPONS = {
            "volt_rifle_energy_01",   # Parallax
            "volt_smg_energy_01",     # Quartz
            "volt_lmg_energy_01",     # Fresnel
            "none_smg_energy_01",     # Ripper
        }
        # Non-weapons to exclude
        EXCLUDE = {"crlf_medgun_01"}

        if class_name in EXCLUDE:
            skipped += 1
            continue

        is_beam = class_name in BEAM_WEAPONS
        if fire_rate_rpm == 0 and class_name in FALLBACK_RATES:
            fire_rate_rpm = FALLBACK_RATES[class_name]

        # Pellet count: multiply alpha by pellets for shotguns
        MANUAL_PELLETS = {
            "ksar_shotgun_ballistic_01": 8,    # Ravager-212
            "ksar_shotgun_energy_01": 12,      # Devastator
            "none_shotgun_ballistic_01": 8,    # Deadrig
            "volt_shotgun_energy_01": 8,       # Prism
        }
        pellet_count = MANUAL_PELLETS.get(class_name, 1)
        if pellet_count == 1:
            for spl_ref in wpn.get("splRefs", []):
                pc = pellet_map.get(spl_ref.upper(), 1)
                if pc > pellet_count:
                    pellet_count = pc
        if pellet_count > 1:
            alpha_damage = round(alpha_damage * pellet_count, 4)
            # Scale per-type damage too
            damage = {k: round(v * pellet_count, 4) for k, v in damage.items()}

        # Beam weapons: use beam DPS from DCB instead of projectile damage
        MANUAL_BEAM = {
            "volt_smg_energy_01": "0020",    # Quartz
            "none_smg_energy_01": "0021",    # Ripper
            "volt_lmg_energy_01": "0020",    # Fresnel (same beam profile as Quartz)
        }
        if is_beam:
            beam_ref = MANUAL_BEAM.get(class_name)
            if not beam_ref:
                beam_refs = wpn.get("beamRefs", [])
                beam_ref = beam_refs[0] if beam_refs else None
            if beam_ref:
                beam_dmg = beam_map.get(beam_ref.upper())
                if beam_dmg:
                    damage = beam_dmg
                    alpha_damage = round(sum(beam_dmg.values()), 4)

        dps = round(alpha_damage * fire_rate_rpm / 60, 2) if fire_rate_rpm > 0 and not is_beam else 0
        if is_beam and alpha_damage > 0:
            dps = alpha_damage  # For beams, alpha IS the DPS

        # Fire mode names
        fire_mode_names = [fm["type"] for fm in wpn["fireModes"]]
        if is_beam and "Beam" not in fire_mode_names:
            fire_mode_names.append("Beam")

        # Build output record
        record = {
            "className": class_name,
            "name": display_name,
            "manufacturer": get_manufacturer(class_name),
            "type": weapon_type,
            "subType": ammo_type,
            "size": wpn["size"],
            "fireRate": fire_rate_rpm,
            "fireModes": fire_mode_names,
            "magazineSize": magazine_size,
            "projectileSpeed": projectile_speed,
            "damage": damage,
            "alphaDamage": alpha_damage,
            "dps": dps,
            "pelletCount": pellet_count if pellet_count > 1 else None,
            "isBeam": is_beam or None,
            "category": "Anti-Ship" if class_name in ANTI_SHIP else "Anti-Personnel",
        }

        weapons.append(record)

    print(f"  Parsed: {len(weapons)} weapons, skipped: {skipped}")

    # Sort by manufacturer, then type, then name
    weapons.sort(key=lambda w: (w["manufacturer"], w["type"], w["name"]))

    # Read game version
    version = "unknown"
    try:
        manifest_path = Path("/home/bryan/projects/SC Raw Data/LIVE/build_manifest.id")
        if manifest_path.exists():
            data = json.loads(manifest_path.read_text())["Data"]
            branch = data.get("Branch", "")
            m = re.search(r"(\d+\.\d+\.\d+)", branch)
            version = m.group(1) if m else "unknown"
    except Exception:
        pass

    # Build output
    output = {
        "meta": {
            "count": len(weapons),
            "version": version,
        },
        "weapons": weapons,
    }

    # Write output
    print(f"\n[6] Writing output...")
    for out_path in [OUT_LIVE, OUT_PTU]:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(output, f, indent=2)
        print(f"  Written: {out_path}")

    print(f"\nDone! {len(weapons)} FPS weapons extracted.")

    # Print summary table
    print(f"\n{'Type':<20} {'Count':>5}")
    print("-" * 26)
    type_counts = {}
    for w in weapons:
        t = w["type"]
        type_counts[t] = type_counts.get(t, 0) + 1
    for t, c in sorted(type_counts.items()):
        print(f"  {t:<18} {c:>5}")

    # Print a few samples
    print(f"\nSample weapons:")
    for w in weapons[:5]:
        print(f"  {w['name']:<30} {w['type']:<12} {w['subType']:<10} "
              f"FR={w['fireRate']:<6} Mag={w['magazineSize']:<4} "
              f"Alpha={w['alphaDamage']:<8} DPS={w['dps']}")


if __name__ == "__main__":
    extract_fps_weapons()

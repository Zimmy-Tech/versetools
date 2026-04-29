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

# ── Target mode ──────────────────────────────────────────────────────────────

import argparse as _ap
_parser = _ap.ArgumentParser(description="Extract FPS weapon data")
_parser.add_argument("--target", choices=["live", "ptu"], default="live", help="Target build (live or ptu)")
_args = _parser.parse_args()
_MODE = _args.target

# ── Paths ────────────────────────────────────────────────────────────────────

_BASE = Path(__file__).resolve().parent.parent
_SC   = _BASE / "SC FILES"

FORGE_DIR    = _SC / f"sc_data_forge_{_MODE}" / "libs" / "foundry" / "records"
FPS_WPN_DIR  = FORGE_DIR / "entities" / "scitem" / "weapons" / "fps_weapons"
THROWABLE_DIR= FORGE_DIR / "entities" / "scitem" / "weapons" / "throwable"
MAG_DIR      = FORGE_DIR / "entities" / "scitem" / "weapons" / "magazines"
AMMO_DIR     = FORGE_DIR / "ammoparams" / "fps"
RECOIL_DIR   = FORGE_DIR / "weaponproceduralrecoil"
DCB_FILE     = _SC / f"sc_data_{_MODE}" / "Data" / "Game2.dcb"
GLOBAL_INI   = _SC / f"sc_data_xml_{_MODE}" / "Data" / "Localization" / "english" / "global.ini"

OUT_FILE = _BASE / "app" / "public" / _MODE / "versedb_fps.json"

# Fallback: if mode-specific dirs don't exist, try generic (backward compat)
if not FORGE_DIR.exists():
    FORGE_DIR = _SC / "sc_data_forge" / "libs" / "foundry" / "records"
    FPS_WPN_DIR = FORGE_DIR / "entities" / "scitem" / "weapons" / "fps_weapons"
    THROWABLE_DIR = FORGE_DIR / "entities" / "scitem" / "weapons" / "throwable"
    MAG_DIR = FORGE_DIR / "entities" / "scitem" / "weapons" / "magazines"
    AMMO_DIR = FORGE_DIR / "ammoparams" / "fps"
    RECOIL_DIR = FORGE_DIR / "weaponproceduralrecoil"
if not DCB_FILE.exists():
    DCB_FILE = _SC / "sc_data" / "Data" / "Game2.dcb"
if not GLOBAL_INI.exists():
    GLOBAL_INI = _SC / "sc_data_xml_live" / "Data" / "Localization" / "english" / "global.ini"

# ── Manufacturer prefix mapping ─────────────────────────────────────────────

# Manual display-name overrides for items that the game tags @LOC_PLACEHOLDER.
# Keyed by className; used as a fallback when the loc table has no entry.
MANUAL_NAMES: dict[str, str] = {
    # Orphan magazine — the Gallenson shotgun itself isn't in the weapons list
    # (upcoming content), so its mag has no parent, but the mag file exists.
    "glsn_shotgun_ballistic_01_mag":               "Gallenson Shotgun Magazine",
    # Underbarrel flashlights — internal, but can appear in loadouts.
    "weapon_underbarrel_light_narrow":             "Narrow Tactical Flashlight",
    "weapon_underbarrel_light_narrow_darkblue_01": "Narrow Tactical Flashlight (Dark Blue)",
    "weapon_underbarrel_light_wide":               "Wide Tactical Flashlight",
    "weapon_underbarrel_light_wide_darkblue_01":   "Wide Tactical Flashlight (Dark Blue)",
}

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
# Attachment-specific regex — same as weapons, but allows
# `contestedzonereward` (Tweaker) and `firerats0N` (Scorched) variants.
# Both have distinct stats on barrels/optics/underbarrels. Weapon-side
# variants of the same suffix are skin-only or broken stubs, so weapons
# keep them skipped.
SKIP_VARIANT_ATTACH_RE = re.compile(
    SKIP_VARIANT_RE.pattern.replace('contestedzone|', '', 1).replace('firerats|', '', 1)
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
    if "_gren_" in cn or "_grenade_" in cn: return "Grenade"
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
    """Load the localization INI.

    Some entries carry a grammatical suffix (e.g. ",P" for plural, ",F"/",M"
    for gendered languages) baked into the key. We strip those and prefer
    the plain-key value — that's what item lookups assume.
    """
    loc = {}
    if not ini_path.exists():
        print(f"  WARNING: localization file not found: {ini_path}")
        return loc
    with open(ini_path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith(("#", ";")):
                key, _, val = line.partition("=")
                key = key.strip().lower()
                # Drop a trailing grammatical tag: ",p", ",f", ",m" etc.
                base = re.sub(r",\w$", "", key)
                # Don't let a tagged entry overwrite a plain one if both exist.
                if base not in loc:
                    loc[base] = val.strip()
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

def build_magazine_index(mag_dir: Path) -> tuple[dict, list]:
    """Return (index, records).

    index: weapon_tag -> (maxAmmoCount, ammoParamsRecord_guid) — used for
           weapon-to-mag linkage. Prefers canonical mags ({weapon}_mag).
    records: list of magazine dicts for the Ammo/Mags tab, with className,
             locKey, weaponTag, ammoCount, mass, size, subType.
    """
    index = {}
    records: list[dict] = []
    canonical_tags = set()
    if not mag_dir.exists():
        return index, records

    all_files = sorted(mag_dir.iterdir(), key=lambda p: len(p.name))

    for f in all_files:
        if not f.name.endswith(".xml.xml"):
            continue
        try:
            xml_text = f.read_text(errors="replace")
            stem = f.stem.replace(".xml", "").lower()

            m_ammo = re.search(r'maxAmmoCount="(\d+)"', xml_text)
            if not m_ammo:
                continue
            max_ammo = int(m_ammo.group(1))

            m_apr = re.search(r'ammoParamsRecord="([^"]+)"', xml_text)
            ammo_guid = m_apr.group(1) if m_apr else ""

            # AttachDef: weapon tag + size + subtype + loc key
            weapon_tag = ""
            size = 0
            sub_type = ""
            m_attach = re.search(r'<AttachDef([^>]+?)>', xml_text)
            attach_type = ""
            if m_attach:
                attrs = m_attach.group(1)
                def _attr(name):
                    mm = re.search(rf'(?<![A-Za-z]){name}="([^"]*)"', attrs)
                    return mm.group(1) if mm else ""
                attach_type = _attr("Type")
                sub_type = _attr("SubType")
                try:
                    size = int(_attr("Size") or 0)
                except ValueError:
                    size = 0
                tags = _attr("Tags").split()
                for t in tags:
                    if t in ("stocked", "pistol", "rifle", "smg", "shotgun", "sniper", "lmg"):
                        continue
                    is_canonical = stem == f"{t}_mag" or stem.startswith(f"{t}_mag")
                    if is_canonical:
                        index[t] = (max_ammo, ammo_guid)
                        canonical_tags.add(t)
                        weapon_tag = t
                    elif t not in canonical_tags:
                        if t not in index:
                            index[t] = (max_ammo, ammo_guid)
                        if not weapon_tag:
                            weapon_tag = t
            else:
                attach_type = ""

            if attach_type and attach_type != "WeaponAttachment":
                continue

            # Mass from physics controller
            mass = 0.0
            m_mass = re.search(
                r'<SEntityRigidPhysicsControllerParams[^>]*Mass="([^"]+)"',
                xml_text,
            )
            if m_mass:
                mass = safe_float(m_mass.group(1))

            m_name = re.search(r'Name="(@item_Name[^"]+)"', xml_text)
            loc_key = m_name.group(1) if m_name else f"@item_Name{stem}"

            records.append({
                "className": stem,
                "locKey": loc_key.lstrip("@").lower(),
                "weaponTag": weapon_tag,
                "ammoCount": max_ammo,
                "mass": round(mass, 4),
                "size": size,
                "subType": sub_type,
            })
        except Exception:
            pass
    return index, records


# ── Ammo index ───────────────────────────────────────────────────────────────

def build_ammo_index(ammo_dir: Path) -> dict:
    """Build map: ammo_stem -> {speed, lifetime, bpp_ref, bulletType, damage}

    Damage is parsed from the inline <damage><DamageInfo .../></damage> element
    inside <projectileParams><BulletProjectileParams>. The StarBreaker forge
    inlines these (4.8+); older builds referenced BulletProjectileParams by DCB
    index and required the DCB damage_map fallback.
    """
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
            damage = None

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

            # Inline base damage: first <damage>...<DamageInfo .../>...</damage>
            # (NOT damageDropMinDistance / damageDropPerMeter etc.)
            dmg_block = re.search(r'<damage>\s*<DamageInfo\s+([^/]+?)/>', xml_text)
            if dmg_block:
                attrs = dmg_block.group(1)
                def _at(name):
                    mm = re.search(rf'{name}="([^"]+)"', attrs)
                    return safe_float(mm.group(1)) if mm else 0.0
                damage = {
                    "physical":    round(_at("DamagePhysical"),    4),
                    "energy":      round(_at("DamageEnergy"),      4),
                    "distortion":  round(_at("DamageDistortion"),  4),
                    "thermal":     round(_at("DamageThermal"),     4),
                    "biochemical": round(_at("DamageBiochemical"), 4),
                    "stun":        round(_at("DamageStun"),        4),
                }

            index[stem] = {
                "speed": speed,
                "lifetime": lifetime,
                "bpp_ref": bpp_ref,
                "bulletType": bullet_type,
                "damage": damage,
            }
        except Exception:
            pass
    return index


AMMO_ALIASES = {
    "behr_glauncher_ballistic_01": "behr_glauncher_ballistic_ammo_01_40mm",
}

def find_ammo_for_weapon(weapon_class: str, ammo_index: dict) -> dict | None:
    """Find matching ammo entry for a weapon className."""
    # Manual alias
    if weapon_class in AMMO_ALIASES:
        return ammo_index.get(AMMO_ALIASES[weapon_class])

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


# ── Recoil data lookup ─────────────────────────────────────────────────────

def build_recoil_index(recoil_dir: Path) -> dict:
    """Scan weaponproceduralrecoil XMLs and build weapon_class -> recoil values map.

    Each recoil XML contains curveAimRecoil with pitchMaxDegrees, yawMaxDegrees,
    recoilSmoothTime.  Multiple fire modes per weapon; we pick the one with the
    highest non-zero pitch (most representative for sustained fire).
    Files named {weapon_class}_{firemode}.xml.xml, possibly cross-listed under
    another weapon's directory.
    """
    index: dict[str, dict] = {}  # weapon_class -> {pitch, yaw, smooth}
    if not recoil_dir.exists():
        return index

    for subdir in sorted(recoil_dir.iterdir()):
        if not subdir.is_dir():
            continue
        if subdir.name in ("shiprecoil", "vehicleweapons", "test.xml.xml"):
            continue
        for xml_file in subdir.iterdir():
            if not xml_file.name.endswith(".xml.xml"):
                continue
            try:
                xml_text = xml_file.read_text(errors="replace")
                m_pitch = re.search(r'pitchMaxDegrees="([^"]+)"', xml_text)
                m_yaw = re.search(r'yawMaxDegrees="([^"]+)"', xml_text)
                m_smooth = re.search(r'recoilSmoothTime="([^"]+)"', xml_text)
                if not m_pitch:
                    continue
                pitch = safe_float(m_pitch.group(1))
                yaw = safe_float(m_yaw.group(1)) if m_yaw else 0.0
                smooth = safe_float(m_smooth.group(1)) if m_smooth else 0.0

                # Derive weapon className from filename by stripping fire-mode tokens
                # (tokens may appear anywhere in the stem, not just trailing — e.g.
                # "behr_sniper_ballistic_single_01" or "behr_rifle_ballistic_02_rapid_civilian").
                stem = xml_file.stem.replace(".xml", "").lower()
                # Longer compounds first so they win over their sub-tokens.
                weapon_class = re.sub(
                    r'_(?:single_post_heat|single_preheat|rapid_newrecoil|burst_altfire|'
                    r'ballistic_shot|energy_shot|single|rapid|burst|parallel|beam|preheat|newrecoil)',
                    '',
                    stem,
                )
                # Game-file typo: some recoil folders use "ballstic" instead of "ballistic".
                candidates = {weapon_class}
                if 'ballstic' in weapon_class:
                    candidates.add(weapon_class.replace('ballstic', 'ballistic'))

                # Keep the entry with highest pitch per weapon (most useful for comparison)
                if pitch != 0 or yaw != 0 or smooth != 0:
                    values = {
                        "recoilPitch": round(abs(pitch), 4),
                        "recoilYaw": round(abs(yaw), 4),
                        "recoilSmooth": round(smooth, 4),
                    }
                    for key in candidates:
                        existing = index.get(key)
                        if existing is None or abs(pitch) > abs(existing.get("recoilPitch", 0)):
                            index[key] = values
            except Exception:
                pass

    return index


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


def parse_weapon_ports(xml_text: str) -> list[dict]:
    """Pull attachment ports from a weapon XML.

    We emit {name, minSize, maxSize, requiredPortTags} per port.
    attachSlot is derived from the port name:
      magazine_attach → magazine, optics_attach → optics,
      barrel_attach → barrel, underbarrel_attach → underbarrel.
    item_grab and other housekeeping ports are skipped.
    """
    out = []
    for m in re.finditer(r'<SItemPortDef\s+([^>]+?)>', xml_text):
        attrs = m.group(1)
        def _a(n):
            mm = re.search(rf'(?<![A-Za-z]){n}="([^"]*)"', attrs)
            return mm.group(1) if mm else ""
        name = _a("Name")
        if not name or name == "item_grab" or not name.endswith("_attach"):
            continue
        slot_key = name.replace("_attach", "")   # magazine|optics|barrel|underbarrel
        try:
            min_s = int(_a("MinSize") or 0)
            max_s = int(_a("MaxSize") or 0)
        except ValueError:
            min_s = max_s = 0
        req = _a("RequiredPortTags")
        out.append({
            "name": name,
            "attachSlot": slot_key,
            "minSize": min_s,
            "maxSize": max_s,
            "requiredPortTags": req.split() if req else [],
        })
    return out


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

    # Sequence-driven fire rate fallback
    # Some weapons (Killshot, Ravager, Lumin V, ...) don't store fireRate
    # inline on the action struct — they use SWeaponSequenceEntryParams with
    # a delay/unit pair. When unit="RPM", that's the trigger-rate cap.
    #
    # IMPORTANT: only trust this when the sequence is homogeneous — i.e. every
    # entry is RPM-unit (multiple entries usually represent alt-fire modes
    # repeating the same cap). If any entry uses Seconds with a non-zero
    # delay, the sequence is a multi-step pipeline (e.g. Animus: 1s arming
    # wait → fire missile A → fire missile B), and the per-step delays
    # don't represent a sustained fire rate.
    seq_entries = []
    seq_homogeneous = True
    for m in re.finditer(
        r'<SWeaponSequenceEntryParams\b[^/>]*delay="([^"]*)"[^/>]*unit="([^"]*)"',
        xml_text,
    ):
        delay = safe_float(m.group(1))
        unit = m.group(2)
        seq_entries.append((delay, unit))
        if unit == "Seconds" and delay > 0:
            seq_homogeneous = False
    seq_max_rpm = 0
    if seq_homogeneous:
        rpms = [d for d, u in seq_entries if u == "RPM" and d > 0]
        seq_max_rpm = max(rpms, default=0)

    # Charge-weapon fire rate fallback
    # Charged weapons (Devastator, Zenith, Salvo, Arrowhead, Scourge) store
    # chargeTime + cooldownTime on SWeaponActionFireChargedParams. Effective
    # max RPM = 60 / (chargeTime + cooldownTime).
    # Note: must require a space before "chargeTime" so we don't match the
    # substring inside "overchargeTime" / "overchargedTime", which appear
    # earlier in the same struct.
    charge_rpm = 0
    m_ch = re.search(
        r'<SWeaponActionFireChargedParams\b[^/>]* chargeTime="([^"]*)"[^/>]* cooldownTime="([^"]*)"',
        xml_text,
    )
    if m_ch:
        ct = safe_float(m_ch.group(1))
        cd = safe_float(m_ch.group(2))
        cycle = ct + cd
        if cycle > 0:
            charge_rpm = round(60.0 / cycle, 2)

    # Get ammoContainerRecord for magazine matching
    m_acr = re.search(r'ammoContainerRecord="([^"]+)"', xml_text)
    ammo_container_guid = m_acr.group(1) if m_acr else ""

    # Mass from physics controller
    mass = 0.0
    m_mass = re.search(
        r'<SEntityRigidPhysicsControllerParams[^>]*Mass="([^"]+)"',
        xml_text,
    )
    if m_mass:
        mass = safe_float(m_mass.group(1))

    # Extract SProjectileLauncher refs (for pellet counts, legacy DCB format)
    spl_refs = re.findall(r'SProjectileLauncher\[([0-9A-Fa-f]+)\]', xml_text)

    # Inline pellet count (StarBreaker forge, 4.8+): SProjectileLauncher element
    # with a pelletCount="N" attribute. Take the max across all inline launchers
    # to catch the primary fire-path value (polymorphic blocks may have more).
    inline_pellet_count = 0
    for m in re.finditer(r'<SProjectileLauncher\s+([^>]+)>', xml_text):
        attrs = m.group(1)
        pc_m = re.search(r'pelletCount="([0-9]+)"', attrs)
        if pc_m:
            pc = int(pc_m.group(1))
            if pc > inline_pellet_count:
                inline_pellet_count = pc

    # Extract SWeaponActionFireBeamParams refs (for beam DPS, legacy DCB format)
    beam_refs = re.findall(r'SWeaponActionFireBeamParams\[([0-9A-Fa-f]+)\]', xml_text)

    # Inline beam DPS (StarBreaker forge, 4.8+): <SWeaponActionFireBeamParams>
    # element with a nested <damagePerSecond><DamageInfo .../></damagePerSecond>.
    # Take the first one found.
    inline_beam_damage = None
    beam_block = re.search(
        r'<SWeaponActionFireBeamParams\b[^>]*>(.*?)</SWeaponActionFireBeamParams>',
        xml_text, re.DOTALL,
    )
    if beam_block:
        dps_m = re.search(
            r'<damagePerSecond>\s*<DamageInfo\s+([^/]+?)/>',
            beam_block.group(1),
        )
        if dps_m:
            attrs = dps_m.group(1)
            def _bat(name):
                mm = re.search(rf'{name}="([^"]+)"', attrs)
                return safe_float(mm.group(1)) if mm else 0.0
            inline_beam_damage = {
                "physical":    round(_bat("DamagePhysical"),    4),
                "energy":      round(_bat("DamageEnergy"),      4),
                "distortion":  round(_bat("DamageDistortion"),  4),
                "thermal":     round(_bat("DamageThermal"),     4),
                "biochemical": round(_bat("DamageBiochemical"), 4),
                "stun":        round(_bat("DamageStun"),        4),
            }
            if all(v == 0 for v in inline_beam_damage.values()):
                inline_beam_damage = None

    # ADS (aim-down-sights) parameters live on SWeaponActionAimSimpleParams.
    # A weapon can declare multiple aim actions (one per fire-mode bind in
    # most cases) but they typically share the same zoomTime/zoomScale —
    # take the first non-zero zoomTime as the canonical value.
    ads_time = 0.0
    ads_zoom_scale = 0.0
    for m in re.finditer(
        r'<SWeaponActionAimSimpleParams\b([^>]*)>',
        xml_text,
    ):
        attrs = m.group(1)
        zt = re.search(r'zoomTime="([^"]+)"', attrs)
        zs = re.search(r'zoomScale="([^"]+)"', attrs)
        ads_time = safe_float(zt.group(1)) if zt else 0.0
        ads_zoom_scale = safe_float(zs.group(1)) if zs else 0.0
        if ads_time > 0:
            break

    return {
        "className": stem,
        "locKey": loc_key.lstrip("@").lower(),
        "type": attach_type,
        "subType": sub_type,
        "size": size,
        "fireModes": fire_modes,
        "bestFireRate": best_fire_rate,
        "seqMaxRpm": seq_max_rpm,
        "seqEntries": len(seq_entries),
        "chargeRpm": charge_rpm,
        "ammoContainerGuid": ammo_container_guid,
        "splRefs": spl_refs,
        "inlinePelletCount": inline_pellet_count,
        "beamRefs": beam_refs,
        "inlineBeamDamage": inline_beam_damage,
        "mass": round(mass, 4),
        "adsTime": round(ads_time, 4),
        "adsZoomScale": round(ads_zoom_scale, 4),
        "ports": parse_weapon_ports(xml_text),
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
    mag_index, mag_records = build_magazine_index(MAG_DIR)
    print(f"  Magazine entries: {len(mag_index)} tags, {len(mag_records)} records")

    # 3. Build ammo index
    print("\n[3] Building ammo index...")
    ammo_index = build_ammo_index(AMMO_DIR)
    print(f"  Ammo entries: {len(ammo_index)}")

    # 4. Build recoil index
    print("\n[4] Building recoil index...")
    recoil_index = build_recoil_index(RECOIL_DIR)
    print(f"  Recoil entries: {len(recoil_index)}")

    # 5. Build DCB damage lookup
    print("\n[5] Building DCB damage lookup...")
    dcb_data = build_damage_lookup(DCB_FILE)
    damage_map = dcb_data.get("damage", {})
    pellet_map = dcb_data.get("pellets", {})
    beam_map = dcb_data.get("beam", {})

    # 6. Parse weapon XMLs
    print("\n[6] Parsing weapon XMLs...")
    weapons = []
    skipped = 0

    if not FPS_WPN_DIR.exists():
        print(f"  ERROR: Weapon directory not found: {FPS_WPN_DIR}")
        return

    # Weapons dir + throwables dir (grenades). Templates in throwable/ get
    # filtered out the same way by SKIP_CLASSNAMES.
    scan_dirs = [FPS_WPN_DIR]
    if THROWABLE_DIR.exists():
        scan_dirs.append(THROWABLE_DIR)

    all_files = []
    for d in scan_dirs:
        all_files.extend(sorted(d.iterdir()))

    for xml_file in all_files:
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

        # Template files
        if stem.endswith("_template"):
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
        # Manual magazine overrides for weapons whose mag tag doesn't match
        # the weapon class_name (e.g. tag is "..._rocket" not "...")
        MANUAL_MAG_SIZE = {
            "none_special_ballistic_01": 1,     # Boomtube: single rocket, tag=..._rocket
        }
        if magazine_size == 0 and class_name in MANUAL_MAG_SIZE:
            magazine_size = MANUAL_MAG_SIZE[class_name]

        # Find ammo data
        ammo_data = find_ammo_for_weapon(class_name, ammo_index)
        projectile_speed = ammo_data["speed"] if ammo_data else 0
        ammo_lifetime = ammo_data["lifetime"] if ammo_data else 0
        bpp_ref = ammo_data["bpp_ref"] if ammo_data else ""
        inline_damage = ammo_data.get("damage") if ammo_data else None
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
            "behr_glauncher_ballistic_01": {"physical": 15.5, "energy": 0, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0},  # GP-33: explosion damage, in-game tested
        }
        # Anti-ship weapons (vs anti-personnel)
        ANTI_SHIP = {"apar_special_ballistic_01", "apar_special_ballistic_02", "none_special_ballistic_01"}
        if class_name in MANUAL_DAMAGE:
            damage = MANUAL_DAMAGE[class_name]
        elif inline_damage and any(v > 0 for v in inline_damage.values()):
            # Preferred source: inline <damage><DamageInfo/> in the ammo XML
            # (StarBreaker forge format, 4.8+). Skip if all zeros so we fall
            # through to the DCB lookup for legacy builds.
            damage = inline_damage
        else:
            if not bpp_ref and class_name in MANUAL_BPP:
                bpp_ref = MANUAL_BPP[class_name]

            # Look up damage from DCB (legacy byte-indexed format)
            damage = {"physical": 0, "energy": 0, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0}
            if bpp_ref:
                dcb_damage = damage_map.get(bpp_ref.upper())
                if dcb_damage:
                    damage = dcb_damage

        # Calculate alpha damage and DPS
        alpha_damage = round(sum(damage.values()), 4)
        # Fire rate resolution order:
        #   1. Inline SWeaponActionFire(Single|Rapid|Burst)Params fireRate=
        #   2. SWeaponSequenceEntryParams delay/unit (RPM-unit entries)
        #   3. SWeaponActionFireChargedParams chargeTime+cooldownTime
        #   4. FALLBACK_RATES (last resort, see below)
        # is_charged is set when the rate came from path 3, so the UI can
        # label these "Charged" instead of just showing a low RPM number.
        fire_rate_rpm = wpn["bestFireRate"]
        is_charged = False
        if fire_rate_rpm == 0:
            fire_rate_rpm = wpn.get("seqMaxRpm", 0)
        if fire_rate_rpm == 0 and wpn.get("chargeRpm", 0) > 0:
            fire_rate_rpm = wpn["chargeRpm"]
            is_charged = True

        # Fallback fire rates for weapons whose action params are referenced
        # via DCB record handles that aren't inlined in the entity XML, and
        # which therefore can't be parsed without resolving the DCB record
        # table. Keep this list as small as possible — every entry here is
        # data we can't diff or correct via the admin panel.
        # Forced fire rate overrides — these replace whatever the extractor
        # parsed, because the raw value is misleading (e.g. single-shot
        # weapons whose real cycle time is dominated by reload animation).
        OVERRIDE_RATES = {
            "none_special_ballistic_01": 37,     # Boomtube - single-shot rocket, 1.5s
                                                 #   unstow reload + fire = ~1.62s cycle
                                                 #   = 37 effective RPM
            "ksar_sniper_ballistic_01": 40,      # Scalpel - bolt-action sniper. Inline
                                                 #   XML exposes a 600 RPM "Burst" mode
                                                 #   (2-round tap) that misrepresents
                                                 #   the sustained cycle; 40 RPM matches
                                                 #   in-game bolt-cycle behavior.
        }
        if class_name in OVERRIDE_RATES:
            fire_rate_rpm = OVERRIDE_RATES[class_name]

        FALLBACK_RATES = {
            "volt_shotgun_energy_01": 120,       # Prism - action params not inlined
        }
        # Beam weapons — continuous DPS, not RPM-based.
        # Parallax starts as a rifle and transitions to beam on overheat;
        # the beam is how it's primarily used, so we report beam DPS.
        BEAM_WEAPONS = {
            "volt_rifle_energy_01",   # Parallax (dual-mode, beam on overheat)
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
            # Inline pelletCount from weapon XML (4.8+ StarBreaker forge)
            ipc = wpn.get("inlinePelletCount", 0)
            if ipc > pellet_count:
                pellet_count = ipc
            # Legacy DCB SProjectileLauncher lookup
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
            beam_dmg = None
            # Preferred: inline <damagePerSecond> in the weapon XML (4.8+)
            inline_beam = wpn.get("inlineBeamDamage")
            if inline_beam:
                beam_dmg = inline_beam
            else:
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

        # Recoil data
        recoil = recoil_index.get(class_name)

        # Build output record
        record = {
            "className": class_name,
            "name": display_name,
            "manufacturer": get_manufacturer(class_name),
            "type": weapon_type,
            "subType": ammo_type,
            "size": wpn["size"],
            "fireRate": fire_rate_rpm,
            "isCharged": is_charged or None,
            "fireModes": fire_mode_names,
            "magazineSize": magazine_size,
            "projectileSpeed": projectile_speed,
            "range": round(projectile_speed * ammo_lifetime, 0) if projectile_speed and ammo_lifetime else 0,
            "damage": damage,
            "alphaDamage": alpha_damage,
            "dps": dps,
            "sequenceEntries": wpn.get("seqEntries", 0) if wpn.get("seqEntries", 0) >= 2 else None,
            "pelletCount": pellet_count if pellet_count > 1 else None,
            "isBeam": is_beam or None,
            "category": "Anti-Ship" if class_name in ANTI_SHIP else "Anti-Personnel",
            "mass": wpn.get("mass", 0),
            "adsTime": wpn.get("adsTime", 0),
            "adsZoomScale": wpn.get("adsZoomScale", 0),
            "ports": wpn.get("ports", []),
        }
        if recoil:
            record.update(recoil)

        weapons.append(record)

    print(f"  Parsed: {len(weapons)} weapons, skipped: {skipped}")

    # Sort by manufacturer, then type, then name
    weapons.sort(key=lambda w: (w["manufacturer"], w["type"], w["name"]))

    # Read game version
    version = "unknown"
    try:
        manifest_path = Path(f"/home/bryan/projects/SC Raw Data/{_MODE.upper()}/build_manifest.id")
        if manifest_path.exists():
            data = json.loads(manifest_path.read_text())["Data"]
            branch = data.get("Branch", "")
            m = re.search(r"(\d+\.\d+\.\d+)", branch)
            version = m.group(1) if m else "unknown"
    except Exception:
        pass

    # ── Baseline protection: prevent weapons from disappearing ──────────
    new_classes = {w["className"] for w in weapons}
    if OUT_FILE.exists():
        try:
            prev = json.loads(OUT_FILE.read_text())
            prev_weapons = prev.get("weapons", [])
            kept = 0
            for pw in prev_weapons:
                if pw["className"] not in new_classes:
                    weapons.append(pw)
                    new_classes.add(pw["className"])
                    kept += 1
            if kept:
                print(f"  ⚠ Baseline protection: kept {kept} weapons that would have disappeared")
                weapons.sort(key=lambda w: (w["manufacturer"], w["type"], w["name"]))
        except Exception:
            pass

    # ── Attachments (optics / barrels / underbarrels) ─────────────────────
    print("\n[7] Scanning weapon_modifier (attachments)...")
    ATTACH_DIR = FORGE_DIR / "entities" / "scitem" / "weapons" / "weapon_modifier"
    attachments: list[dict] = []

    SUBTYPE_TO_SLOT = {
        "IronSight":        "optics",
        "Barrel":           "barrel",
        "BottomAttachment": "underbarrel",
        "Utility":          "underbarrel",
        "Magazine":         "magazine",  # present on a few; real mags live elsewhere
    }
    # Non-WeaponAttachment items that still ride underbarrel rails (flashlights).
    TYPE_FALLBACK_SLOT = {
        ("Light", "Weapon"): "underbarrel",
    }

    if ATTACH_DIR.exists():
        for f in sorted(ATTACH_DIR.iterdir()):
            if f.is_dir() or not f.name.endswith(".xml.xml"):
                continue
            stem = f.stem.replace(".xml", "").lower()
            # Skip templates + skins + multitool heads (handled by gear extractor).
            # Use the relaxed regex so Tweaker/contestedzonereward barrels pass.
            if stem.endswith(("_template", "_attachment")):
                continue
            if SKIP_VARIANT_ATTACH_RE.search(stem):
                continue
            if stem.startswith("grin_multitool_"):
                continue

            xml_text = f.read_text(errors="replace")
            m = re.search(r'<AttachDef\s+([^>]+?)>', xml_text)
            if not m:
                continue
            attrs = m.group(1)
            def _a(n, attrs=attrs):
                mm = re.search(rf'(?<![A-Za-z]){n}="([^"]*)"', attrs)
                return mm.group(1) if mm else ""
            a_type = _a("Type")
            a_sub  = _a("SubType")
            try: a_size = int(_a("Size") or 0)
            except ValueError: a_size = 0
            a_tags = _a("Tags").split()
            a_req  = _a("RequiredTags").split()

            slot = SUBTYPE_TO_SLOT.get(a_sub)
            if slot is None:
                slot = TYPE_FALLBACK_SLOT.get((a_type, a_sub))
            if slot is None:
                continue  # skip anything we can't slot

            # Name via Localization element. Case-insensitive + tolerant of
            # the typo variant (`@item_nam...` missing the trailing "e") that
            # some contested-zone reward items use. First match wins — it's
            # the item-specific reference, not the base-weapon fallback.
            mn = re.search(r'Name="(@item_[Nn]ame?[^"]+)"', xml_text)
            loc_key = (mn.group(1) if mn else f"@item_Name{stem}").lstrip("@").lower()
            display = loc.get(loc_key, "") or MANUAL_NAMES.get(stem) or stem

            # Mass.
            mass = 0.0
            mm2 = re.search(r'<SEntityRigidPhysicsControllerParams[^>]*Mass="([^"]+)"', xml_text)
            if mm2:
                mass = safe_float(mm2.group(1))

            # ─── Stat modifiers ─────────────────────────────────────────
            # Each attachment has a <modifier><weaponStats><recoilModifier>
            # chain. We pull every meaningful multiplier; entries that are
            # the identity value (1.0) or zero additives are dropped so the
            # output stays readable.
            mods: dict[str, float] = {}

            # Attrs I care about on <weaponStats>. Multipliers default to 1,
            # additive deltas default to 0.
            WS_MULT_ATTRS = [
                "fireRateMultiplier", "damageMultiplier", "damageOverTimeMultiplier",
                "projectileSpeedMultiplier", "ammoCostMultiplier",
                "heatGenerationMultiplier", "soundRadiusMultiplier", "chargeTimeMultiplier",
            ]
            WS_ADD_ATTRS = ["fireRate", "pellets", "burstShots", "ammoCost"]

            RECOIL_MULT_ATTRS = [
                "decayMultiplier", "endDecayMultiplier",
                "fireRecoilTimeMultiplier",
                "fireRecoilStrengthFirstMultiplier", "fireRecoilStrengthMultiplier",
                "angleRecoilStrengthMultiplier",
                "randomnessMultiplier", "randomnessBackPushMultiplier",
                "animatedRecoilMultiplier",
            ]

            m_ws = re.search(r'<weaponStats\s+([^>]+?)>', xml_text)
            if m_ws:
                ws = m_ws.group(1)
                for k in WS_MULT_ATTRS:
                    mm = re.search(rf'(?<![A-Za-z]){k}="([^"]+)"', ws)
                    if mm:
                        v = safe_float(mm.group(1), 1.0)
                        if abs(v - 1.0) > 1e-6:
                            mods[k] = round(v, 4)
                for k in WS_ADD_ATTRS:
                    mm = re.search(rf'(?<![A-Za-z]){k}="([^"]+)"', ws)
                    if mm:
                        v = safe_float(mm.group(1), 0.0)
                        if abs(v) > 1e-6:
                            mods[k] = round(v, 4)

            m_rc = re.search(r'<recoilModifier\s+([^>]+?)>', xml_text)
            if m_rc:
                rc = m_rc.group(1)
                for k in RECOIL_MULT_ATTRS:
                    mm = re.search(rf'(?<![A-Za-z]){k}="([^"]+)"', rc)
                    if mm:
                        v = safe_float(mm.group(1), 1.0)
                        if abs(v - 1.0) > 1e-6:
                            mods[f"recoil_{k}"] = round(v, 4)

            # ─── Optic-specific fields ─────────────────────────────────
            # Pulled from <aimModifier> + <SWeaponModifierComponentParams>.
            # Present on every weapon_modifier XML, but only meaningful for
            # sighting attachments — the extractor emits this block on the
            # optics slot only, to keep JSON tight.
            optic_spec = None
            if slot == "optics":
                optic_spec = {}
                m_aim = re.search(r'<aimModifier\s+([^>]+?)/>', xml_text)
                if m_aim:
                    aim_attrs = m_aim.group(1)
                    for k in ["zoomScale", "secondZoomScale", "zoomTimeScale", "fstopMultiplier"]:
                        mm = re.search(rf'(?<![A-Za-z]){k}="([^"]+)"', aim_attrs)
                        if mm: optic_spec[k] = safe_float(mm.group(1), 0.0)
                    mm = re.search(r'(?<![A-Za-z])hideWeaponInADS="([^"]+)"', aim_attrs)
                    if mm: optic_spec["hideWeaponInADS"] = mm.group(1) == "1"
                m_mod = re.search(r'<SWeaponModifierComponentParams\s+([^>]+?)>', xml_text)
                if m_mod:
                    mod_attrs = m_mod.group(1)
                    mm = re.search(r'(?<![A-Za-z])adsNearClipPlaneMultiplier="([^"]+)"', mod_attrs)
                    if mm: optic_spec["adsNearClipPlaneMultiplier"] = safe_float(mm.group(1), 1.0)
                    mm = re.search(r'(?<![A-Za-z])forceIronSightSetup="([^"]+)"', mod_attrs)
                    if mm: optic_spec["forceIronSightSetup"] = mm.group(1) == "1"
                # Scope attachment — three observed types: Zoom, Nightvision,
                # None. Absence of the block means the optic has no alt-mode
                # feature at all (basic iron sights / reflex).
                m_scope = re.search(r'<SScopeAttachmentParams\s+scopeType="([^"]+)"\s+activateByDefault="([^"]+)"', xml_text)
                if m_scope:
                    st = m_scope.group(1)
                    optic_spec["scopeType"] = st
                    optic_spec["scopeDefault"] = m_scope.group(2) == "1"

            rec = {
                "className":    stem,
                "name":         display,
                "manufacturer": get_manufacturer(stem),
                "attachSlot":   slot,
                "attachType":   a_type,
                "subType":      a_sub,
                "size":         a_size,
                "mass":         round(mass, 4),
                "tags":         a_tags,
                "requiredTags": a_req,
                "modifiers":    mods,
            }
            if optic_spec:
                rec["opticSpec"] = optic_spec
            attachments.append(rec)

    attachments.sort(key=lambda x: (x["attachSlot"], x["size"], x["manufacturer"], x["name"]))
    print(f"  Attachments: {len(attachments)}")

    # Resolve magazine display names + classify ammo type
    magazines = []
    for m in mag_records:
        display_name = loc.get(m["locKey"], "") or MANUAL_NAMES.get(m["className"]) or m["className"]
        magazines.append({
            "className": m["className"],
            "name": display_name,
            "weaponTag": m["weaponTag"],
            "manufacturer": get_manufacturer(m["className"]),
            "ammoCount": m["ammoCount"],
            "mass": m["mass"],
            "size": m["size"],
            "subType": m["subType"],
            "ammoType": classify_ammo_type(m["className"]),
        })
    magazines.sort(key=lambda m: (m["manufacturer"], m["name"]))
    print(f"  Magazines: {len(magazines)}")

    # Build output
    output = {
        "meta": {
            "count": len(weapons),
            "magazineCount": len(magazines),
            "attachmentCount": len(attachments),
            "version": version,
        },
        "weapons": weapons,
        "magazines": magazines,
        "attachments": attachments,
    }

    # Write output
    print(f"\n[8] Writing output ({_MODE})...")
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Written: {OUT_FILE}")

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

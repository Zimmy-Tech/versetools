"""
versedb_extract.py
==================
Extracts ship, weapon, shield, power plant, cooler, and quantum drive data
from Star Citizen's extracted game files and outputs versedb_data.json.

PREREQUISITES — run these commands first:
  unp4k extract "D:\scfiles\StarCitizen\PTU\Data.p4k" "Data\Scripts\Entities\Vehicles\Implementations\Xml\*.xml" --convert-xml -o E:\VerseDB\sc_data_xml
  unp4k extract "D:\scfiles\StarCitizen\PTU\Data.p4k" "Data\Localization\english\global.ini" -o E:\VerseDB\sc_data_xml
  unp4k dcb "E:\VerseDB\sc_data\Data\Game2.dcb" -o E:\VerseDB\sc_data_forge

Then run:
  python versedb_extract.py

Output: versedb_data.json in the same folder as this script.
"""

import json
import os
import re
import struct
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

# ── Configuration ─────────────────────────────────────────────────────────────

VEHICLE_XML_DIR = Path(r"E:\VerseDB\sc_data_xml\Data\Scripts\Entities\Vehicles\Implementations\Xml")
FORGE_DIR       = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records")
DCB_FILE        = Path(r"E:\VerseDB\sc_data\Data\Game2.dcb")
GLOBAL_INI      = Path(r"E:\VerseDB\sc_data_xml\Data\Localization\english\global.ini")
OUTPUT_FILE     = Path(__file__).parent / "versedb_data.json"

# ── Localization ───────────────────────────────────────────────────────────────

def load_localization(ini_path):
    loc = {}
    if not ini_path.exists():
        print(f"  WARNING: global.ini not found at {ini_path}")
        return loc
    with open(ini_path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.split(",")[0].strip()
            loc[key.lower()] = val.strip()
    print(f"  Loaded {len(loc):,} localization entries")
    return loc

def loc_lookup(loc, key):
    if not key:
        return ""
    if key.startswith("@"):
        key = key[1:]
    return loc.get(key.lower(), key)

def resolve_item_name(loc, class_name):
    """Resolve a component class name to its display name via localization.
    Tries multiple key formats to handle the various naming conventions in global.ini.
    """
    # Strip _scitem suffix (forge XMLs append this)
    base = re.sub(r'_scitem$', '', class_name, flags=re.IGNORECASE)
    candidates = [
        f'item_name{class_name}',
        f'item_name{base}',
        f'item_name_{base}',
    ]
    for c in candidates:
        v = loc.get(c.lower())
        if v and not v.startswith('@') and len(v) > 2:
            return v
    # Final fallback: humanize class name
    return base.replace('_', ' ').title()

# ── Manufacturer resolution ────────────────────────────────────────────────────

MFR_FROM_PREFIX = {
    "AEGS": "Aegis Dynamics",
    "ANVL": "Anvil Aerospace",
    "ORIG": "Origin Jumpworks",
    "RSI":  "Roberts Space Industries",
    "DRAK": "Drake Interplanetary",
    "MISC": "Musashi Industrial & Starflight Concern",
    "CRUS": "Crusader Industries",
    "BANU": "Banu",
    "VNCL": "Vanduul",
    "XIAN": "Xi'an",
    "ARGO": "Argo Astronautics",
    "KRIG": "Kruger Intergalactic",
    "TMBL": "Tumbril Land Systems",
    "CNOU": "Consolidated Outland",
    "ESPR": "Esperia",
    "GAMA": "Gatac Manufacture",
    "MRAI": "Mirai",
    "BEHR": "Behring Applied Technology",
    "KLWE": "Klaus & Werner",
    "GATS": "Gallenson Tactical Systems",
    "AMRS": "Apocalypse Arms",
    "PRAR": "Preacher Armament",
    "HRST": "Hurston Dynamics",
    "TALN": "Talon",
    "FSKI": "FireStryke",
    "THCN": "Thunder Child",
    "GLSN": "Gallenson",
    "KBAR": "Kroneg",
    "ASAD": "Joker Engineering",
    "MXOX": "MaxOx",
    "JOKR": "Joker Engineering",
    "TOAG": "Torchwood Armament Group",
    "BRRA": "Behring",
    "KRON": "Kroneg",
    "GODI": "Godi Interstellar",
    "NOVP": "Novikov Armaments",
    "APAR": "A&R",
}

def mfr_from_classname(class_name):
    prefix = class_name.split("_")[0].upper()
    return MFR_FROM_PREFIX.get(prefix, prefix)

# ── Helpers ────────────────────────────────────────────────────────────────────

def safe_float(val, default=0.0):
    try:
        return float(val) if val not in (None, "", "~", "null") else default
    except (TypeError, ValueError):
        return default

def safe_int(val, default=0):
    try:
        return int(float(val)) if val not in (None, "", "~", "null") else default
    except (TypeError, ValueError):
        return default

# ── Vehicle XML parsing ────────────────────────────────────────────────────────

SKIP_TYPES = {
    "SeatAccess", "LandingSystem", "DoorController", "MultiLight",
    "WeaponController", "CommsController", "Scanner", "FuelIntake",
    "FuelTank", "ManneuverThruster", "MainThruster", "WeaponDefensive",
    "CountermeasureLauncher", "Door", "Elevator", "Avionics",
    "SelfDestruct", "LifeSupportGenerator", "PowerDistribution",
    "FuelController", "CargoContainer",
}

KEEP_TYPES = {
    "WeaponGun", "WeaponTachyon", "WeaponMining", "MissileLauncher",
    "BombLauncher", "Turret", "Shield", "PowerPlant", "Cooler",
    "QuantumDrive", "Radar", "Sensor", "QuantumFuelTank",
}

def parse_vehicle_xml(xml_path, loc):
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError as e:
        print(f"    XML parse error in {xml_path.name}: {e}")
        return None

    root = tree.getroot()
    class_name = xml_path.stem

    # Display name from localization
    loc_key = f"vehicle_name{class_name.lower()}"
    display_name = loc.get(loc_key, class_name.replace("_", " "))

    # Mass from main animated Part
    mass = 0.0
    for part in root.iter("Part"):
        if part.get("class") == "Animated" and part.get("mass"):
            try:
                mass = float(part.get("mass", 0))
                break
            except ValueError:
                pass

    manufacturer = mfr_from_classname(class_name)

    # Collect hardpoints
    hardpoints = []
    seen_ids = set()

    for part in root.iter("Part"):
        part_name = part.get("name", "")
        item_port = part.find("ItemPort")
        if item_port is None:
            continue

        flags = item_port.get("flags", "")

        # Skip invisible+uneditable (internal systems)
        if "uneditable" in flags and "invisible" in flags:
            continue

        min_size = safe_int(item_port.get("minSize", 0))
        max_size = safe_int(item_port.get("maxSize", 0))
        if max_size == 0:
            continue

        types_el = item_port.find("Types")
        if types_el is None:
            continue

        port_types = []
        for type_el in types_el.findall("Type"):
            t = type_el.get("type", "")
            st = type_el.get("subtypes", "")
            if t and t not in SKIP_TYPES:
                port_types.append({"type": t, "subtypes": st})

        if not port_types:
            continue

        primary_type = port_types[0]["type"]
        if primary_type not in KEEP_TYPES:
            if not any(pt["type"] in KEEP_TYPES for pt in port_types):
                continue

        # Label
        display_attr = item_port.get("display_name", "")
        if display_attr:
            label = loc.get(display_attr.lower(), display_attr)
        else:
            label = (part_name
                     .replace("hardpoint_", "")
                     .replace("Hardpoint_", "")
                     .replace("_", " ")
                     .title())

        hp_id = part_name
        if hp_id in seen_ids:
            hp_id = f"{part_name}_{len(seen_ids)}"
        seen_ids.add(hp_id)

        hardpoints.append({
            "id":       hp_id,
            "label":    label,
            "type":     primary_type,
            "subtypes": port_types[0].get("subtypes", ""),
            "minSize":  min_size,
            "maxSize":  max_size,
            "flags":    flags.strip(),
            "allTypes": port_types,
        })

    if not hardpoints:
        return None

    return {
        "className":    class_name,
        "name":         display_name,
        "manufacturer": manufacturer,
        "mass":         round(mass, 0),
        "size":         "unknown",
        "role":         "",
        "career":       "",
        "crew":         1,
        "hardpoints":   hardpoints,
    }

# ── Component parsers ──────────────────────────────────────────────────────────

def parse_attachdef(root):
    attach = root.find(".//AttachDef")
    if attach is None:
        return None
    return {
        "type":    attach.get("Type", ""),
        "subType": attach.get("SubType", ""),
        "size":    safe_int(attach.get("Size", 0)),
        "grade":   attach.get("Grade", ""),
    }

def get_power_draw(root):
    for state in root.iter("ItemResourceState"):
        if state.get("name") == "Online":
            for node in state.iter():
                if "consumption" in node.tag.lower() or "conversion" in node.tag.lower():
                    cons = node.find("consumption")
                    if cons is not None and cons.get("resource") == "Power":
                        rau = cons.find("resourceAmountPerSecond")
                        if rau is not None:
                            # Try various attribute names
                            for attr in ("value", "max", "base", "amount"):
                                v = rau.get(attr)
                                if v:
                                    return safe_float(v)
    return 0.0

def get_em_signature(root):
    em = root.find(".//EMSignature")
    if em is not None:
        return safe_float(em.get("nominalSignature", 0))
    return 0.0

def parse_weapon_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] not in ("WeaponGun", "WeaponTachyon", "WeaponMining"):
        return None

    ammo_ref = ""
    ammo_cont = root.find(".//SAmmoContainerComponentParams")
    if ammo_cont is not None:
        ammo_ref = ammo_cont.get("ammoParamsRecord", "")

    display = resolve_item_name(loc, class_name)

    return {
        "className":      class_name,
        "name":           display,
        "manufacturer":   mfr_from_classname(class_name),
        "type":           info["type"],
        "subType":        info["subType"],
        "size":           info["size"],
        "grade":          info["grade"],
        "powerDraw":      round(get_power_draw(root), 2),
        "emSignature":    round(get_em_signature(root), 1),
        "ammoRef":        ammo_ref,
        "fireRate":       0.0,
        "damage": {
            "physical": 0.0, "energy": 0.0, "distortion": 0.0,
            "thermal": 0.0, "biochemical": 0.0, "stun": 0.0,
        },
        "alphaDamage":    0.0,
        "dps":            0.0,
        "projectileSpeed": 0.0,
        "range":          0.0,
        "ammoCount":      None,
    }

def parse_missile_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] not in ("MissileLauncher", "BombLauncher"):
        return None

    # Try various damage node locations
    dmg = {"physical": 0.0, "energy": 0.0, "distortion": 0.0,
           "thermal": 0.0, "biochemical": 0.0, "stun": 0.0}

    for node_name in ("damageInfo", "SCItemMissileComponentParams", "damage"):
        node = root.find(f".//{node_name}")
        if node is not None:
            dmg["physical"]   = safe_float(node.get("DamagePhysical", 0))
            dmg["energy"]     = safe_float(node.get("DamageEnergy", 0))
            dmg["distortion"] = safe_float(node.get("DamageDistortion", 0))
            dmg["thermal"]    = safe_float(node.get("DamageThermal", 0))
            if any(v > 0 for v in dmg.values()):
                break

    alpha = sum(dmg.values())
    name_key = f"item_name{class_name.lower()}"
    display = loc.get(name_key, class_name.replace("_", " "))

    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         info["type"],
        "subType":      info["subType"],
        "size":         info["size"],
        "grade":        info["grade"],
        "damage":       dmg,
        "alphaDamage":  round(alpha, 2),
    }

def parse_shield_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Shield":
        return None
    sg = root.find(".//SCItemShieldGeneratorParams")
    if sg is None:
        return None
    name_key = f"item_name{class_name.lower()}"
    display = resolve_item_name(loc, class_name)
    return {
        "className":          class_name,
        "name":               display,
        "manufacturer":       mfr_from_classname(class_name),
        "type":               "Shield",
        "size":               info["size"],
        "grade":              info["grade"],
        "hp":                 safe_float(sg.get("MaxShieldHealth", 0)),
        "regenRate":          safe_float(sg.get("MaxShieldRegen", 0)),
        "damagedRegenDelay":  safe_float(sg.get("DamagedRegenDelay", 0)),
        "downedRegenDelay":   safe_float(sg.get("DownedRegenDelay", 0)),
        "powerDraw":          round(get_power_draw(root), 2),
        "emSignature":        round(get_em_signature(root), 1),
    }

def parse_powerplant_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "PowerPlant":
        return None
    # Power output is a SPowerSegmentResourceUnit stored as a direct u32 integer
    # in DCB. The forge XML has: <generation resource="Power"
    #   resourceAmountPerSecond="SPowerSegmentResourceUnit[HEX]"/>
    # We extract the hex index here and resolve it in enrich_from_dcb.
    power_output = 0.0
    psru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    m = re.search(r'resource=["\']Power["\'][^>]*SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\]', txt)
    if not m:
        m = re.search(r'SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\][^<]{0,60}resource=["\']Power["\']', txt)
    if m:
        psru_ref = m.group(1)
    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "PowerPlant",
        "size":         info["size"],
        "grade":        info["grade"],
        "powerOutput":  round(power_output, 1),
        "psruRef":      psru_ref,
        "emSignature":  round(get_em_signature(root), 1),
    }

def parse_cooler_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Cooler":
        return None
    # Cooling rate is a SStandardResourceUnit stored as direct f32 in DCB.
    # The forge XML has: <generation resource="Coolant"
    #   resourceAmountPerSecond="SStandardResourceUnit[HEX]"/>
    cooling_rate = 0.0
    sru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    m = re.search(r'resource=["\']Coolant["\'][^>]*SStandardResourceUnit\[([0-9A-Fa-f]+)\]', txt)
    if not m:
        m = re.search(r'SStandardResourceUnit\[([0-9A-Fa-f]+)\][^<]{0,60}resource=["\']Coolant["\']', txt)
    if m:
        sru_ref = m.group(1)
    ir = root.find(".//IRSignature")
    ir_sig = safe_float(ir.get("nominalSignature", 0)) if ir is not None else 0.0
    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Cooler",
        "size":         info["size"],
        "grade":        info["grade"],
        "coolingRate":  round(cooling_rate, 1),
        "sruRef":       sru_ref,
        "irSignature":  round(ir_sig, 1),
    }

def parse_quantumdrive_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "QuantumDrive":
        return None
    qp = root.find(".//SQuantumDriveComponentParams")
    speed = range_au = cal_time = fuel_rate = 0.0
    if qp is not None:
        range_au = safe_float(qp.get("jumpRange", 0))
        cal_time = safe_float(qp.get("calibrationDelayInSeconds", 0))
        params = qp.find(".//params") or qp.find(".//standardJumpParams")
        if params is not None:
            speed     = safe_float(params.get("driveSpeed", params.get("speed", 0)))
            fuel_rate = safe_float(params.get("quantumFuelRequirement", 0))
    name_key = f"item_name{class_name.lower()}"
    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "QuantumDrive",
        "size":         info["size"],
        "grade":        info["grade"],
        "speed":        round(speed, 0),
        "range":        round(range_au, 1),
        "calTime":      round(cal_time, 1),
        "fuelRate":     round(fuel_rate, 4),
    }

# Maps forge subfolder -> parser function
FOLDER_PARSERS = {
    "weapons":         parse_weapon_item,
    "shieldgenerator": parse_shield_item,
    "powerplant":      parse_powerplant_item,
    "cooler":          parse_cooler_item,
    "quantumdrive":    parse_quantumdrive_item,
    "missiles":        parse_missile_item,
}

def scan_components(forge_dir, loc):
    items = {}
    ships_dir = forge_dir / "entities" / "scitem" / "ships"
    if not ships_dir.exists():
        print(f"  ERROR: {ships_dir} not found")
        return items

    for folder_name, parser_fn in FOLDER_PARSERS.items():
        folder = ships_dir / folder_name
        if not folder.exists():
            print(f"    Skipping {folder_name} — not found")
            continue
        count = 0
        for xml_file in folder.rglob("*.xml"):
            class_name = xml_file.stem.replace(".xml", "")
            if class_name in items:
                continue
            try:
                root = ET.parse(xml_file).getroot()
                parsed = parser_fn(root, class_name, loc)
                if parsed:
                    items[class_name] = parsed
                    count += 1
            except Exception:
                pass
        print(f"    {folder_name}: {count} items")

    return items

# ── Ammo params ────────────────────────────────────────────────────────────────

def ammo_filename_key(xml_file):
    """Convert ammo XML filename to a weapon class name key for matching.
    e.g. hrst_laserrepeater_s3_ammo.xml -> hrst_laserrepeater_s3
         ammoparams.klwe_laserrepeater_s3_ammo.xml -> klwe_laserrepeater_s3
    """
    stem = xml_file.stem.replace(".xml", "")
    stem = re.sub(r'^ammoparams\.', '', stem)
    stem = re.sub(r'_ammo$', '', stem)
    return stem.lower()

def parse_ammo_params(forge_dir):
    """Parse ammo XML files, keyed by derived weapon class name prefix."""
    ammo_data = {}
    ammo_dir = forge_dir / "ammoparams" / "vehicle"
    if not ammo_dir.exists():
        print(f"  WARNING: ammoparams dir not found")
        return ammo_data
    for xml_file in ammo_dir.glob("*.xml"):
        try:
            root = ET.parse(xml_file).getroot()
            speed    = safe_float(root.get("speed", 0))
            lifetime = safe_float(root.get("lifetime", 0))
            key = ammo_filename_key(xml_file)
            if key:
                ammo_data[key] = {
                    "speed": round(speed, 0),
                    "range": round(speed * lifetime, 0),
                }
        except Exception:
            pass
    print(f"  Loaded {len(ammo_data)} ammo records")
    return ammo_data

def enrich_weapons(items, ammo_data):
    """Match weapons to ammo params by class name prefix."""
    enriched = 0
    for item in items.values():
        if item.get("type") not in ("WeaponGun", "WeaponTachyon", "WeaponMining"):
            continue
        key = item.get("className", "").lower()
        if key in ammo_data:
            item["projectileSpeed"] = ammo_data[key]["speed"]
            item["range"]           = ammo_data[key]["range"]
            enriched += 1
    print(f"  Enriched {enriched} weapons with speed/range")

# ── Ship enrichment from DCB forge ────────────────────────────────────────────

ROLE_MAP = {
    "combat":      "Combat",
    "fighter":     "Fighter",
    "bomber":      "Bomber",
    "transport":   "Transport",
    "cargo":       "Cargo",
    "exploration": "Exploration",
    "support":     "Support",
    "industrial":  "Industrial",
    "mining":      "Mining",
    "salvage":     "Salvage",
    "multi":       "Multirole",
    "touring":     "Touring",
    "racing":      "Racing",
    "stealth":     "Stealth",
    "interdiction":"Interdiction",
    "medical":     "Medical",
    "science":     "Science",
    "refueling":   "Refueling",
    "repair":      "Repair",
}

def resolve_role(val, loc):
    if not val:
        return ""
    display = loc_lookup(loc, val)
    for k, v in ROLE_MAP.items():
        if k in display.lower() or k in val.lower():
            return v
    return display

def enrich_ships_from_dcb(ships, forge_dir, loc):
    spaceship_dir = forge_dir / "entities" / "spaceships"
    if not spaceship_dir.exists():
        print(f"  WARNING: spaceships dir not found")
        return

    enriched = 0
    for xml_file in spaceship_dir.glob("*.xml"):
        stem = xml_file.stem.replace(".xml", "")
        matched = next((k for k in ships if k.lower() == stem.lower()), None)
        if not matched:
            continue
        try:
            root = ET.parse(xml_file).getroot()
            vc   = root.find(".//VehicleComponentParams")
            if vc is None:
                continue
            ship = ships[matched]
            ship["role"]   = resolve_role(vc.get("vehicleRole", ""), loc)
            ship["career"] = resolve_role(vc.get("vehicleCareer", ""), loc)
            ship["crew"]   = safe_int(vc.get("crewSize", 1))
            # Override display name with localized version if available
            loc_key = f"vehicle_name{stem.lower()}"
            if loc_key in loc:
                ship["name"] = loc[loc_key]
            enriched += 1
        except Exception:
            pass
    print(f"  Enriched {enriched} ships from DCB entity data")

def classify_size(ship):
    mass = ship.get("mass", 0)
    crew = ship.get("crew", 1)
    if mass >= 3_000_000 or crew >= 8:
        return "capital"
    elif mass >= 500_000 or crew >= 4:
        return "large"
    elif mass >= 80_000 or crew >= 2:
        return "medium"
    else:
        return "small"

# ── DCB enrichment ────────────────────────────────────────────────────────────

def _dcb_parse_header(d):
    """Minimal DCB header parser. Returns dict of key offsets and counts."""
    p = 4
    version = struct.unpack_from("<i",d,p)[0]; p+=4
    if version >= 6: p+=8
    n_structs,n_props,n_enums,n_mappings,n_records = [struct.unpack_from("<i",d,p+i*4)[0] for i in range(5)]
    p+=20
    counts = [struct.unpack_from("<i",d,p+i*4)[0] for i in range(19)]; p+=76
    (c_bool,c_i8,c_i16,c_i32,c_i64,c_u8,c_u16,c_u32,c_u64,c_f32,
     c_f64,c_guid,c_str,c_loc,c_enum,c_strong,c_weak,c_ref,c_enum_opts)=counts
    text_len = struct.unpack_from("<I",d,p)[0]; p+=4
    blob_len = struct.unpack_from("<I",d,p)[0]; p+=4

    struct_defs=[]
    for _ in range(n_structs):
        struct_defs.append((struct.unpack_from("<I",d,p)[0], struct.unpack_from("<I",d,p+4)[0],
                            struct.unpack_from("<H",d,p+8)[0], struct.unpack_from("<H",d,p+10)[0],
                            struct.unpack_from("<I",d,p+12)[0])); p+=16
    prop_defs=[]
    for _ in range(n_props):
        prop_defs.append((struct.unpack_from("<I",d,p)[0], struct.unpack_from("<H",d,p+6)[0],
                          struct.unpack_from("<H",d,p+8)[0])); p+=12
    p+=n_enums*8
    map_start=p
    mappings=[]
    for _ in range(n_mappings):
        mappings.append((struct.unpack_from("<I",d,p)[0], struct.unpack_from("<I",d,p+4)[0])); p+=8
    rec_start=p; p+=n_records*32
    va_f32 = p+c_i8+c_i16*2+c_i32*4+c_i64*8+c_u8+c_u16*2+c_u32*4+c_u64*8+c_bool
    text_start = va_f32+c_f32*4+c_f64*8+c_guid*16+c_str*4+c_loc*4+c_enum*4+c_strong*8+c_weak*8+c_ref*20+c_enum_opts*4
    blob_start = text_start+text_len
    data_start = blob_start+blob_len

    def blob(off):
        q=blob_start+off; return d[q:d.index(b'\x00',q)].decode('utf-8','replace')

    struct_by_name={}
    for i,(name_off,_,_,_,_) in enumerate(struct_defs):
        try: struct_by_name[blob(name_off)]=i
        except: pass

    struct_data={}
    off=data_start
    for cnt,si in mappings:
        if si<len(struct_defs):
            struct_data[si]=(off,cnt); off+=struct_defs[si][4]*cnt

    def _text(off):
        p = text_start + off
        end = d.index(b'\x00', p)
        return d[p:end].decode('utf-8', errors='replace')

    return {
        "d": d, "version": version,
        "n_records": n_records, "rec_start": rec_start,
        "struct_by_name": struct_by_name, "struct_data": struct_data,
        "struct_defs": struct_defs,
        "va_f32": va_f32, "c_f32": c_f32,
        "blob_start": blob_start, "blob": blob,
        "blob_text": _text, "text_start": text_start,
    }

def enrich_from_dcb(items, dcb_path, loc):
    """
    Enrich weapons with damage+fireRate+DPS using verified DCB data chain:
      AmmoParams record -> BPP instance -> DamageInfo instance -> 6x f32
      SWeaponRegenConsumerParams -> RPM = ammoLoad/costPerBullet

    Also enriches shields and QD components with DCB stats.
    """
    print(f"  Reading DCB binary ({dcb_path.stat().st_size/1e6:.0f} MB)…")
    with open(dcb_path,"rb") as f:
        d = f.read()

    h = _dcb_parse_header(d)
    sd = h["struct_data"]
    sdefs = h["struct_defs"]

    def si(name): return h["struct_by_name"].get(name)
    def f32at(p): return struct.unpack_from("<f",d,p)[0]
    def u32at(p): return struct.unpack_from("<I",d,p)[0]
    def u16at(p): return struct.unpack_from("<H",d,p)[0]

    di_si   = si("DamageInfo")
    bpp_si  = si("BulletProjectileParams")
    ammo_si = si("AmmoParams")
    regen_si= si("SWeaponRegenConsumerParams")
    shld_si = si("SCItemShieldGeneratorParams")
    qd_si   = si("SCItemQuantumDriveParams")

    # ── Build AmmoParams key -> BPP instance map ──────────────────────────────
    ammo_to_bpp = {}
    if ammo_si and ammo_si in sd:
        a_off, a_cnt = sd[ammo_si]
        a_rs = sdefs[ammo_si][4]
        for ri in range(h["n_records"]):
            rp = h["rec_start"] + ri*32
            if u32at(rp+8) != ammo_si: continue
            variant = u16at(rp+28)
            if variant >= a_cnt: continue
            try: rname = h["blob"](u32at(rp))
            except: continue
            key = rname.lower()
            for pfx in ("ammoparams.",):
                if key.startswith(pfx): key = key[len(pfx):]
            # also strip _ammo suffix for matching
            bare_key = re.sub(r'_ammo$','',key)
            inst = a_off + variant*a_rs
            ptr_si = u32at(inst+104); ptr_ii = u32at(inst+108)
            if ptr_si == bpp_si:
                ammo_to_bpp[key]      = ptr_ii
                ammo_to_bpp[bare_key] = ptr_ii
    print(f"  AmmoParams mapped: {len(ammo_to_bpp)//2} entries")

    # ── Build DamageInfo lookup ───────────────────────────────────────────────
    def get_damage(bpp_idx):
        if bpp_si not in sd: return None
        b_off, b_cnt = sd[bpp_si]
        b_rs = sdefs[bpp_si][4]
        if bpp_idx >= b_cnt: return None
        inst = b_off + bpp_idx*b_rs
        ptr_si2 = u32at(inst+16); ptr_ii2 = u32at(inst+20)
        if ptr_si2 != di_si or di_si not in sd: return None
        di_off, di_cnt = sd[di_si]
        if ptr_ii2 >= di_cnt: return None
        base = di_off + ptr_ii2*24
        v = struct.unpack_from("<6f",d,base)
        return {"physical":round(v[0],4),"energy":round(v[1],4),"distortion":round(v[2],4),
                "thermal":round(v[3],4),"biochemical":round(v[4],4),"stun":round(v[5],4)}

    # ── Build fire-rate lookup keyed by AmmoParams key ────────────────────────
    # SWeaponRegenConsumerParams is referenced by weapon XML via GUID - we can't
    # match it directly to items here. Fire rate is extracted separately per weapon
    # via the XML's weaponRegenConsumerParams reference index, which we don't have.
    # Instead: we store all RPM values and match via the ammo key chain.
    # The ammo record name gives us the BPP index; separately, the regen params
    # are matched to weapons in versedb_extract via the forge XML's
    # weaponRegenConsumerParams="SWeaponRegenConsumerParams[XXXX]" reference.
    # For now: extract all fire rates and let weapons get their RPM from
    # the forge XML's fireActions delay/unit attributes.

    # ── Build forge-XML ammo damage fallback (for ballistic/distortion weapons) ─
    # Some BPP instances have null DamageInfo pointers; their damage comes from
    # ProjectileDetonationParams->explosionParams->damageInfo in forge XML.
    # Parse ammo XMLs for DamagePhysical etc. as a fallback.
    forge_ammo_damage = {}
    ammo_xml_dir = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records\ammoparams\vehicle")
    if ammo_xml_dir.exists():
        for xml_file in ammo_xml_dir.glob("*.xml"):
            try:
                root = ET.parse(xml_file).getroot()
                # Look for damageInfo child element (explosive/detonation damage)
                di_el = root.find(".//damageInfo")
                if di_el is None: continue
                dmg = {
                    "physical":    safe_float(di_el.get("DamagePhysical",   di_el.get("damagePhysical",   0))),
                    "energy":      safe_float(di_el.get("DamageEnergy",     di_el.get("damageEnergy",     0))),
                    "distortion":  safe_float(di_el.get("DamageDistortion", di_el.get("damageDistortion", 0))),
                    "thermal":     safe_float(di_el.get("DamageThermal",    di_el.get("damageThermal",    0))),
                    "biochemical": safe_float(di_el.get("DamageBiochemical",di_el.get("damageBiochemical",0))),
                    "stun":        safe_float(di_el.get("DamageStun",       di_el.get("damageStun",       0))),
                }
                if any(v > 0 for v in dmg.values()):
                    stem = xml_file.stem.replace(".xml","").lower()
                    stem = re.sub(r'^ammoparams\.','',stem)
                    bare = re.sub(r'_ammo$','',stem)
                    forge_ammo_damage[stem] = dmg
                    forge_ammo_damage[bare] = dmg
            except Exception:
                pass

    # ── Match weapons to damage via ammo class name ───────────────────────────
    dmg_enriched = 0
    for class_name, item in items.items():
        if item.get("type") not in ("WeaponGun", "WeaponTachyon"): continue
        key = class_name.lower()
        bpp_idx = ammo_to_bpp.get(key) or ammo_to_bpp.get(key+"_ammo")
        dmg = None
        if bpp_idx is not None:
            dmg = get_damage(bpp_idx)
        # Fallback to forge XML damageInfo for ballistic/distortion weapons
        if not dmg:
            dmg = forge_ammo_damage.get(key) or forge_ammo_damage.get(key+"_ammo")
        if not dmg: continue
        item["damage"] = dmg
        item["alphaDamage"] = round(sum(dmg.values()), 4)
        dmg_enriched += 1

    print(f"  Weapons enriched with damage: {dmg_enriched}")

    # ── Extract fire rates from forge weapon XMLs ──────────────────────────────
    # Two patterns:
    #   Looping (laser/energy): <SWeaponSequenceEntryParams delay="350" unit="RPM" .../>
    #   Rapid/Gatling:          <SWeaponActionFireRapidParams fireRate="1200" .../>
    #   Single (cannon):        <SWeaponActionFireSingleParams fireRate="100" .../>
    weapons_dir = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records\entities\scitem\ships\weapons")
    rpm_enriched = 0
    if weapons_dir.exists():
        for xml_file in weapons_dir.rglob("*.xml"):
            class_name = xml_file.stem.replace(".xml","")
            item = items.get(class_name)
            if not item: continue
            try:
                root = ET.parse(xml_file).getroot()
                rpm = 0.0
                # Pattern 1: looping sequence (laser repeaters)
                for seq in root.iter("SWeaponSequenceEntryParams"):
                    if seq.get("unit","").upper() == "RPM":
                        rpm = safe_float(seq.get("delay", 0))
                        if rpm > 0: break
                # Pattern 2: rapid fire action (gatlings, ballistic repeaters)
                if rpm == 0:
                    for el in root.iter("SWeaponActionFireRapidParams"):
                        rpm = safe_float(el.get("fireRate", 0))
                        if rpm > 0: break
                # Pattern 3: single fire action (cannons)
                if rpm == 0:
                    for el in root.iter("SWeaponActionFireSingleParams"):
                        rpm = safe_float(el.get("fireRate", 0))
                        if rpm > 0: break
                if rpm > 0:
                    item["fireRate"] = round(rpm, 1)
                    alpha = item.get("alphaDamage", 0)
                    if alpha > 0:
                        item["dps"] = round(alpha * rpm / 60.0, 2)
                    rpm_enriched += 1
            except Exception:
                pass
    print(f"  Weapons enriched with fire rate: {rpm_enriched}")

    # ── Fix shield display names ───────────────────────────────────────────────
    for item in items.values():
        if item.get("type") != "Shield": continue
        name = item.get("name", "")
        if "scitem" in name.lower() or name.lower().startswith("shld "):
            item["name"] = resolve_item_name(loc, item.get("className", ""))

    # ── Enrich coolers with cooling rate from SStandardResourceUnit ───────────
    sru_si = h["struct_by_name"].get("SStandardResourceUnit")
    if sru_si and sru_si in sd:
        sru_off2, sru_cnt2 = sd[sru_si]
        def get_sru(idx):
            return round(struct.unpack_from("<f", d, sru_off2 + idx*4)[0], 4) if idx < sru_cnt2 else 0.0
        cool_enriched = 0
        for item in items.values():
            if item.get("type") != "Cooler": continue
            ref = item.pop("sruRef", "")
            if not ref: continue
            idx = int(ref, 16)
            val = get_sru(idx)
            if val > 0:
                item["coolingRate"] = round(val, 2)
                cool_enriched += 1
        print(f"  Coolers enriched with cooling rate: {cool_enriched}/{len([i for i in items.values() if i.get('type')=='Cooler'])}")

    # ── Enrich power plants with power output from SPowerSegmentResourceUnit ──
    # PSRU stores direct u32 integer values (power segment count), not f32
    psru_si = h["struct_by_name"].get("SPowerSegmentResourceUnit")
    if psru_si and psru_si in sd:
        psru_off2, psru_cnt2 = sd[psru_si]
        psru_rs2 = sdefs[psru_si][4]  # should be 4
        def get_psru(idx):
            if idx >= psru_cnt2: return 0
            return u32at(psru_off2 + idx * psru_rs2)
        pp_enriched = 0
        for item in items.values():
            if item.get("type") != "PowerPlant": continue
            ref = item.pop("psruRef", "")
            if not ref: continue
            idx = int(ref, 16)
            val = get_psru(idx)
            if val > 0:
                item["powerOutput"] = val
                pp_enriched += 1
        print(f"  Power plants enriched with output: {pp_enriched}/{len([i for i in items.values() if i.get('type')=='PowerPlant'])}")
        # Clean up any remaining bad power plant names
        for item in items.values():
            if item.get("type") != "PowerPlant": continue
            name = item.get("name","")
            if name.lower().startswith("powr "):
                item["name"] = resolve_item_name(loc, item.get("className",""))

    # ── Enrich QD with DCB speed/cal data ─────────────────────────────────────
    # QD forge XMLs have no direct DCB record — match by record-table order.
    # The 62 QD ECD records sorted by record index map 1:1 to the 62 QD instances.
    if qd_si and qd_si in sd:
        q_off, q_cnt = sd[qd_si]
        q_rs = sdefs[qd_si][4]

        # Build sorted list of QD ECD records from text-section filepaths
        ecd_si2 = h["struct_by_name"].get("EntityClassDefinition")
        qd_ecd_order = []  # list of className in record-table order
        for ri in range(h["n_records"]):
            rp = h["rec_start"] + ri*32
            if u32at(rp+8) != ecd_si2: continue
            try:
                fp_off_val = u32at(rp+4)
                fp_str = h["blob_text"](fp_off_val).lower()
                if "qdrv" not in fp_str: continue
                cn = fp_str.split("/")[-1].replace(".xml","")
                qd_ecd_order.append(cn)
            except Exception:
                # Fallback: try reading fp as blob (some records store paths in blob)
                try:
                    fp_str = h["blob"](u32at(rp+4)).lower()
                    if "qdrv" not in fp_str: continue
                    cn = fp_str.split("/")[-1].replace(".xml","")
                    qd_ecd_order.append(cn)
                except Exception:
                    pass

        print(f"  QD ECD records found: {len(qd_ecd_order)}")

        # Build className -> QD instance index
        qd_cn_to_idx = {cn: i for i, cn in enumerate(qd_ecd_order)}

        qd_enriched = 0
        for class_name2, item in items.items():
            if item.get("type") != "QuantumDrive": continue
            key = class_name2.lower()
            idx = qd_cn_to_idx.get(key)
            if idx is None: continue
            if idx >= q_cnt: continue
            q_inst = q_off + idx * q_rs
            try:
                v = struct.unpack_from("<4f", d, q_inst)
            except: continue
            if v[0] > 1e6:
                item["speed"]   = round(v[0], 0)
                item["calTime"] = round(v[1], 2)
                qd_enriched += 1
        print(f"  QD drives enriched with speed: {qd_enriched}/{len([i for i in items.values() if i.get('type')=='QuantumDrive'])}")

    # ── Enrich QD with DCB speed/cal data ─────────────────────────────────────
    # QD forge XML has driveSpeed=0; real values are in SCItemQuantumDriveParams.
    # Path: EntityClassDefinition record for each QD item -> scan ECD instance
    # for a strong pointer to SCItemQuantumDriveParams -> read speed/calTime.
    ecd_si = h["struct_by_name"].get("EntityClassDefinition")
    if qd_si and qd_si in sd and ecd_si and ecd_si in sd:
        q_off, q_cnt = sd[qd_si]
        q_rs = sdefs[qd_si][4]
        ecd_off, ecd_cnt = sd[ecd_si]
        ecd_rs = sdefs[ecd_si][4]

        # Build className -> ECD variant map from records
        ecd_map = {}
        for ri in range(h["n_records"]):
            rp = h["rec_start"] + ri*32
            if u32at(rp+8) != ecd_si: continue
            variant = u16at(rp+28)
            try: rname = h["blob"](u32at(rp)).lower()
            except: continue
            for pfx in ("entityclassdefinition.",):
                if rname.startswith(pfx): rname = rname[len(pfx):]
            ecd_map[rname] = variant

        qd_enriched = 0
        for class_name, item in items.items():
            if item.get("type") != "QuantumDrive": continue
            key = class_name.lower()
            variant = ecd_map.get(key)
            if variant is None: continue
            if variant >= ecd_cnt: continue

            # Scan ECD instance for strong pointer to SCItemQuantumDriveParams
            inst = ecd_off + variant * ecd_rs
            scan_len = min(ecd_rs - 7, 1024)
            qd_idx = None
            for j in range(0, scan_len, 4):
                sv = u32at(inst + j)
                iv = u32at(inst + j + 4)
                if sv == qd_si and iv < q_cnt:
                    qd_idx = iv
                    break

            if qd_idx is None: continue
            q_inst = q_off + qd_idx * q_rs
            try:
                v = struct.unpack_from("<4f", d, q_inst)
            except: continue
            if v[0] > 1e6:  # valid QD speed range (>1 Mm/s)
                item["speed"]   = round(v[0], 0)
                item["calTime"] = round(v[1], 2)
                qd_enriched += 1

        print(f"  QD drives enriched with speed: {qd_enriched}/{len([i for i in items.values() if i.get('type')=='QuantumDrive'])}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("VerseDB Extractor — Star Citizen Data Pipeline")
    print("=" * 60)

    # Validate
    errors = []
    if not VEHICLE_XML_DIR.exists():
        errors.append(f"  Missing: {VEHICLE_XML_DIR}")
    if not FORGE_DIR.exists():
        errors.append(f"  Missing: {FORGE_DIR}")
    if errors:
        print("\nERROR — directories not found:")
        for e in errors:
            print(e)
        sys.exit(1)

    # 1. Localization
    print("\n[1/6] Loading localization…")
    loc = load_localization(GLOBAL_INI)

    # 2. Vehicle XMLs
    print("\n[2/6] Parsing vehicle XMLs…")
    ships = {}
    xml_files = sorted(VEHICLE_XML_DIR.glob("*.xml"))
    print(f"  Found {len(xml_files)} vehicle XMLs")
    skipped = 0
    for f in xml_files:
        result = parse_vehicle_xml(f, loc)
        if result:
            ships[result["className"]] = result
        else:
            skipped += 1
    print(f"  Parsed {len(ships)} ships ({skipped} skipped)")

    # 3. Enrich from DCB forge
    print("\n[3/6] Enriching ships from DCB forge data…")
    enrich_ships_from_dcb(ships, FORGE_DIR, loc)
    for ship in ships.values():
        ship["size"] = classify_size(ship)

    # 4. Components
    print("\n[4/6] Scanning components…")
    items = scan_components(FORGE_DIR, loc)
    print(f"  Total: {len(items)} components")

    # 5. Ammo params (forge XML: speed, range)
    print("\n[5/7] Parsing ammo params (forge XML)…")
    ammo_data = parse_ammo_params(FORGE_DIR)
    enrich_weapons(items, ammo_data)

    # 6. DCB binary: damage, fire rate, DPS, shields, QD
    print("\n[6/7] Enriching from DCB binary…")
    if DCB_FILE.exists():
        enrich_from_dcb(items, DCB_FILE, loc)
    else:
        print(f"  WARNING: DCB not found at {DCB_FILE} — skipping damage/fireRate/DPS")

    # 7. Write output
    print("\n[7/7] Writing output…")
    ship_list = list(ships.values())
    item_list = list(items.values())

    def count_type(t):
        return sum(1 for i in item_list if i.get("type") == t)

    dps_count = sum(1 for i in item_list if i.get("dps", 0) > 0)

    output = {
        "meta": {
            "game":          "Star Citizen PTU",
            "extractedBy":   "VerseDB Extractor v3",
            "shipCount":     len(ship_list),
            "itemCount":     len(item_list),
            "weapons":       sum(1 for i in item_list if i.get("type") in
                                 ("WeaponGun","WeaponTachyon","MissileLauncher","BombLauncher")),
            "weaponsWithDPS": dps_count,
            "shields":       count_type("Shield"),
            "powerPlants":   count_type("PowerPlant"),
            "coolers":       count_type("Cooler"),
            "quantumDrives": count_type("QuantumDrive"),
        },
        "ships": ship_list,
        "items": item_list,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size_mb = OUTPUT_FILE.stat().st_size / 1_048_576
    m = output["meta"]
    print(f"\n{'=' * 60}")
    print(f"Done!  {OUTPUT_FILE}")
    print(f"  Size:          {size_mb:.1f} MB")
    print(f"  Ships:         {m['shipCount']}")
    print(f"  Weapons:       {m['weapons']} ({m['weaponsWithDPS']} with DPS)")
    print(f"  Shields:       {m['shields']}")
    print(f"  Power Plants:  {m['powerPlants']}")
    print(f"  Coolers:       {m['coolers']}")
    print(f"  Quantum Drives:{m['quantumDrives']}")
    print(f"\nDrop versedb_data.json into the VerseDB app to load.")

if __name__ == "__main__":
    main()

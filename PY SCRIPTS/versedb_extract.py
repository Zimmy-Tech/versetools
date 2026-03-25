"""
versedb_extract.py
==================
Extracts ship, weapon, shield, power plant, cooler, and quantum drive data
from Star Citizen's extracted game files and outputs versedb_data.json.
Also runs versedb_missions.py (missions/contracts) and crafting_extract.py (crafting recipes).

PREREQUISITES — run these commands first (Linux paths, adjust version suffix as needed):

  P4K="/home/bryan/projects/SC Raw Data/PTU/Data.p4k"
  SC="/home/bryan/projects/versedb/SC FILES"

  # 1. Extract vehicle XMLs (decrypts automatically)
  unp4k extract "$P4K" "*Implementations*Xml*.xml" --convert-xml -o "$SC/sc_data_xml_47"

  # 2. Extract localization
  unp4k extract "$P4K" "*english*global.ini" -o "$SC/sc_data_xml_47"

  # 3. Extract Game2.dcb
  unp4k extract "$P4K" "*Game2.dcb" -o "$SC/sc_data_47"

  # 4. Fix backslash paths (unp4k on Linux uses literal backslashes)
  python3 -c "
  import os, shutil
  from pathlib import Path
  def fix(d):
      base = Path(d)
      for e in list(base.iterdir()):
          if chr(92) in e.name:
              dest = base / e.name.replace(chr(92), '/')
              dest.parent.mkdir(parents=True, exist_ok=True)
              shutil.move(str(e), str(dest))
  fix('$SC/sc_data_xml_47')
  fix('$SC/sc_data_47')
  "

  # 5. Forge the DCB into XML records
  unp4k dcb "$SC/sc_data_47/Data/Game2.dcb" -o "$SC/sc_data_forge_47"

Then run:
  python versedb_extract.py

Output files (all auto-copied to versedb-app/public/):
  - versedb_data.json      — ships, weapons, shields, power plants, coolers, QDs
  - versedb_missions.json  — missions & contracts with rep requirements, blueprint rewards
  - versedb_crafting.json  — 1,040 crafting recipes with ingredients, quality modifiers

Pipeline steps:
  [1-7] Ship/component extraction, DCB enrichment, default loadouts
  [8/9] Mission & contract extraction (versedb_missions.py)
  [9/9] Crafting recipe extraction (crafting_extract.py) — parses DCB inline struct_data
"""

import copy
import json
import os
import re
import struct
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

# ── Configuration ─────────────────────────────────────────────────────────────

_SC = Path("/home/bryan/projects/versedb/SC FILES")
VEHICLE_XML_DIR = _SC / "sc_data_xml_47/Data/Scripts/Entities/Vehicles/Implementations/Xml"
FORGE_DIR       = _SC / "sc_data_forge_47/libs/foundry/records"
DCB_FILE        = _SC / "sc_data_47/Data/Game2.dcb"
GLOBAL_INI      = _SC / "sc_data_xml_47/Data/Localization/english/global.ini"
OUTPUT_FILE     = Path(__file__).parent / "versedb_data.json"
BUILD_MANIFEST  = Path("/home/bryan/projects/SC Raw Data/PTU/build_manifest.id")

def _read_game_version():
    """Read build_manifest.id and format as '<major>.<minor>.<patch>-<tag>.<p4change>'."""
    try:
        data = json.loads(BUILD_MANIFEST.read_text())["Data"]
        branch = data.get("Branch", "")          # e.g. "sc-alpha-4.7.0"
        tag    = data.get("Tag", "ptu")           # e.g. "public" → we'll use "ptu" for PTU builds
        p4     = data.get("RequestedP4ChangeNum", "")  # e.g. "11494258"
        # Extract version digits from branch: sc-alpha-4.7.0 → 4.7.0
        import re
        m = re.search(r"(\d+\.\d+\.\d+)", branch)
        ver = m.group(1) if m else data.get("Version", "unknown")
        # Tag mapping: "public" on a PTU branch → "ptu"
        tag_label = "ptu" if "ptu" in str(BUILD_MANIFEST).lower() else tag
        return f"{ver}-{tag_label}.{p4}" if p4 else ver
    except Exception:
        return "unknown"

GAME_VERSION = _read_game_version()

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

def resolve_grade_and_class(loc, class_name):
    """Parse Grade letter and Class (Military/Industrial/Stealth/etc.) from localization description."""
    base = re.sub(r'_scitem$', '', class_name, flags=re.IGNORECASE)
    desc = ''
    for key in (f'item_desc{class_name}', f'item_desc{base}', f'item_desc_{base}'):
        v = loc.get(key.lower(), '')
        if v:
            desc = v
            break
    grade = ''
    item_class = ''
    if desc:
        m = re.search(r'Grade:\s*([A-Ea-e])', desc)
        if m:
            grade = m.group(1).upper()
        m = re.search(r'Class:\s*([^\n\\]+)', desc)
        if m:
            item_class = m.group(1).strip()
    return grade, item_class

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

# ── Flight stats extraction ────────────────────────────────────────────────────

def extract_flight_stats(ship_class_name, forge_dir):
    """
    Extract IFCS flight performance from the ship's flight controller forge XML.
    All returned values match spviewer exactly for verified fields.

    Axis convention in SC:  X = strafe (left/right),  Y = forward,  Z = up/down
    Rotation convention:    X = pitch,  Y = roll,  Z = yaw
    """
    ctrl_dir = forge_dir / "entities" / "scitem" / "ships" / "controller"
    ship_lower = ship_class_name.lower()

    # Try exact match first, then base variant (excludes blade/mm variants)
    fc_file = ctrl_dir / f"controller_flight_{ship_lower}.xml.xml"
    if not fc_file.exists():
        candidates = sorted(ctrl_dir.glob(f"controller_flight_{ship_lower}*.xml.xml"))
        base = [f for f in candidates
                if not any(x in f.stem for x in ("blade", "_mm_", "rework", "_pu_"))]
        fc_file = base[0] if base else (candidates[0] if candidates else None)
        if not fc_file:
            return {}

    try:
        root = ET.parse(fc_file).getroot()
    except Exception:
        return {}

    ifcs = root.find(".//IFCSParams")
    if ifcs is None:
        return {}

    # ── Direct speed values ────────────────────────────────────────────────────
    scm_speed = safe_float(ifcs.get("scmSpeed", 0))
    nav_speed = safe_float(ifcs.get("maxSpeed", 0))
    boost_fwd = safe_float(ifcs.get("boostSpeedForward", 0))
    boost_bwd = safe_float(ifcs.get("boostSpeedBackward", 0))

    # ── Angular velocity ───────────────────────────────────────────────────────
    mv = ifcs.find("maxAngularVelocity")
    pitch = safe_float(mv.get("x", 0)) if mv is not None else 0.0
    roll  = safe_float(mv.get("y", 0)) if mv is not None else 0.0
    yaw   = safe_float(mv.get("z", 0)) if mv is not None else 0.0

    # ── Afterburner params  (<afterburner> NOT <afterburnerNew>) ───────────────
    # There are two elements in the XML: afterburnerNew (intermediate) and
    # afterburner (final values used by the game).  find() returns afterburnerNew
    # first since it appears first in the file, so we explicitly grab the LAST one.
    all_ab = ifcs.findall("afterburner")
    ab = all_ab[-1] if all_ab else None

    ramp_up = ramp_down = 0.0
    boost_pitch = boost_roll = boost_yaw = 0.0
    if ab is not None:
        ramp_up   = safe_float(ab.get("afterburnerRampUpTime", 0))
        ramp_down = safe_float(ab.get("afterburnerRampDownTime", 0))
        av_mul = ab.find("afterburnAngVelocityMultiplier")
        if av_mul is not None:
            boost_pitch = round(pitch * safe_float(av_mul.get("x", 1)), 1)
            boost_roll  = round(roll  * safe_float(av_mul.get("y", 1)), 1)
            boost_yaw   = round(yaw   * safe_float(av_mul.get("z", 1)), 1)
        else:
            boost_pitch, boost_roll, boost_yaw = pitch, roll, yaw

    # ── Thruster power bars (minimumConsumptionFraction of flight controller) ──
    # minimumConsumptionFraction = 1/N where N = number of power bars available
    thruster_power_bars = 4  # default if not found
    min_frac_el = root.find(".//ItemResourceDeltaConsumption")
    if min_frac_el is not None:
        min_frac = safe_float(min_frac_el.get("minimumConsumptionFraction", "0"))
        if 0 < min_frac <= 1:
            thruster_power_bars = round(1 / min_frac)

    # ── QD spool delay (ifcsCoreParams.bootWaitTime) ──────────────────────────
    core = ifcs.find("ifcsCoreParams")
    qd_spool = safe_float(core.get("bootWaitTime", 0)) if core is not None else 0.0

    # ── Linear acceleration (G's) ──────────────────────────────────────────────
    # accel (m/s²) = scmSpeed / timeToFullSpeed × linearScale  →  G = accel / 9.81
    # Axes: x = strafe, y = forward/retro, z = up/down
    G = 9.81
    sp = ifcs.find("speedProfile")
    pos_t = sp.find("positiveLinearTimeToFullSpeed") if sp is not None else None
    neg_t = sp.find("negativeLinearTimeToFullSpeed") if sp is not None else None

    # Per-axis scale multipliers (differentiates axes when times are equal)
    pos_s = ifcs.find("positiveLinearScale")
    neg_s = ifcs.find("negativeLinearScale")
    sc_fwd     = safe_float(pos_s.get("y", 1)) if pos_s is not None else 1.0
    sc_retro   = safe_float(neg_s.get("y", 1)) if neg_s is not None else 1.0
    sc_strafe  = safe_float(pos_s.get("x", 1)) if pos_s is not None else 1.0
    sc_up      = safe_float(pos_s.get("z", 1)) if pos_s is not None else 1.0
    sc_down    = safe_float(neg_s.get("z", 1)) if neg_s is not None else 1.0

    t_fwd    = safe_float(pos_t.get("y", 0)) if pos_t is not None else 0.0
    t_retro  = safe_float(neg_t.get("y", 0)) if neg_t is not None else 0.0
    t_strafe = safe_float(pos_t.get("x", 0)) if pos_t is not None else 0.0
    t_up     = safe_float(pos_t.get("z", 0)) if pos_t is not None else 0.0
    t_down   = safe_float(neg_t.get("z", 0)) if neg_t is not None else 0.0

    accel_fwd    = (scm_speed / t_fwd    / G * sc_fwd)    if t_fwd    > 0 else 0.0
    accel_retro  = (scm_speed / t_retro  / G * sc_retro)  if t_retro  > 0 else 0.0
    accel_strafe = (scm_speed / t_strafe / G * sc_strafe) if t_strafe > 0 else 0.0
    accel_up     = (scm_speed / t_up     / G * sc_up)     if t_up     > 0 else 0.0
    accel_down   = (scm_speed / t_down   / G * sc_down)   if t_down   > 0 else 0.0

    # AB multipliers per axis (from final <afterburner> element)
    ab_mul_pos_x = ab_mul_pos_y = ab_mul_pos_z = 1.0
    ab_mul_neg_x = ab_mul_neg_y = ab_mul_neg_z = 1.0
    if ab is not None:
        ab_pos_mul = ab.find("afterburnAccelMultiplierPositive")
        ab_neg_mul = ab.find("afterburnAccelMultiplierNegative")
        if ab_pos_mul is not None:
            ab_mul_pos_x = safe_float(ab_pos_mul.get("x", 1))
            ab_mul_pos_y = safe_float(ab_pos_mul.get("y", 1))
            ab_mul_pos_z = safe_float(ab_pos_mul.get("z", 1))
        if ab_neg_mul is not None:
            ab_mul_neg_x = safe_float(ab_neg_mul.get("x", 1))
            ab_mul_neg_y = safe_float(ab_neg_mul.get("y", 1))
            ab_mul_neg_z = safe_float(ab_neg_mul.get("z", 1))

    accel_ab_fwd    = accel_fwd    * ab_mul_pos_y
    accel_ab_retro  = accel_retro  * ab_mul_neg_y
    accel_ab_strafe = accel_strafe * ab_mul_pos_x
    accel_ab_up     = accel_up     * ab_mul_pos_z
    accel_ab_down   = accel_down   * ab_mul_neg_z

    return {
        "scmSpeed":      round(scm_speed, 0),
        "navSpeed":      round(nav_speed, 0),
        "boostSpeedFwd": round(boost_fwd, 0),
        "boostSpeedBwd": round(boost_bwd, 0),
        "boostRampUp":   round(ramp_up, 2),
        "boostRampDown": round(ramp_down, 2),
        "pitch":         round(pitch, 1),
        "yaw":           round(yaw, 1),
        "roll":          round(roll, 1),
        "pitchBoosted":  boost_pitch,
        "yawBoosted":    boost_yaw,
        "rollBoosted":   boost_roll,
        "qdSpoolDelay":  round(qd_spool, 1),
        "accelFwd":      round(accel_fwd, 1),
        "accelRetro":    round(accel_retro, 1),
        "accelStrafe":   round(accel_strafe, 1),
        "accelUp":       round(accel_up, 1),
        "accelDown":     round(accel_down, 1),
        "accelAbFwd":    round(accel_ab_fwd, 1),
        "accelAbRetro":  round(accel_ab_retro, 1),
        "accelAbStrafe": round(accel_ab_strafe, 1),
        "accelAbUp":     round(accel_ab_up, 1),
        "accelAbDown":   round(accel_ab_down, 1),
        "thrusterPowerBars":  thruster_power_bars,
    }


# ── Vehicle XML parsing ────────────────────────────────────────────────────────

SKIP_TYPES = {
    "SeatAccess", "LandingSystem", "DoorController", "MultiLight",
    "WeaponController", "CommsController", "Scanner", "FuelIntake",
    "FuelTank", "ManneuverThruster", "MainThruster", "WeaponDefensive",
    "CountermeasureLauncher", "Door", "Elevator", "Avionics",
    "SelfDestruct", "PowerDistribution",
    "FuelController", "CargoContainer",
}

KEEP_TYPES = {
    "WeaponGun", "WeaponTachyon", "WeaponMining", "MissileLauncher",
    "BombLauncher", "Turret", "TurretBase", "Shield", "PowerPlant", "Cooler", "LifeSupportGenerator",
    "QuantumDrive", "Radar", "Sensor", "QuantumFuelTank", "MiningModifier", "ToolArm", "UtilityTurret", "SalvageHead", "SalvageModifier",
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

    # Flight spool delay from Spaceship element (engineWarmupDelay)
    flight_spool_delay = 0.0
    for sp_el in root.iter("Spaceship"):
        v = sp_el.get("engineWarmupDelay")
        if v:
            flight_spool_delay = safe_float(v)
            break

    # Hull HP: sum of all Part.damageMax; body HP is the "Body" part
    total_hp = 0.0
    body_hp = 0.0
    vital_parts = {}
    for part in root.iter("Part"):
        dm = part.get("damageMax")
        if not dm:
            continue
        hp_val = safe_float(dm)
        total_hp += hp_val
        name = part.get("name", "")
        if name.lower() == "body":
            body_hp = hp_val
        # Collect named structural parts (skip sub-flaps etc.)
        if name and "_Flap" not in name and "_Tip" not in name:
            vital_parts[name] = hp_val

    # If no explicit "body" part, use the largest HP part as vital
    if body_hp == 0 and vital_parts:
        body_hp = max(vital_parts.values())

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

        min_size = safe_int(item_port.get("minSize") or item_port.get("minsize", 0))
        max_size = safe_int(item_port.get("maxSize") or item_port.get("maxsize", 0))
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
            label = loc.get(display_attr.lower()) or loc.get("itemport_" + display_attr.lower()) or display_attr
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

        controller_def = item_port.find("ControllerDef")
        controller_tag = controller_def.get("controllableTags", "") if controller_def is not None else ""
        port_tags = item_port.get("portTags", "")

        hp_entry = {
            "id":       hp_id,
            "label":    label,
            "type":     primary_type,
            "subtypes": port_types[0].get("subtypes", ""),
            "minSize":  min_size,
            "maxSize":  max_size,
            "flags":    flags.strip(),
            "allTypes": port_types,
        }
        if controller_tag:
            hp_entry["controllerTag"] = controller_tag
        if port_tags:
            hp_entry["portTags"] = port_tags
        hardpoints.append(hp_entry)

    if not hardpoints:
        return None

    return {
        "className":        class_name,
        "name":             display_name,
        "manufacturer":     manufacturer,
        "mass":             round(mass, 0),
        "size":             "unknown",
        "role":             "",
        "career":           "",
        "crew":             1,
        "hardpoints":       hardpoints,
        "flightSpoolDelay": round(flight_spool_delay, 1),
        # Hull HP
        "totalHp":          round(total_hp, 0),
        "bodyHp":           round(body_hp, 0),
        "vitalParts":       {k: round(v, 0) for k, v in vital_parts.items() if k.lower() != "body"},
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

def parse_cooling_demand(root):
    """
    Extract cooling demand fields from a component's ItemResourceState(Online).
    Returns: {minConsumptionFraction, psruRef}
    - minConsumptionFraction: from the delta that consumes Power (Conversion or Consumption)
    - psruRef: hex index of SPowerSegmentResourceUnit for power consumption
    """
    mcf = 0.0
    psru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    # MCF from any delta that consumes Power (Conversion first, then Consumption)
    for tag in ("ItemResourceDeltaConversion", "ItemResourceDeltaConsumption"):
        for delta in root.iter(tag):
            cons = delta.find("consumption")
            if cons is not None and cons.get("resource") == "Power":
                mcf = safe_float(delta.get("minimumConsumptionFraction", "0"))
                break
        if mcf > 0:
            break
    # PSRU ref from consumption resource="Power"
    m = re.search(r'<consumption\s+resource="Power"[^>]*SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\]', txt)
    if not m:
        m = re.search(r'SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\][^<]*resource="Power"', txt)
    if m:
        psru_ref = m.group(1)
    return {"minConsumptionFraction": round(mcf, 6), "psruRef": psru_ref}


def parse_power_ranges(root):
    """
    Extract power segment ranges from ItemResourceState(Online).
    Returns: {powerMin, powerMax, powerBands: [{start, mod}]}
    powerBands contains only active bands (registerRange > 0), sorted by start.
    """
    power_bands = []
    power_max = 0
    for state in root.iter("ItemResourceState"):
        if state.get("name") != "Online":
            continue
        pr = state.find("powerRanges")
        if pr is None:
            break
        for lvl_name in ("low", "medium", "high"):
            lvl = pr.find(lvl_name)
            if lvl is None:
                continue
            start = int(safe_float(lvl.get("start", 0)))
            r_range = int(safe_float(lvl.get("registerRange", 0)))
            mod = round(safe_float(lvl.get("modifier", 1.0)), 2)
            if r_range > 0:
                power_bands.append({"start": start, "mod": mod})
                power_max = max(power_max, start + r_range)
        break
    power_min = power_bands[0]["start"] if power_bands else 0
    return {"powerMin": power_min, "powerMax": power_max, "powerBands": power_bands}

def get_em_signature(root):
    em = root.find(".//EMSignature")
    if em is not None:
        return safe_float(em.get("nominalSignature", 0))
    return 0.0

def extract_fire_rate(root):
    """Extract fire rate in RPM from weapon XML.
    Handles both rapid-fire (SWeaponActionFireRapidParams.fireRate)
    and sequence-based (SWeaponSequenceEntryParams delay/unit) formats.
    """
    # Rapid-fire weapons store rate directly
    rapid = root.find(".//SWeaponActionFireRapidParams")
    if rapid is not None:
        fr = safe_float(rapid.get("fireRate", 0))
        if fr > 0:
            return fr
    # Sequence-based weapons: delay attribute with unit RPM or Seconds
    seq = root.find(".//SWeaponSequenceEntryParams")
    if seq is not None:
        delay = safe_float(seq.get("delay", 0))
        unit  = seq.get("unit", "RPM")
        if delay > 0:
            return delay if unit == "RPM" else round(60.0 / delay, 1)
    return 0.0

def parse_weapon_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] not in ("WeaponGun", "WeaponTachyon", "WeaponMining"):
        return None

    ammo_ref = ""
    max_ammo_count = 0
    max_restock_count = 3  # default
    ammo_cont = root.find(".//SAmmoContainerComponentParams")
    if ammo_cont is not None:
        ammo_ref = ammo_cont.get("ammoParamsRecord", "")
        max_ammo_count = safe_int(ammo_cont.get("maxAmmoCount", "0"))
        max_restock_count = safe_int(ammo_cont.get("maxRestockCount", "3"))

    # Extract SStandardResourceUnit hex ref for DCB power draw enrichment
    sru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    m_sru = re.search(r'resource="Power"[^>]*resourceAmountPerSecond="SStandardResourceUnit\[([0-9A-Fa-f]+)\]"', txt)
    if m_sru:
        sru_ref = m_sru.group(1)

    # Heat params for overheat calculation
    heat_per_shot = 0.0
    heat_ref = ""
    # heatPerShot can be on fire action params or anywhere in the weapon XML
    m_hps = re.search(r'heatPerShot="([^"]+)"', txt)
    if m_hps:
        heat_per_shot = safe_float(m_hps.group(1))
    m_heat = re.search(r'simplifiedHeatParams="SWeaponSimplifiedHeatParams\[([0-9A-Fa-f]+)\]"', txt)
    if m_heat:
        heat_ref = m_heat.group(1)

    fire_rate = extract_fire_rate(root)
    display = resolve_item_name(loc, class_name)
    # Try XML Localization Name directly (handles non-standard naming like Pitman)
    loc_el = root.find(".//Localization")
    if loc_el is not None:
        loc_ref = loc_el.get("Name", "")
        if loc_ref.startswith("@"):
            key = loc_ref[1:].lower()
            v = loc.get(key)
            if v and not v.startswith("@") and len(v) > 2:
                display = v

    # Mining laser modifier references (FloatModifierMultiplicative)
    mining_mod_refs = {}
    for ref_name in ("laserInstability", "optimalChargeWindowSizeModifier", "resistanceModifier"):
        m_ref = re.search(rf'{ref_name}="FloatModifierMultiplicative\[([0-9A-Fa-f]+)\]"', txt)
        if m_ref:
            mining_mod_refs[ref_name] = m_ref.group(1)

    # Count mining module slots (MiningModifier ports)
    module_slots = 0
    for port_def in root.iter("SItemPortDef"):
        for type_el in port_def.findall(".//SItemPortDefTypes"):
            if type_el.get("Type") == "MiningModifier":
                module_slots += 1
                break

    # Mining laser range, throttle, and DPS refs for power values
    m_fdr = re.search(r'fullDamageRange="([^"]+)"', txt)
    m_zdr = re.search(r'zeroDamageRange="([^"]+)"', txt)
    m_tmin = re.search(r'throttleMinimum="([^"]+)"', txt)
    optimal_range = safe_float(m_fdr.group(1)) if m_fdr else None
    max_range = safe_float(m_zdr.group(1)) if m_zdr else None
    throttle_min = safe_float(m_tmin.group(1)) if m_tmin else None
    # DamageInfo refs — used to read max power from DCB
    dps_refs = re.findall(r'damagePerSecond="DamageInfo\[([0-9A-Fa-f]+)\]"', txt)
    mining_dps_ref = dps_refs[-1] if dps_refs else None  # last ref = max power mode

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
        "fireRate":       fire_rate,
        "isBallistic":    max_ammo_count > 0,
        "maxRestockCount": max_restock_count,
        "sruRef":         sru_ref,
        "heatPerShot":    round(heat_per_shot, 4) if heat_per_shot > 0 else None,
        "heatRef":        heat_ref,
        "moduleSlots":    module_slots if module_slots > 0 else None,
        "miningModRefs":  mining_mod_refs if mining_mod_refs else None,
        "optimalRange":   optimal_range,
        "maxRange":       max_range,
        "throttleMin":    throttle_min,
        "_miningDpsRef":  mining_dps_ref,
        "damage": {
            "physical": 0.0, "energy": 0.0, "distortion": 0.0,
            "thermal": 0.0, "biochemical": 0.0, "stun": 0.0,
        },
        "alphaDamage":    0.0,
        "dps":            0.0,
        "projectileSpeed": 0.0,
        "range":          0.0,
        "ammoCount":      max_ammo_count if max_ammo_count > 0 else None,
    }

def parse_missile_rack_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] not in ("MissileLauncher", "BombLauncher"):
        return None
    display = resolve_item_name(loc, class_name)
    # Count sub-ports to determine capacity
    ports = root.findall(".//SItemPortDef")
    capacity = len(ports)
    missile_size = 0
    if ports:
        missile_size = safe_int(ports[0].get("MaxSize", 0))
    return {
        "className":     class_name,
        "name":          display,
        "manufacturer":  mfr_from_classname(class_name),
        "type":          info["type"],
        "subType":       info["subType"],
        "size":          info["size"],
        "grade":         info["grade"],
        "capacity":      capacity,
        "missileSize":   missile_size,
    }

def parse_missile_projectile_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Missile":
        return None
    # Guidance type from Tags (IR, EM, CS)
    tags = info.get("tags", "") or (root.find(".//AttachDef") or root).get("Tags", "")
    guidance = ""
    for g in ("IR", "EM", "CS"):
        if g in tags.split():
            guidance = g
            break
    # Speed from GCSParams
    gcs = root.find(".//GCSParams")
    speed = safe_float(gcs.get("linearSpeed", 0)) if gcs is not None else 0.0
    # Arm time and ignite time from SCItemMissileParams
    mp = root.find(".//SCItemMissileParams")
    arm_time    = safe_float(mp.get("armTime",    0)) if mp is not None else 0.0
    ignite_time = safe_float(mp.get("igniteTime", 0)) if mp is not None else 0.0
    # Lock/targeting params
    tp = root.find(".//targetingParams")
    lock_time     = safe_float(tp.get("lockTime",     0)) if tp is not None else 0.0
    lock_angle    = safe_float(tp.get("lockingAngle", 0)) if tp is not None else 0.0
    lock_range_min = safe_float(tp.get("lockRangeMin", 0)) if tp is not None else 0.0
    lock_range_max = safe_float(tp.get("lockRangeMax", 0)) if tp is not None else 0.0
    acquisition   = tp.get("trackingSignalType", "") if tp is not None else ""
    # DamageInfo index from explosionParams (resolved later in enrich_from_dcb)
    damage_info_idx = -1
    txt = ET.tostring(root, encoding='unicode')
    m = re.search(r'damage=["\']DamageInfo\[([0-9A-Fa-f]+)\]["\']', txt)
    if m:
        damage_info_idx = int(m.group(1), 16)
    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Missile",
        "subType":      guidance,
        "size":         info["size"],
        "grade":        info["grade"],
        "projectileSpeed": round(speed, 0),
        "armTime":      arm_time,
        "igniteTime":   ignite_time,
        "lockTime":     lock_time,
        "lockAngle":    lock_angle,
        "lockRangeMin": lock_range_min,
        "lockRangeMax": lock_range_max,
        "acquisition":  acquisition,
        "_damageInfoIdx": damage_info_idx,
        "alphaDamage":  0.0,
        "damage": {"physical": 0.0, "energy": 0.0, "distortion": 0.0,
                   "thermal": 0.0, "biochemical": 0.0, "stun": 0.0},
    }

def parse_shield_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Shield":
        return None
    sg = root.find(".//SCItemShieldGeneratorParams")
    if sg is None:
        return None

    # Shield resistances: [Physical, Energy, Distortion] in XML order
    resist_els = sg.findall(".//ShieldResistance/SShieldResistance")
    def get_resist(idx):
        if idx >= len(resist_els): return (0.0, 0.0)
        el = resist_els[idx]
        return (safe_float(el.get("Max", 0)), safe_float(el.get("Min", 0)))
    r_phys = get_resist(0)
    r_enrg = get_resist(1)
    r_dist = get_resist(2)

    # Shield absorption: [Physical, Energy, Distortion, ...] in XML order
    absorb_els = sg.findall(".//ShieldAbsorption/SShieldAbsorption")
    def get_absorb(idx):
        if idx >= len(absorb_els): return (0.0, 0.0)
        el = absorb_els[idx]
        return (safe_float(el.get("Max", 0)), safe_float(el.get("Min", 0)))
    a_phys = get_absorb(0)
    a_enrg = get_absorb(1)
    a_dist = get_absorb(2)

    # Distortion stats
    dist_el = root.find(".//SDistortionParams")
    dist_max = dist_decay_delay = dist_decay_rate = 0.0
    if dist_el is not None:
        dist_max         = safe_float(dist_el.get("Maximum", 0))
        dist_decay_delay = safe_float(dist_el.get("DecayDelay", 0))
        dist_decay_rate  = safe_float(dist_el.get("DecayRate", 0))

    # EM signature
    em_max = em_decay = 0.0
    for em_el in root.iter("EMSignature"):
        v = safe_float(em_el.get("nominalSignature", 0))
        if v > 0:
            em_max   = v
            em_decay = safe_float(em_el.get("decayRate", 0))
            break

    # Component health & self-repair
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0
    repair_el = root.find(".//selfRepair")
    repair_time = repair_ratio = 0.0
    if repair_el is not None:
        repair_time  = safe_float(repair_el.get("timeToRepair", 0))
        repair_ratio = safe_float(repair_el.get("healthRatio", 0))

    # Cooling demand fields (PSRU + MCF)
    cooling = parse_cooling_demand(root)

    display = resolve_item_name(loc, class_name)
    grade_letter, item_class = resolve_grade_and_class(loc, class_name)
    return {
        "className":          class_name,
        "name":               display,
        "manufacturer":       mfr_from_classname(class_name),
        "type":               "Shield",
        "size":               info["size"],
        "grade":              grade_letter or info["grade"],
        "itemClass":          item_class,
        "psruRef":            cooling["psruRef"],
        "minConsumptionFraction": cooling["minConsumptionFraction"],
        # Shield pool
        "hp":                 safe_float(sg.get("MaxShieldHealth", 0)),
        "regenRate":          safe_float(sg.get("MaxShieldRegen", 0)),
        "damagedRegenDelay":  safe_float(sg.get("DamagedRegenDelay", 0)),
        "downedRegenDelay":   safe_float(sg.get("DownedRegenDelay", 0)),
        # Resistances (as fractions, e.g. 0.25 = 25%)
        "resistPhysMax":  round(r_phys[0], 4),
        "resistPhysMin":  round(r_phys[1], 4),
        "resistEnrgMax":  round(r_enrg[0], 4),
        "resistEnrgMin":  round(r_enrg[1], 4),
        "resistDistMax":  round(r_dist[0], 4),
        "resistDistMin":  round(r_dist[1], 4),
        # Absorption (as fractions)
        "absPhysMax":  round(a_phys[0], 4),
        "absPhysMin":  round(a_phys[1], 4),
        "absEnrgMax":  round(a_enrg[0], 4),
        "absEnrgMin":  round(a_enrg[1], 4),
        "absDistMax":  round(a_dist[0], 4),
        "absDistMin":  round(a_dist[1], 4),
        # Distortion resistance
        "distortionMax":        round(dist_max, 0),
        "distortionDecayDelay": round(dist_decay_delay, 1),
        "distortionDecayRate":  round(dist_decay_rate, 0),
        # EM
        "emMax":      round(em_max, 0),
        "emDecayRate": round(em_decay, 2),
        # Component health & repair
        "componentHp":     round(component_hp, 0),
        "selfRepairTime":  round(repair_time, 1),
        "selfRepairRatio": round(repair_ratio, 2),
        # Power segments
        **parse_power_ranges(root),
    }

def parse_powerplant_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "PowerPlant":
        return None

    # Power output via DCB SPowerSegmentResourceUnit (resolved in enrich_from_dcb)
    psru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    m = re.search(r'resource=["\']Power["\'][^>]*SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\]', txt)
    if not m:
        m = re.search(r'SPowerSegmentResourceUnit\[([0-9A-Fa-f]+)\][^<]{0,60}resource=["\']Power["\']', txt)
    if m:
        psru_ref = m.group(1)

    # Distortion resistance
    dist_el = root.find(".//SDistortionParams")
    dist_max = dist_decay_delay = dist_decay_rate = 0.0
    if dist_el is not None:
        dist_max         = safe_float(dist_el.get("Maximum", 0))
        dist_decay_delay = safe_float(dist_el.get("DecayDelay", 0))
        dist_decay_rate  = safe_float(dist_el.get("DecayRate", 0))

    # EM signature
    em_max = em_decay = 0.0
    for em_el in root.iter("EMSignature"):
        v = safe_float(em_el.get("nominalSignature", 0))
        if v > 0:
            em_max   = v
            em_decay = safe_float(em_el.get("decayRate", 0))
            break

    # Misfire explosion
    misfire_el = root.find(".//SHostExplosionEffect")
    misfire_countdown = misfire_cancel_ratio = 0.0
    if misfire_el is not None:
        misfire_countdown    = safe_float(misfire_el.get("explosionCountdown", 0))
        misfire_cancel_ratio = safe_float(misfire_el.get("healthCancelRatio", 0))

    # Component health & self-repair
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0
    repair_el = root.find(".//selfRepair")
    repair_time = repair_ratio = 0.0
    if repair_el is not None:
        repair_time  = safe_float(repair_el.get("timeToRepair", 0))
        repair_ratio = safe_float(repair_el.get("healthRatio", 0))

    display = resolve_item_name(loc, class_name)
    grade_letter, item_class = resolve_grade_and_class(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "PowerPlant",
        "size":         info["size"],
        "grade":        grade_letter or info["grade"],
        "itemClass":    item_class,
        "powerOutput":  0,
        "psruRef":      psru_ref,
        # Distortion
        "distortionMax":        round(dist_max, 2),
        "distortionDecayDelay": round(dist_decay_delay, 1),
        "distortionDecayRate":  round(dist_decay_rate, 2),
        # EM
        "emMax":      round(em_max, 0),
        "emDecayRate": round(em_decay, 2),
        # Misfire explosion
        "misfireCountdown":   round(misfire_countdown, 1),
        "misfireCancelRatio": round(misfire_cancel_ratio, 2),
        # Component health & repair
        "componentHp":     round(component_hp, 0),
        "selfRepairTime":  round(repair_time, 1),
        "selfRepairRatio": round(repair_ratio, 2),
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

    em_max = 0.0
    for em_el in root.iter("EMSignature"):
        v = safe_float(em_el.get("nominalSignature", 0))
        if v > 0:
            em_max = v
            break

    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0

    cooling = parse_cooling_demand(root)

    display = resolve_item_name(loc, class_name)
    grade_letter, item_class = resolve_grade_and_class(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Cooler",
        "size":         info["size"],
        "grade":        grade_letter or info["grade"],
        "itemClass":    item_class,
        "coolingRate":  round(cooling_rate, 1),
        "sruRef":       sru_ref,
        "psruRef":      cooling["psruRef"],
        "minConsumptionFraction": cooling["minConsumptionFraction"],
        # Power segments
        **parse_power_ranges(root),
        "emMax":        round(em_max, 0),
        "irSignature":  round(ir_sig, 1),
        "componentHp":  round(component_hp, 0),
    }

def parse_lifesupport_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "LifeSupportGenerator":
        return None
    cooling = parse_cooling_demand(root)
    # LS uses @item_Name references with different prefix than className
    display = resolve_item_name(loc, class_name)
    loc_el = root.find(".//Localization")
    if loc_el is not None:
        loc_ref = loc_el.get("Name", "")
        if loc_ref.startswith("@"):
            key = loc_ref[1:].lower()
            v = loc.get(key)
            if v and not v.startswith("@") and len(v) > 2:
                display = v
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "LifeSupportGenerator",
        "size":         info["size"],
        "grade":        info["grade"],
        "psruRef":      cooling["psruRef"],
        "minConsumptionFraction": cooling["minConsumptionFraction"],
        **parse_power_ranges(root),
    }


def parse_miningmodifier_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "MiningModifier":
        return None
    display = resolve_item_name(loc, class_name)
    # Try XML Localization Name directly
    loc_el = root.find(".//Localization")
    if loc_el is not None:
        loc_ref = loc_el.get("Name", "")
        if loc_ref.startswith("@"):
            key = loc_ref[1:].lower()
            v = loc.get(key)
            if v and not v.startswith("@") and len(v) > 2:
                display = v
    # Determine active vs passive from class name
    is_active = "active" in class_name.lower()
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "MiningModifier",
        "subType":      "Active" if is_active else "Passive",
        "size":         info["size"],
        "grade":        info["grade"],
    }


def parse_miningarm_item(root, class_name, loc):
    """Parse mining arms, mining modules, salvage modifiers (shared generic parser)."""
    info = parse_attachdef(root)
    if not info:
        return None
    display = resolve_item_name(loc, class_name)
    loc_el = root.find(".//Localization")
    if loc_el is not None:
        loc_ref = loc_el.get("Name", "")
        if loc_ref.startswith("@"):
            key = loc_ref[1:].lower()
            v = loc.get(key)
            if v and not v.startswith("@") and len(v) > 2:
                display = v
    item_type = info["type"]
    result = {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         item_type,
        "size":         info["size"],
        "grade":        info["grade"],
    }
    if item_type == "MiningModifier":
        result["subType"] = "Active" if "active" in class_name.lower() else "Passive"
        # Extract FloatModifierMultiplicative refs for DCB enrichment
        txt = ET.tostring(root, encoding='unicode')
        mod_refs = {}
        for m in re.finditer(r'(\w+)="FloatModifier(?:Multiplicative)?\[([0-9A-Fa-f]+)\]"', txt):
            mod_refs[m.group(1)] = m.group(2)
        if mod_refs:
            result["_miningModRefs"] = mod_refs
        charges = re.search(r'charges="(\d+)"', txt)
        if charges:
            result["charges"] = int(charges.group(1))
        # Active modules: extract damageMultiplier (power boost) from first showInUI=1 phase
        if "active" in class_name.lower():
            dms = [(float(m.group(1)), m.start()) for m in re.finditer(r'damageMultiplier="([^"]+)"', txt) if float(m.group(1)) != 1.0]
            for dm_val, pos in dms:
                ctx = txt[max(0, pos - 300):pos]
                if 'showInUI="1"' in ctx:
                    result["miningPowerMult"] = round(dm_val, 2)
                    break
    # Salvage modifier stats (scraper/tractor tools)
    if item_type == "SalvageModifier":
        txt = ET.tostring(root, encoding='unicode')
        m = re.search(r'salvageModifier\s+salvageSpeedMultiplier="([^"]+)"\s+radiusMultiplier="([^"]+)"\s+extractionEfficiency="([^"]+)"', txt)
        if m:
            result["salvageSpeed"] = round(safe_float(m.group(1)), 4)
            result["salvageRadius"] = round(safe_float(m.group(2)), 4)
            result["salvageEfficiency"] = round(safe_float(m.group(3)), 4)
    return result


def parse_salvagehead_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "SalvageHead":
        return None
    display = resolve_item_name(loc, class_name)
    loc_el = root.find(".//Localization")
    if loc_el is not None:
        loc_ref = loc_el.get("Name", "")
        if loc_ref.startswith("@"):
            key = loc_ref[1:].lower()
            v = loc.get(key)
            if v and not v.startswith("@") and len(v) > 2:
                display = v
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "SalvageHead",
        "size":         info["size"],
        "grade":        info["grade"],
    }


def parse_radar_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Radar":
        return None

    cooling = parse_cooling_demand(root)
    grade_letter, item_class = resolve_grade_and_class(loc, class_name)

    # Aim assist distances
    aim = root.find(".//aimAssist")
    aim_min = safe_float(aim.get("distanceMinAssignment", 0)) if aim is not None else 0.0
    aim_max = safe_float(aim.get("distanceMaxAssignment", 0)) if aim is not None else 0.0
    aim_buffer = safe_float(aim.get("outsideRangeBufferDistance", 0)) if aim is not None else 0.0

    # Signature detection — IR, EM, CS, RS sensitivities (first 4 detection entries)
    sig_dets = root.findall(".//SCItemRadarSignatureDetection")
    def get_sig(idx):
        if idx >= len(sig_dets): return 0.0
        return safe_float(sig_dets[idx].get("sensitivity", 0))

    # EM signature
    em_max = 0.0
    for em_el in root.iter("EMSignature"):
        v = safe_float(em_el.get("nominalSignature", 0))
        if v > 0:
            em_max = v
            break

    # Component HP
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0

    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Radar",
        "subType":      info.get("subType", ""),
        "size":         info["size"],
        "grade":        grade_letter or info["grade"],
        "itemClass":    item_class,
        "psruRef":      cooling["psruRef"],
        "minConsumptionFraction": cooling["minConsumptionFraction"],
        # Aim assist
        "aimMin":       round(aim_min, 0),
        "aimMax":       round(aim_max, 0),
        "aimBuffer":    round(aim_buffer, 0),
        # Signature detection sensitivities (IR=0, EM=1, CS=2, RS=3 in XML order)
        "irSensitivity": round(get_sig(0), 4),
        "emSensitivity": round(get_sig(1), 4),
        "csSensitivity": round(get_sig(2), 4),
        "rsSensitivity": round(get_sig(3), 4),
        # Signatures & health
        "emMax":        round(em_max, 0),
        "componentHp":  round(component_hp, 0),
        **parse_power_ranges(root),
    }


def parse_quantumdrive_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "QuantumDrive":
        return None

    qp = root.find(".//SCItemQuantumDriveParams")
    speed = spool_time = cooldown = stage1_accel = stage2_accel = 0.0
    interdiction_time = cal_delay = fuel_req = spline_speed = 0.0
    if qp is not None:
        fuel_req = safe_float(qp.get("quantumFuelRequirement", 0))
        params = qp.find("params")
        if params is not None:
            # driveSpeed in m/s → km/s
            speed          = safe_float(params.get("driveSpeed", 0)) / 1000.0
            spool_time     = safe_float(params.get("spoolUpTime", 0))
            cooldown       = safe_float(params.get("cooldownTime", 0))
            # accel in m/s² → km/s²
            stage1_accel   = safe_float(params.get("stageOneAccelRate", 0)) / 1000.0
            stage2_accel   = safe_float(params.get("stageTwoAccelRate", 0)) / 1000.0
            interdiction_time = safe_float(params.get("interdictionEffectTime", 0))
            cal_delay      = safe_float(params.get("calibrationDelayInSeconds", 0))
        spline = qp.find("splineJumpParams")
        if spline is not None:
            spline_speed   = safe_float(spline.get("driveSpeed", 0)) / 1000.0

    # Distortion stats
    dist_el = root.find(".//SDistortionParams")
    dist_max = dist_decay_delay = dist_decay_rate = 0.0
    if dist_el is not None:
        dist_max         = safe_float(dist_el.get("Maximum", 0))
        dist_decay_delay = safe_float(dist_el.get("DecayDelay", 0))
        dist_decay_rate  = safe_float(dist_el.get("DecayRate", 0))

    # EM signature (from Online state)
    em_max = em_decay = 0.0
    for em_el in root.iter("EMSignature"):
        v = safe_float(em_el.get("nominalSignature", 0))
        if v > 0:
            em_max   = v
            em_decay = safe_float(em_el.get("decayRate", 0))
            break

    # Health
    hp_el = root.find(".//SHealthComponentParams")
    hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0

    # Self repair
    repair_el = root.find(".//selfRepair")
    repair_time = repair_ratio = 0.0
    if repair_el is not None:
        repair_time  = safe_float(repair_el.get("timeToRepair", 0))
        repair_ratio = safe_float(repair_el.get("healthRatio", 0))

    # SStandardResourceUnit ref for power consumption (= pip count for QDs)
    sru_ref = ""
    txt = ET.tostring(root, encoding='unicode')
    m_sru = re.search(r'<consumption\s+resource="Power"[^>]*SStandardResourceUnit\[([0-9A-Fa-f]+)\]', txt)
    if not m_sru:
        m_sru = re.search(r'SStandardResourceUnit\[([0-9A-Fa-f]+)\][^<]*resource="Power"', txt)
    if m_sru:
        sru_ref = m_sru.group(1)

    display = resolve_item_name(loc, class_name)
    grade_letter, item_class = resolve_grade_and_class(loc, class_name)
    return {
        "className":        class_name,
        "name":             display,
        "manufacturer":     mfr_from_classname(class_name),
        "type":             "QuantumDrive",
        "size":             info["size"],
        "grade":            grade_letter or info["grade"],
        "itemClass":        item_class,
        "sruRef":           sru_ref,
        # Travel (normal)
        "speed":            round(speed, 0),
        "spoolTime":        round(spool_time, 1),
        "cooldownTime":     round(cooldown, 1),
        "stageOneAccel":    round(stage1_accel, 0),
        "stageTwoAccel":    round(stage2_accel, 0),
        "interdictionTime": round(interdiction_time, 1),
        "calDelay":         round(cal_delay, 1),
        "fuelRate":         round(fuel_req, 5),
        # Spline travel
        "splineSpeed":      round(spline_speed, 0),
        # Distortion resistance
        "distortionMax":    round(dist_max, 0),
        "distortionDecayDelay": round(dist_decay_delay, 1),
        "distortionDecayRate":  round(dist_decay_rate, 0),
        # EM
        "emMax":            round(em_max, 0),
        "emDecayRate":      round(em_decay, 2),
        # Health & repair
        "hp":               round(hp, 0),
        "selfRepairTime":   round(repair_time, 1),
        "selfRepairRatio":  round(repair_ratio, 2),
        # Power segments
        **parse_power_ranges(root),
    }

def parse_weapon_mount_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "Turret":
        return None
    # Accept gimbals/fixed mounts, ball turrets, canard (nose) turrets, and PDC turrets
    if info["subType"] not in ("GunTurret", "Gun", "BallTurret", "CanardTurret", "PDCTurret"):
        return None
    # Use the XML's Localization Name ref to check for a real display name.
    # Falling back to class-name derivation misses items whose loc key doesn't
    # match the filename (e.g. anvl_hornet_f7a_ball_turret -> Mk2 key).
    loc_el = (root.find(".//AttachDef/Localization") or
              root.find(".//Localization"))
    loc_name_ref = loc_el.get("Name", "") if loc_el is not None else ""
    display = loc_lookup(loc, loc_name_ref) if loc_name_ref else resolve_item_name(loc, class_name)
    # Skip items with no real display name (internal/bespoke ship parts)
    if not display or display.startswith("@") or display == class_name:
        display = resolve_item_name(loc, class_name)
    if not display or display.startswith("@"):
        return None
    # Turrets whose sub-slot weapons are locked to a specific className.
    # Key: turret className (lower), Value: weapon className that must be equipped.
    TURRET_WEAPON_LOCK = {
        "anvl_hornet_f7cm_mk2_ball_turret_bespoke": "behr_ballisticgatling_hornet_bespoke",
    }

    # Extract ship-specific item tags (tags containing '_', strip '$' prefix).
    # These are used for port-tag filtering so items only appear in compatible slots.
    attach_el = root.find(".//AttachDef")
    tags_raw = (attach_el.get("Tags", "") if attach_el is not None else "").split()
    item_tags = [t.lstrip("$") for t in tags_raw if "_" in t]

    # Ball/Canard turrets are full turrets (equip to Turret-type hardpoints)
    # Gimbals/fixed mounts are weapon mounts (equip to WeaponGun-type hardpoints)
    if info["subType"] in ("BallTurret", "CanardTurret", "PDCTurret"):
        result = {
            "className":    class_name,
            "name":         display,
            "manufacturer": mfr_from_classname(class_name),
            "type":         "Turret",
            "subType":      info["subType"],
            "size":         info["size"],
            "grade":        info["grade"],
        }
        weapon_lock = TURRET_WEAPON_LOCK.get(class_name.lower())
        if weapon_lock:
            result["weaponLock"] = weapon_lock
        if item_tags:
            result["itemTags"] = item_tags
        return result
    result = {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "WeaponMount",
        "subType":      info["subType"],
        "size":         info["size"],
        "grade":        info["grade"],
    }
    if item_tags:
        result["itemTags"] = item_tags
    return result

# Maps forge subfolder -> parser function
FOLDER_PARSERS = {
    "weapons":           parse_weapon_item,
    "shieldgenerator":   parse_shield_item,
    "powerplant":        parse_powerplant_item,
    "cooler":            parse_cooler_item,
    "lifesupport":       parse_lifesupport_item,
    "radar":             parse_radar_item,
    "quantumdrive":      parse_quantumdrive_item,
    "missile_racks":     parse_missile_rack_item,
    "weapons/missiles":  parse_missile_projectile_item,
    "weapon_mounts":     parse_weapon_mount_item,
    "turret":            parse_weapon_mount_item,
    "utility/mining/miningarm": parse_miningarm_item,
    "utility/salvage/salvagehead": parse_salvagehead_item,
    "utility/salvage/salvagemodifiers": parse_miningarm_item,  # reuse generic parser
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
            # Strip entityclassdefinition. prefix used in some DCB files
            if class_name.lower().startswith("entityclassdefinition."):
                class_name = class_name[len("entityclassdefinition."):]
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
    """Match weapons to ammo params (speed, range)."""
    # Build a sorted-word index for fuzzy matching (handles word-order mismatches like PDC weapons)
    ammo_sorted = {}
    for key, val in ammo_data.items():
        sorted_key = "_".join(sorted(key.split("_")))
        ammo_sorted[sorted_key] = val
    speed_enriched = 0
    for item in items.values():
        if item.get("type") not in ("WeaponGun", "WeaponTachyon", "WeaponMining"):
            continue
        key = item.get("className", "").lower()
        data = ammo_data.get(key)
        if not data:
            sorted_key = "_".join(sorted(key.split("_")))
            data = ammo_sorted.get(sorted_key)
        if data:
            item["projectileSpeed"] = data["speed"]
            item["range"]           = data["range"]
            speed_enriched += 1
    print(f"  Enriched {speed_enriched} weapons with speed/range")

def compute_weapon_dps(items):
    """Compute DPS from alphaDamage (set by DCB) and fireRate (set by scan_components)."""
    dps_enriched = 0
    for item in items.values():
        if item.get("type") not in ("WeaponGun", "WeaponTachyon", "WeaponMining"):
            continue
        alpha = item.get("alphaDamage", 0.0)
        rpm   = item.get("fireRate", 0.0)
        if alpha > 0 and rpm > 0:
            item["dps"] = round(alpha * rpm / 60.0, 2)
            dps_enriched += 1
    print(f"  Computed DPS for {dps_enriched} weapons")

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

def _resolve_variant_name(variant_cls, loc):
    """Try multiple localization key patterns for a variant class name."""
    # Direct match: vehicle_namersi_constellation_andromeda
    key = f"vehicle_name{variant_cls}"
    if key in loc:
        return loc[key]
    # Strip common infixes like _gs_ (Aurora): rsi_aurora_gs_mr → rsi_aurora_mr
    stripped = re.sub(r'_gs_', '_', variant_cls)
    key2 = f"vehicle_name{stripped}"
    if key2 in loc:
        return loc[key2]
    # Fallback: title-case the class name
    return variant_cls.replace("_", " ").title()


def expand_ship_variants(ships, forge_dir, loc):
    """
    Detect ships that have multiple player-flyable variants in the DataForge
    spaceships directory and split them into separate entries.
    E.g., RSI_Constellation → RSI_Constellation_Andromeda, _Phoenix, _Taurus, _Aquila.
    Each variant clones the base ship's hardpoints/mass/HP and gets its own
    className, name, and (later) loadout/poolSize from the forge entity XML.
    """
    spaceship_dir = forge_dir / "entities" / "spaceships"
    if not spaceship_dir.exists():
        return ships

    # Suffixes that indicate non-player variants (AI, derelict, test, etc.)
    SKIP_SUFFIXES = re.compile(
        r'_pu_ai|_pu_pirate|_unmanned|_template|_ea_ai|_ea_outlaw|_pir$|_military|'
        r'_piano|_emerald|_indestructible|_dunlevy|_stealth|_exec|_hijacked|'
        r'_collector|_cleanair|_shop|_display|_invis|_civ_def|_salvage|_xenothreat|'
        r'_fleetweek|_restoration|_ninetails|_nt_qig|_blacjac|_crusader|_qig$|'
        r'_sec$|_hurstondynamics|_tutorial|_medivac|_derelict|_wreck|_boarded|'
        r'_teach$|_showdown$|_bis\d|_gamemaster|_invictus|_bombless|_s3bombs|'
        r'_nointerior|_nodebris|_citizencon|_drug|_shipshowdown|_shipboarded|'
        r'_tier_|_plat$|_fw_\d|_ai_|_nocargo|_halfcargo|_override|_spawn$|'
        r'_utility$|_civilian$|_stunt|_temp$|_crewless|_mission_|_swarm$|'
        r'_psec$|_advocacy$|_low_poly|_dropship'
    )

    expanded = {}
    variants_added = 0

    for base_cls, base_ship in ships.items():
        base_lower = base_cls.lower()
        # Find all forge entity XMLs that start with this base class name
        forge_files = sorted(spaceship_dir.glob(f"{base_lower}*.xml.xml"))

        # Filter to player-flyable variants
        player_variants = []
        for ff in forge_files:
            stem = ff.stem.replace(".xml", "")  # e.g., "rsi_constellation_andromeda"
            # Must start with the base name
            if not stem.lower().startswith(base_lower):
                continue
            suffix = stem[len(base_lower):]  # e.g., "_andromeda"
            # Skip non-player variants
            if SKIP_SUFFIXES.search(suffix):
                continue
            player_variants.append(stem)

        if len(player_variants) <= 1:
            # No variants or just the base — keep as-is
            # If there's exactly one variant and its name differs from base, rename
            if len(player_variants) == 1 and player_variants[0].lower() != base_lower:
                variant_cls = player_variants[0]
                clone = copy.deepcopy(base_ship)
                clone["className"] = variant_cls
                clone["name"] = _resolve_variant_name(variant_cls, loc)
                expanded[variant_cls] = clone
                variants_added += 1
            else:
                expanded[base_cls] = base_ship
        else:
            # Multiple variants — clone base for each
            for variant_cls in player_variants:
                clone = copy.deepcopy(base_ship)
                clone["className"] = variant_cls
                clone["name"] = _resolve_variant_name(variant_cls, loc)
                expanded[variant_cls] = clone
                variants_added += 1

    print(f"  Expanded {variants_added} variants from {len(ships)} base vehicles → {len(expanded)} total ships")
    return expanded


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
            loc_key = f"vehicle_name{stem.lower()}"
            if loc_key in loc:
                ship["name"] = loc[loc_key]

            # Bounding box dimensions (forge XML: x=width, y=length, z=height)
            bbox = root.find(".//maxBoundingBoxSize")
            if bbox is not None:
                ship["dimWidth"]  = safe_float(bbox.get("x", 0))
                ship["dimLength"] = safe_float(bbox.get("y", 0))
                ship["dimHeight"] = safe_float(bbox.get("z", 0))

            # Insurance
            ins = root.find(".//shipInsuranceParams")
            if ins is not None:
                ship["insuranceStandardMinutes"] = safe_float(ins.get("baseWaitTimeMinutes", 0))
                ship["insuranceExpediteMinutes"] = safe_float(ins.get("mandatoryWaitTimeMinutes", 0))
                ship["insuranceExpediteCost"]    = safe_int(ins.get("baseExpeditingFee", 0))

            # Penetration damage multipliers
            ship["fusePenetrationMult"]       = safe_float(vc.get("fusePenetrationDamageMultiplier", 0))
            ship["componentPenetrationMult"]  = safe_float(vc.get("componentPenetrationDamageMultiplier", 1))

            # Weapon power pool size (= max weapon pips assignable).
            for fp in root.iter("FixedPowerPool"):
                if fp.get("itemType", "").lower() == "weapongun":
                    pool_size = safe_int(fp.get("poolSize", 0))
                    if pool_size > 0:
                        ship["weaponPowerPoolSize"] = pool_size
                    break

            # Add hardpoints from forge entity XML that aren't in the vehicle XML
            existing_ids = {hp["id"].lower() for hp in ship.get("hardpoints", [])}
            for port_def in root.iter("SItemPortDef"):
                port_name = port_def.get("Name", "")
                if not port_name or port_name.lower() in existing_ids:
                    continue
                flags = port_def.get("Flags", "")
                if "invisible" in flags and "uneditable" in flags:
                    continue
                min_size = safe_int(port_def.get("MinSize", 0))
                max_size = safe_int(port_def.get("MaxSize", 0))
                if max_size == 0:
                    continue
                types_el = port_def.find("Types")
                if types_el is None:
                    continue
                port_type = ""
                for type_el in types_el.findall("SItemPortDefTypes"):
                    t = type_el.get("Type", "")
                    if t:
                        port_type = t
                        break
                if not port_type:
                    continue
                label = port_def.get("DisplayName", "")
                if label.startswith("@"):
                    label = loc.get(label[1:].lower(), port_name)
                ship["hardpoints"].append({
                    "id": port_name,
                    "label": label or port_name,
                    "type": port_type,
                    "subtypes": "",
                    "minSize": min_size,
                    "maxSize": max_size,
                    "flags": flags,
                    "allTypes": [{"type": port_type, "subtypes": ""}],
                })

            enriched += 1
        except Exception:
            pass
    print(f"  Enriched {enriched} ships from DCB entity data")

def extract_default_loadouts(ships, forge_dir, dcb_path):
    """
    Extract default loadout (port_name -> item_class_name) for each ship from DCB.
    Uses SItemPortLoadoutManualParams referenced in each ship's forge XML.

    SItemPortLoadoutEntryParams (44 bytes):
      [0:4]   text_off -> portName
      [4:8]   text_off -> className (empty when item referenced by GUID)
      [8:12]  u32 (record ref index, when GUID is present)
      [12:28] GUID -> entity class (looked up via DCB records table)
      [28:36] u32 x2 (flags, always 0xffffffff)
      [36:40] u32 -> child loadout struct index (== loadout_si when child exists)
      [40:44] u32 -> child loadout variant number
    """
    spaceship_dir = forge_dir / "entities" / "spaceships"
    if not spaceship_dir.exists() or not dcb_path.exists():
        return

    with open(dcb_path, "rb") as f:
        raw = f.read()

    def u32(p): return struct.unpack_from("<I", raw, p)[0]
    def i32(p): return struct.unpack_from("<i", raw, p)[0]
    def u16(p): return struct.unpack_from("<H", raw, p)[0]

    # Parse DCB header
    pos = 4; version = i32(pos); pos += 4
    if version >= 6: pos += 8
    n_structs = i32(pos); pos += 4; n_props = i32(pos); pos += 4
    n_enums = i32(pos); pos += 4; n_mappings = i32(pos); pos += 4
    n_records = i32(pos); pos += 4
    counts = [i32(pos + i*4) for i in range(19)]; pos += 76
    (c_bool,c_i8,c_i16,c_i32,c_i64,c_u8,c_u16,c_u32,c_u64,c_f32,
     c_f64,c_guid,c_str,c_loc,c_enum,c_strong,c_weak,c_ref,c_enum_opts) = counts
    text_len = u32(pos); pos += 4; blob_len = u32(pos); pos += 4

    struct_defs = []
    for _ in range(n_structs):
        struct_defs.append((u32(pos), u32(pos+4), u16(pos+8), u16(pos+10), u32(pos+12))); pos += 16
    pos += n_props * 12 + n_enums * 8
    mappings = []
    for _ in range(n_mappings):
        mappings.append((u32(pos), u32(pos+4))); pos += 8
    records_start = pos
    pos += n_records * 32  # skip records
    pos += c_i8+c_i16*2+c_i32*4+c_i64*8+c_u8+c_u16*2+c_u32*4+c_u64*8+c_bool
    pos += c_f32*4+c_f64*8+c_guid*16+c_str*4+c_loc*4+c_enum*4+c_strong*8+c_weak*8+c_ref*20+c_enum_opts*4
    text_start = pos; blob_start = text_start + text_len; data_start = blob_start + blob_len

    def blob(off): p = blob_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')
    def text_at(off):
        try: p = text_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')
        except: return ''

    struct_by_name = {}
    for i, (name_off,_,_,_,_) in enumerate(struct_defs):
        try: struct_by_name[blob(name_off)] = i
        except: pass

    struct_data = {}
    off = data_start
    for cnt, si in mappings:
        if si < len(struct_defs):
            struct_data[si] = (off, cnt); off += struct_defs[si][4] * cnt

    loadout_si = struct_by_name.get("SItemPortLoadoutManualParams")
    entry_si   = struct_by_name.get("SItemPortLoadoutEntryParams")
    if loadout_si not in struct_data or entry_si not in struct_data:
        print("  WARNING: Loadout structs not found in DCB")
        return

    l_off, l_cnt = struct_data[loadout_si]
    l_rs = struct_defs[loadout_si][4]   # 33 bytes
    e_off, e_cnt = struct_data[entry_si]
    e_rs = struct_defs[entry_si][4]     # 44 bytes

    # Build GUID -> class_name map from DCB records table.
    # Record layout (32 bytes): [0:4]=?, [4:8]=path_text_off, [8:12]=struct_idx, [12:28]=GUID, [28:32]=?
    guid_to_class = {}
    for i in range(n_records):
        rec_off = records_start + i * 32
        path_off = u32(rec_off + 4)
        guid = raw[rec_off+12:rec_off+28]
        if path_off < text_len:
            path = text_at(path_off)
            if path:
                stem = path.rsplit('/', 1)[-1].replace('.xml', '')
                cls = stem[len('entityclassdefinition.'):] if stem.startswith('entityclassdefinition.') else stem
                guid_to_class[guid] = cls

    _EMPTY_GUID = bytes(16)

    def read_loadout(variant, depth=0):
        """Return (portName -> className) for a loadout variant, resolving GUIDs
        and recursively following child loadouts (prefix child ports with parent port)."""
        if variant >= l_cnt or depth > 4: return {}
        inst = l_off + variant * l_rs
        count     = raw[inst + 25]
        start_idx = u32(inst + 29)
        if count == 0 or start_idx >= e_cnt: return {}
        result = {}
        for k in range(count):
            ei = e_off + (start_idx + k) * e_rs
            try:
                port = text_at(u32(ei + 0)).lower()
                cls  = text_at(u32(ei + 4)).lower()
                if not port:
                    continue
                # Resolve GUID when className is empty
                if not cls:
                    guid = raw[ei+12:ei+28]
                    if guid != _EMPTY_GUID:
                        cls = guid_to_class.get(guid, '')
                if cls:
                    result[port] = cls
                # Follow child loadout if present
                child_struct  = u32(ei + 36)
                child_variant = u32(ei + 40)
                if child_struct == loadout_si and child_variant < l_cnt:
                    children = read_loadout(child_variant, depth + 1)
                    for child_port, child_cls in children.items():
                        result[f"{port}.{child_port}"] = child_cls
            except Exception:
                pass
        return result

    enriched = 0
    for xml_file in sorted(spaceship_dir.glob("*.xml")):
        stem = xml_file.stem.replace(".xml", "")
        matched = next((k for k in ships if k.lower() == stem.lower()), None)
        if not matched:
            continue
        try:
            txt = xml_file.read_text(errors='replace')
            m = re.search(r'SItemPortLoadoutManualParams\[([0-9A-Fa-f]+)\]', txt)
            if not m:
                continue
            variant = int(m.group(1), 16)
            loadout = read_loadout(variant)
            if loadout:
                ships[matched]["defaultLoadout"] = loadout
                enriched += 1
        except Exception:
            pass
    print(f"  Default loadouts extracted: {enriched} ships")
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

def enrich_armor_from_forge(ships, forge_dir, dcb_path=None):
    """Read each ship's armor item XML and extract armor HP, deflection, signal modifiers, and hull damage multipliers."""
    armor_dir = forge_dir / "entities" / "scitem" / "ships" / "armor"
    if not armor_dir.exists():
        print(f"  WARNING: armor dir not found at {armor_dir}")
        return
    # Collect DamageInfo refs for DCB lookup
    dmg_info_refs = {}  # ship className -> hex index
    enriched = 0
    for ship in ships.values():
        armor_cls = (ship.get("defaultLoadout") or {}).get("hardpoint_armor", "")
        if not armor_cls:
            continue
        armor_file = armor_dir / f"{armor_cls.lower()}.xml.xml"
        if not armor_file.exists():
            continue
        try:
            root = ET.parse(armor_file).getroot()
            armor = root.find(".//SCItemVehicleArmorParams")
            if armor is not None:
                ship["signalEM"]          = safe_float(armor.get("signalElectromagnetic", 1))
                ship["signalCrossSection"]= safe_float(armor.get("signalCrossSection", 1))
                ship["signalIR"]          = safe_float(armor.get("signalInfrared", 1))
                defl = armor.find(".//deflectionValue")
                if defl is not None:
                    ship["armorDeflectPhys"] = safe_float(defl.get("DamagePhysical", 0))
                    ship["armorDeflectEnrg"] = safe_float(defl.get("DamageEnergy", 0))
                # Extract DamageInfo reference for hull damage multipliers
                txt = ET.tostring(root, encoding='unicode')
                m = re.search(r'damageMultiplier="DamageInfo\[([0-9A-Fa-f]+)\]"', txt)
                if m:
                    dmg_info_refs[ship["className"]] = m.group(1)
            hp_el = root.find(".//SHealthComponentParams")
            if hp_el is not None:
                ship["armorHp"] = safe_float(hp_el.get("Health", 0))
            enriched += 1
        except Exception:
            pass
    print(f"  Armor stats enriched: {enriched} ships")

    # Read hull damage multipliers from DCB DamageInfo records
    # Layout: 6 × f32 = 24 bytes (physical, energy, distortion, thermal, biochemical, stun)
    if dcb_path and dcb_path.exists() and dmg_info_refs:
        with open(dcb_path, "rb") as f:
            dcb_d = f.read()
        h = _dcb_parse_header(dcb_d)
        di_si = h["struct_by_name"].get("DamageInfo")
        if di_si is not None and di_si in h["struct_data"]:
            di_off, di_cnt = h["struct_data"][di_si]
            dmg_enriched = 0
            for cls_name, hex_idx in dmg_info_refs.items():
                idx = int(hex_idx, 16)
                if idx >= di_cnt:
                    continue
                phys, enrg, dist = struct.unpack_from("<fff", dcb_d, di_off + idx * 24)
                ship = ships[cls_name]
                ship["hullDmgPhys"] = round(phys, 2)
                ship["hullDmgEnrg"] = round(enrg, 2)
                ship["hullDmgDist"] = round(dist, 2)
                dmg_enriched += 1
            print(f"  Hull damage multipliers enriched: {dmg_enriched} ships")

def enrich_salvage_buffs(ships, forge_dir):
    """Extract per-ship salvage hull buff values from salvage_buff_modifier XMLs."""
    buff_dir = forge_dir / "entities" / "scitem" / "ships" / "utility" / "salvage" / "salvagemodifiers"
    if not buff_dir.exists():
        return
    enriched = 0
    for xml_file in buff_dir.glob("salvage_buff_modifier_*.xml.xml"):
        stem = xml_file.stem.replace(".xml", "")
        ship_key = stem.replace("salvage_buff_modifier_", "")
        if ship_key == "template":
            continue
        try:
            root = ET.parse(xml_file).getroot()
            txt = ET.tostring(root, encoding='unicode')
            m = re.search(r'salvageModifier\s+salvageSpeedMultiplier="([^"]+)"\s+radiusMultiplier="([^"]+)"\s+extractionEfficiency="([^"]+)"', txt)
            if not m:
                continue
            speed = safe_float(m.group(1))
            radius = safe_float(m.group(2))
            efficiency = safe_float(m.group(3))
            for cls, ship in ships.items():
                if ship_key in cls.lower():
                    ship["salvageSpeedMult"] = round(speed, 4)
                    ship["salvageRadiusMult"] = round(radius, 4)
                    ship["salvageEfficiency"] = round(efficiency, 4)
                    enriched += 1
        except Exception:
            pass
    print(f"  Salvage hull buffs applied: {enriched} ships")


def enrich_engineering_buffs(ships, forge_dir):
    """Extract maxAmmoLoadMultiplier from engineering_buff_modifier XMLs per ship."""
    buff_dir = forge_dir / "entities" / "scitem" / "ships" / "utility" / "engineering"
    if not buff_dir.exists():
        print(f"  WARNING: engineering buff dir not found")
        return
    enriched = 0
    for xml_file in buff_dir.glob("engineering_buff_modifier_*.xml.xml"):
        stem = xml_file.stem.replace(".xml", "")  # e.g., engineering_buff_modifier_anvl_asgard
        ship_key = stem.replace("engineering_buff_modifier_", "")  # e.g., anvl_asgard
        try:
            root = ET.parse(xml_file).getroot()
            regen_mod = root.find(".//regenModifier")
            if regen_mod is None:
                continue
            ammo_mult = safe_float(regen_mod.get("maxAmmoLoadMultiplier", "1"))
            if ammo_mult == 1.0:
                continue
            # Match to ships: buff key may be a prefix (e.g., "rsi_constellation" matches all variants)
            for cls, ship in ships.items():
                if cls.lower().startswith(ship_key) or cls.lower() == ship_key:
                    ship["ammoLoadMultiplier"] = round(ammo_mult, 4)
                    enriched += 1
        except Exception:
            pass
    print(f"  Engineering ammo buffs applied: {enriched} ships")


def enrich_cargo_capacity(ships, forge_dir, dcb_path=None):
    """Compute cargo capacity (SCU) per ship from inventory containers + mining pods."""
    # Scan both inventory container directories
    inv_dirs = [
        forge_dir / "inventorycontainers" / "ships",
        forge_dir / "inventorycontainers" / "cargogrid",
    ]
    inv_dirs = [d for d in inv_dirs if d.exists()]
    if not inv_dirs:
        print(f"  WARNING: no inventory container dirs found")
        return
    # Build cache: container class name -> SCU, and GUID -> SCU for entity resolution
    scu_cache = {}
    guid_scu = {}  # sorted GUID chars -> SCU (SC uses different byte orders for same GUID)
    def guid_key(g):
        """Normalize GUID by sorting hex chars — SC uses mixed-endian byte orders."""
        return "".join(sorted(g.replace("-", "").lower()))
    for inv_dir in inv_dirs:
      for xml_file in inv_dir.glob("*.xml.xml"):
        stem = xml_file.stem.replace(".xml", "")
        try:
            root = ET.parse(xml_file).getroot()
            dim = root.find(".//interiorDimensions")
            if dim is None:
                continue
            x = safe_float(dim.get("x", 0))
            y = safe_float(dim.get("y", 0))
            z = safe_float(dim.get("z", 0))
            scu = int(x / 1.25) * int(y / 1.25) * int(z / 1.25)
            if 0 < scu < 10000:  # skip unreasonably large placeholder containers
                key = re.sub(r'_template$', '', stem.lower())
                # Normalize cargogridic → cargogrid (RAFT uses 'ic' suffix variant)
                key = key.replace('cargogridic', 'cargogrid')
                scu_cache[key] = scu
                # Also index by GUID for entity->container resolution
                ref = root.get("__ref")
                if ref:
                    guid_scu[guid_key(ref)] = scu
        except Exception:
            pass

    # Scan cargo grid entity files — these reference inventory containers by GUID
    # (e.g. Carrack's anvl_carrack_cargogrid -> containerParams GUID -> anvl_carrack_cargogrid_large)
    cg_entity_dir = forge_dir / "entities" / "scitem" / "ships" / "cargogrid"
    if cg_entity_dir.exists():
        for xml_file in cg_entity_dir.rglob("*.xml.xml"):
            stem = xml_file.stem.replace(".xml", "")
            # Strip entityclassdefinition. prefix (some files use this naming)
            if stem.lower().startswith("entityclassdefinition."):
                stem = stem[len("entityclassdefinition."):]
            ek = stem.lower()
            if ek in scu_cache:
                continue  # already have direct match
            try:
                root = ET.parse(xml_file).getroot()
                container = root.find(".//SCItemInventoryContainerComponentParams")
                if container is None:
                    continue
                cp = container.get("containerParams", "")
                if not cp or cp == "null":
                    continue
                gk = guid_key(cp)
                if gk in guid_scu:
                    scu_cache[ek] = guid_scu[gk]
            except Exception:
                pass

    # Build mining pod cache: pod class name -> SCU (from SStandardCargoUnit in forge XML)
    pod_scu_refs = {}  # class_name -> hex index
    pod_dir = forge_dir / "entities" / "scitem" / "ships" / "utility" / "mining" / "miningpods"
    if pod_dir.exists():
        for xml_file in pod_dir.glob("cargo_shipmining_pod_*.xml.xml"):
            stem = xml_file.stem.replace(".xml", "")
            if "collapsed" in stem or "template" in stem:
                continue
            try:
                root = ET.parse(xml_file).getroot()
                txt = ET.tostring(root, encoding='unicode')
                m = re.search(r'SStandardCargoUnit\[([0-9A-Fa-f]+)\]', txt)
                if m:
                    pod_scu_refs[stem.lower()] = m.group(1)
            except Exception:
                pass

    # Read SStandardCargoUnit values from DCB
    pod_scu_cache = {}
    if dcb_path and dcb_path.exists() and pod_scu_refs:
        with open(dcb_path, "rb") as f:
            dcb_d = f.read()
        h = _dcb_parse_header(dcb_d)
        scu_si = h["struct_by_name"].get("SStandardCargoUnit")
        if scu_si and scu_si in h["struct_data"]:
            scu_off, scu_cnt = h["struct_data"][scu_si]
            for cls_name, hex_idx in pod_scu_refs.items():
                idx = int(hex_idx, 16)
                if idx < scu_cnt:
                    val = struct.unpack_from("<f", dcb_d, scu_off + idx * 4)[0]
                    if val > 0:
                        pod_scu_cache[cls_name] = round(val)

    enriched = 0
    for ship in ships.values():
        lo = ship.get("defaultLoadout") or {}
        total_scu = 0
        ore_scu = 0
        # Mining pod ore capacity
        for key, cls in lo.items():
            cls_lower = cls.lower()
            if cls_lower in pod_scu_cache and "stored" not in key.lower():
                ore_scu += pod_scu_cache[cls_lower]
        # Cargo grid capacity
        for key, cls in lo.items():
            if "cargogrid" not in key.lower() and "cargo_grid" not in key.lower() and "cargogrid" not in cls.lower():
                continue
            # Match the loadout class to an inventory container
            cls_lower = cls.lower()
            scu = scu_cache.get(cls_lower, 0)
            if scu == 0:
                # Fuzzy match handles:
                #   Word reordering: "rear_max" vs "max_rear"
                #   Prefix variation: "orig_600" vs "orig_600i"
                cls_words = sorted(cls_lower.replace("cargogrid", "").split("_"))
                cls_set = set(cls_words) - {""}
                best_score = 0
                for cache_key, cache_scu in scu_cache.items():
                    cache_set = set(cache_key.replace("cargogrid", "").split("_")) - {""}
                    # Exact word set match (handles reordering)
                    if cls_set == cache_set:
                        scu = cache_scu
                        break
                    # Fuzzy: check if all non-matching words are substrings of each other
                    diff = cls_set ^ cache_set
                    if len(diff) <= 2 and len(cls_set & cache_set) >= max(len(cls_set), len(cache_set)) - 1:
                        diff_list = list(diff)
                        if len(diff_list) == 2 and (diff_list[0] in diff_list[1] or diff_list[1] in diff_list[0]):
                            scu = cache_scu
                            break
            total_scu += scu
        ship["cargoCapacity"] = total_scu
        ship["oreCapacity"] = ore_scu
        if total_scu > 0 or ore_scu > 0:
            enriched += 1

    # Manual overrides for ships whose cargo grids are attached to elevators/bays
    # and not directly in the default loadout (e.g. Constellation series)
    cargo_overrides = {
        "rsi_constellation_andromeda": 96,
        "rsi_constellation_aquila": 96,
        "rsi_constellation_phoenix": 80,
        "rsi_constellation_taurus": 174,  # 168 main + 6 tail
        "cnou_nomad": 24,
        "gama_syulen": 3,  # 3 cargo arms × 1 SCU each
        "cnou_mustang_alpha": 4,
        "rsi_aurora_gs_cl": 6,
        "rsi_aurora_gs_es": 3,
        "rsi_aurora_gs_mr": 3,
        "rsi_aurora_gs_ln": 3,
        "rsi_aurora_gs_lx": 3,
        "misc_fortune": 16,  # two distinct cargo grids
        "aegs_hammerhead": 40,
    }
    # Build case-insensitive lookup for overrides
    ships_lower = {k.lower(): k for k in ships}
    for cls_name, scu in cargo_overrides.items():
        actual_key = ships_lower.get(cls_name.lower())
        if actual_key:
            old = ships[actual_key].get("cargoCapacity", 0)
            if old != scu:
                ships[actual_key]["cargoCapacity"] = scu
                if old == 0:
                    enriched += 1
    print(f"  Cargo capacity computed: {enriched} ships with cargo/ore")


def enrich_countermeasures(ships, forge_dir):
    """Extract countermeasure counts (decoy/noise) per ship from CM launcher XMLs."""
    cm_dir = forge_dir / "entities" / "scitem" / "ships" / "countermeasures"
    if not cm_dir.exists():
        print(f"  WARNING: countermeasures dir not found")
        return
    # Cache: CM class name -> (type, count)
    cm_cache = {}
    for xml_file in cm_dir.glob("*.xml.xml"):
        stem = xml_file.stem.replace(".xml", "")
        try:
            root = ET.parse(xml_file).getroot()
            ammo = root.find(".//SAmmoContainerComponentParams")
            if ammo is None:
                continue
            count = safe_int(ammo.get("maxAmmoCount", 0))
            if count <= 0:
                continue
            # Determine type from filename or ammo record
            stem_lower = stem.lower()
            if "flare" in stem_lower or "decoy" in stem_lower:
                cm_type = "decoy"
            elif "chaff" in stem_lower or "noise" in stem_lower:
                cm_type = "noise"
            else:
                continue
            cm_cache[stem_lower] = (cm_type, count)
        except Exception:
            pass

    enriched = 0
    for ship in ships.values():
        lo = ship.get("defaultLoadout") or {}
        decoys = 0
        noise = 0
        for key, cls in lo.items():
            if "countermeasure" not in key.lower() and "cm_launcher" not in key.lower() and "cml" not in key.lower():
                continue
            info = cm_cache.get(cls.lower())
            if info:
                if info[0] == "decoy":
                    decoys += info[1]
                else:
                    noise += info[1]
        ship["cmDecoys"] = decoys
        ship["cmNoise"] = noise
        if decoys > 0 or noise > 0:
            enriched += 1
    print(f"  Countermeasures enriched: {enriched} ships")


def enrich_fuel_capacity(ships, forge_dir, dcb_path=None):
    """Extract hydrogen and quantum fuel tank capacities per ship."""
    tank_dir = forge_dir / "entities" / "scitem" / "ships" / "fueltanks"
    if not tank_dir.exists():
        print(f"  WARNING: fueltanks dir not found")
        return

    # Scan tank entity files for SStandardCargoUnit references
    # htnk_* = hydrogen, qtnk_* = quantum
    tank_refs = {}  # class_name -> (type, hex_index)
    for xml_file in tank_dir.glob("*.xml.xml"):
        stem = xml_file.stem.replace(".xml", "").lower()
        if not stem.startswith("htnk_") and not stem.startswith("qtnk_"):
            continue
        tank_type = "hydrogen" if stem.startswith("htnk_") else "quantum"
        try:
            root = ET.parse(xml_file).getroot()
            txt = ET.tostring(root, encoding='unicode')
            m = re.search(r'capacity="SStandardCargoUnit\[([0-9A-Fa-f]+)\]"', txt)
            if m:
                tank_refs[stem] = (tank_type, m.group(1))
        except Exception:
            pass

    if not tank_refs:
        print(f"  WARNING: no fuel tank refs found")
        return

    # Read SStandardCargoUnit values from DCB
    tank_capacities = {}  # class_name -> capacity_mscu
    if dcb_path and dcb_path.exists():
        with open(dcb_path, "rb") as f:
            dcb_d = f.read()
        h = _dcb_parse_header(dcb_d)
        scu_si = h["struct_by_name"].get("SStandardCargoUnit")
        if scu_si and scu_si in h["struct_data"]:
            scu_off, scu_cnt = h["struct_data"][scu_si]
            for cls_name, (tank_type, hex_idx) in tank_refs.items():
                idx = int(hex_idx, 16)
                if idx < scu_cnt:
                    val = struct.unpack_from("<f", dcb_d, scu_off + idx * 4)[0]
                    if val > 0:
                        tank_capacities[cls_name] = (tank_type, round(val, 1))

    # Match tanks to ships via default loadout
    enriched = 0
    for ship in ships.values():
        lo = ship.get("defaultLoadout") or {}
        h2_total = 0.0
        qt_total = 0.0
        for key, cls in lo.items():
            cls_lower = cls.lower()
            if cls_lower in tank_capacities:
                tank_type, cap = tank_capacities[cls_lower]
                if tank_type == "hydrogen":
                    h2_total += cap
                else:
                    qt_total += cap
        if h2_total > 0:
            ship["hydrogenFuelCapacity"] = round(h2_total, 1)
        if qt_total > 0:
            ship["quantumFuelCapacity"] = round(qt_total, 1)
        if h2_total > 0 or qt_total > 0:
            enriched += 1
    print(f"  Fuel capacity enriched: {enriched} ships")


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
    ammo_xml_dir = FORGE_DIR / "ammoparams/vehicle"
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

    # ── Enrich missile damage via DamageInfo index ────────────────────────────
    misl_enriched = 0
    if di_si and di_si in sd:
        di_off, di_cnt = sd[di_si]
        for item in items.values():
            if item.get("type") != "Missile": continue
            idx = item.get("_damageInfoIdx", -1)
            if idx < 0 or idx >= di_cnt: continue
            base = di_off + idx * 24
            v = struct.unpack_from("<6f", d, base)
            dmg = {"physical": round(v[0], 4), "energy": round(v[1], 4),
                   "distortion": round(v[2], 4), "thermal": round(v[3], 4),
                   "biochemical": round(v[4], 4), "stun": round(v[5], 4)}
            item["damage"] = dmg
            item["alphaDamage"] = round(sum(dmg.values()), 4)
            misl_enriched += 1
    print(f"  Missiles enriched with damage: {misl_enriched}")

    # ── Extract fire rates from forge weapon XMLs ──────────────────────────────
    # Two patterns:
    #   Looping (laser/energy): <SWeaponSequenceEntryParams delay="350" unit="RPM" .../>
    #   Rapid/Gatling:          <SWeaponActionFireRapidParams fireRate="1200" .../>
    #   Single (cannon):        <SWeaponActionFireSingleParams fireRate="100" .../>
    weapons_dir = FORGE_DIR / "entities/scitem/ships/weapons"
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

    # ── Enrich energy weapons with regen params from SWeaponRegenConsumerParams ──
    # Layout (28 bytes = 7 × f32):
    #   [0] initialRegenPerSec, [4] requestedRegenPerSec, [8] regenerationCooldown,
    #   [12] costPerBullet, [16] requestedAmmoLoad, [20] maxAmmoLoad, [24] maxRegenPerSec
    regen_enriched = 0
    if regen_si and regen_si in sd:
        r_off, r_cnt = sd[regen_si]
        r_rs = sdefs[regen_si][4]  # 28 bytes = 7 × f32
        regen_pattern = re.compile(
            r'weaponRegenConsumerParams="SWeaponRegenConsumerParams\[([0-9A-Fa-f]+)\]"')
        for xml_file in (FORGE_DIR / "entities/scitem/ships/weapons").glob("*.xml.xml"):
            class_name = xml_file.stem.removesuffix(".xml")
            item = items.get(class_name)
            if not item or item.get("isBallistic"): continue
            if item.get("type") not in ("WeaponGun", "WeaponTachyon"): continue
            try:
                m = regen_pattern.search(xml_file.read_text(errors='replace'))
                if not m: continue
                inst_idx = int(m.group(1), 16)
                if inst_idx >= r_cnt: continue
                base = r_off + inst_idx * r_rs
                cooldown       = f32at(base + 8)   # f32[2]
                cost_per_bullet = f32at(base + 12)  # f32[3]
                req_ammo_load  = f32at(base + 16)  # f32[4]
                max_ammo_load  = f32at(base + 20)  # f32[5]
                if max_ammo_load > 0:
                    item["ammoCount"]       = round(max_ammo_load)
                    item["regenCooldown"]   = round(cooldown, 4)
                    item["costPerBullet"]   = round(cost_per_bullet, 2)
                    item["requestedAmmoLoad"] = round(req_ammo_load, 2)
                    item["maxAmmoLoad"]     = round(max_ammo_load)
                    regen_enriched += 1
            except Exception:
                pass
    print(f"  Energy weapons enriched with regen params: {regen_enriched}")

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

        # Also enrich weapons with power draw from SStandardResourceUnit
        wpn_pwr_enriched = 0
        for item in items.values():
            if item.get("type") not in ("WeaponGun", "WeaponTachyon"): continue
            ref = item.pop("sruRef", "")
            if not ref: continue
            idx = int(ref, 16)
            val = get_sru(idx)
            if val > 0:
                item["powerDraw"] = round(val, 4)
                wpn_pwr_enriched += 1
        print(f"  Weapons enriched with DCB power draw: {wpn_pwr_enriched}")

    # ── Enrich mining lasers with max power from DamageInfo ──
    di_si_mining = h["struct_by_name"].get("DamageInfo")
    if di_si_mining and di_si_mining in sd:
        di_off_m, di_cnt_m = sd[di_si_mining]
        mining_pwr_enriched = 0
        for item in items.values():
            if item.get("type") != "WeaponMining": continue
            ref = item.pop("_miningDpsRef", None)
            if not ref: continue
            idx = int(ref, 16)
            if idx >= di_cnt_m: continue
            # Sum all damage types for total DPS = max power
            total = sum(struct.unpack_from("<f", d, di_off_m + idx * 24 + i * 4)[0] for i in range(6))
            if total > 0:
                item["miningMaxPower"] = round(total, 1)
                tmin = item.get("throttleMin", 0)
                if tmin > 0:
                    item["miningMinPower"] = round(total * tmin, 1)
                mining_pwr_enriched += 1
        print(f"  Mining lasers enriched with power: {mining_pwr_enriched}")

    # ── Enrich mining lasers with modifier values from FloatModifierMultiplicative ──
    fmm_si = h["struct_by_name"].get("FloatModifierMultiplicative")
    if fmm_si and fmm_si in sd:
        fmm_off, fmm_cnt = sd[fmm_si]
        fmm_rs = sdefs[fmm_si][4]  # 5 bytes: u8 + f32
        def get_fmm(idx):
            if idx >= fmm_cnt: return 0.0
            return struct.unpack_from("<f", d, fmm_off + idx * fmm_rs + 1)[0]

        mining_enriched = 0
        for item in items.values():
            if item.get("type") != "WeaponMining": continue
            refs = item.pop("miningModRefs", None)
            if not refs: continue
            for key, hex_idx in refs.items():
                idx = int(hex_idx, 16)
                val = get_fmm(idx)
                if key == "laserInstability":
                    item["miningInstability"] = round(val, 1)
                elif key == "optimalChargeWindowSizeModifier":
                    item["miningOptimalWindow"] = round(val, 1)
                elif key == "resistanceModifier":
                    item["miningResistance"] = round(val, 1)
            mining_enriched += 1
        print(f"  Mining lasers enriched with modifiers: {mining_enriched}")

        # Also enrich mining modules with the same struct
        mod_enriched = 0
        for item in items.values():
            if item.get("type") != "MiningModifier": continue
            refs = item.pop("_miningModRefs", None)
            if not refs: continue
            for key, hex_idx in refs.items():
                idx = int(hex_idx, 16)
                val = get_fmm(idx)
                if key == "laserInstability":
                    item["miningInstability"] = round(val, 1)
                elif key == "optimalChargeWindowSizeModifier":
                    item["miningOptimalWindow"] = round(val, 1)
                elif key == "optimalChargeWindowRateModifier":
                    item["miningOptimalRate"] = round(val, 1)
                elif key == "resistanceModifier":
                    item["miningResistance"] = round(val, 1)
                elif key == "shatterdamageModifier":
                    item["miningShatterDamage"] = round(val, 1)
                elif key == "filterModifier":
                    item["miningInertMaterials"] = round(val, 1)
                elif key == "catastrophicChargeWindowRateModifier":
                    item["miningOvercharge"] = round(val, 1)
            mod_enriched += 1
        print(f"  Mining modules enriched with modifiers: {mod_enriched}")

    # ── Enrich weapons with heat/overheat params from SWeaponSimplifiedHeatParams ──
    shp_si = h["struct_by_name"].get("SWeaponSimplifiedHeatParams")
    if shp_si and shp_si in sd:
        shp_off, shp_cnt = sd[shp_si]
        shp_rs = sdefs[shp_si][4]  # 101 bytes
        heat_enriched = 0
        for item in items.values():
            if item.get("type") not in ("WeaponGun", "WeaponTachyon"): continue
            ref = item.pop("heatRef", "")
            if not ref: continue
            idx = int(ref, 16)
            if idx >= shp_cnt: continue
            base = shp_off + idx * shp_rs
            max_heat      = f32at(base + 4)   # [1] = max heat capacity
            cooling_rate   = f32at(base + 8)   # [2] = cooling per second
            cooling_delay  = f32at(base + 16)  # [4] = cooling delay
            overheat_time  = f32at(base + 20)  # [5] = overheat cooldown
            if max_heat > 0:
                item["maxHeat"]         = round(max_heat, 2)
                item["coolingRate"]     = round(cooling_rate, 2)
                item["coolingDelay"]    = round(cooling_delay, 4)
                item["overheatCooldown"] = round(overheat_time, 2)
                heat_enriched += 1
        print(f"  Weapons enriched with heat params: {heat_enriched}")

    if sru_si and sru_si in sd:
        # Also enrich QDs with power draw from SStandardResourceUnit (= pip count)
        qd_pwr_enriched = 0
        for item in items.values():
            if item.get("type") != "QuantumDrive": continue
            ref = item.pop("sruRef", "")
            if not ref: continue
            idx = int(ref, 16)
            val = get_sru(idx)
            if val > 0:
                item["powerDraw"] = round(val)  # integer pip count for QDs
                qd_pwr_enriched += 1
        print(f"  QDs enriched with power draw: {qd_pwr_enriched}")

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

        # Also enrich shields with power consumption (bars needed to turn on)
        # Enrich shields, coolers, and life support with PSRU power draw
        psru_enriched = {"Shield": 0, "Cooler": 0, "LifeSupportGenerator": 0, "Radar": 0}
        for item in items.values():
            if item.get("type") not in psru_enriched: continue
            ref = item.pop("psruRef", "")
            if not ref: continue
            idx = int(ref, 16)
            val = get_psru(idx)
            if val > 0:
                item["powerDraw"] = val  # integer: power segments consumed
                psru_enriched[item["type"]] += 1
        for t, n in psru_enriched.items():
            print(f"  {t} enriched with power draw: {n}")

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
            if v[0] > 1e6 and item.get("speed", 0) == 0:
                item["speed"]   = round(v[0] / 1000.0, 0)  # m/s -> km/s
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
            if v[0] > 1e6 and item.get("speed", 0) == 0:  # fallback if XML didn't get it
                item["speed"]   = round(v[0] / 1000.0, 0)  # m/s -> km/s
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

    # 2b. Expand ship variants — some vehicle XMLs are shared across variants
    # (e.g., RSI_Constellation → Andromeda, Phoenix, Taurus, Aquila)
    print("\n[2b] Expanding ship variants…")
    ships = expand_ship_variants(ships, FORGE_DIR, loc)

    # 3. Enrich from DCB forge
    print("\n[3/6] Enriching ships from DCB forge data…")
    enrich_ships_from_dcb(ships, FORGE_DIR, loc)
    if DCB_FILE.exists():
        extract_default_loadouts(ships, FORGE_DIR, DCB_FILE)
    enrich_armor_from_forge(ships, FORGE_DIR, DCB_FILE)
    enrich_engineering_buffs(ships, FORGE_DIR)
    enrich_salvage_buffs(ships, FORGE_DIR)
    enrich_cargo_capacity(ships, FORGE_DIR, DCB_FILE)
    enrich_countermeasures(ships, FORGE_DIR)
    enrich_fuel_capacity(ships, FORGE_DIR, DCB_FILE)
    for ship in ships.values():
        ship["size"] = classify_size(ship)

    # 3b. Flight stats from flight controller forge XMLs
    print("\n[3b] Extracting flight stats from controller XMLs…")
    flight_enriched = 0
    flight_missing = 0
    for class_name, ship in ships.items():
        stats = extract_flight_stats(class_name, FORGE_DIR)
        if stats:
            ship.update(stats)
            flight_enriched += 1
        else:
            flight_missing += 1
    print(f"  Flight stats extracted: {flight_enriched} ships  ({flight_missing} no FC found)")

    # 3c. User-tested acceleration data (community-sourced, not from game files)
    # Initialize all ships to 0, override with verified in-game data
    accel_overrides = {
        "aegs_gladius": {
            "accelFwd": 12.6, "accelRetro": 2.7, "accelStrafe": 6.0, "accelUp": 9.2, "accelDown": 3.0,
            "accelAbFwd": 19.6, "accelAbRetro": 3.3, "accelAbStrafe": 11.9, "accelAbUp": 11.8, "accelAbDown": 3.9,
            "accelTestedDate": "2026-03-24",
        },
        "anvl_hornet_f7cm_mk2": {
            "accelFwd": 9.7, "accelRetro": 3.1, "accelStrafe": 6.4, "accelUp": 6.8, "accelDown": 3.9,
            "accelAbFwd": 15.0, "accelAbRetro": 4.4, "accelAbStrafe": 8.6, "accelAbUp": 9.2, "accelAbDown": 5.3,
            "accelTestedDate": "2026-03-24",
        },
    }
    accel_lower = {k.lower(): v for k, v in accel_overrides.items()}
    for ship in ships.values():
        override = accel_lower.get(ship["className"].lower())
        if override:
            ship.update(override)
        else:
            ship["accelFwd"] = 0
            ship["accelRetro"] = 0
            ship["accelStrafe"] = 0
            ship["accelUp"] = 0
            ship["accelDown"] = 0
            ship["accelAbFwd"] = 0
            ship["accelAbRetro"] = 0
            ship["accelAbStrafe"] = 0
            ship["accelAbUp"] = 0
            ship["accelAbDown"] = 0
            ship["accelTestedDate"] = ""

    # 4. Components
    print("\n[4/6] Scanning components…")
    items = scan_components(FORGE_DIR, loc)
    print(f"  Total: {len(items)} components")

    # 5. Ammo params (forge XML: speed, range)
    print("\n[5/7] Parsing ammo params (forge XML)…")
    ammo_data = parse_ammo_params(FORGE_DIR)
    enrich_weapons(items, ammo_data)

    # 6. DCB binary: damage, fire rate, shields, QD
    print("\n[6/7] Enriching from DCB binary…")
    if DCB_FILE.exists():
        enrich_from_dcb(items, DCB_FILE, loc)
    else:
        print(f"  WARNING: DCB not found at {DCB_FILE} — skipping damage/fireRate/DPS")
    compute_weapon_dps(items)

    # 7. Write output
    print("\n[7/7] Writing output…")
    # Strip internal-only temp fields before serializing
    for item in items.values():
        item.pop("_damageInfoIdx", None)
        item.pop("_miningModRefs", None)
        item.pop("_miningDpsRef", None)
    ship_list = list(ships.values())
    item_list = list(items.values())

    def count_type(t):
        return sum(1 for i in item_list if i.get("type") == t)

    dps_count = sum(1 for i in item_list if i.get("dps", 0) > 0)

    output = {
        "meta": {
            "game":          "Star Citizen PTU",
            "version":       GAME_VERSION,
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

    # 8. Missions & Contracts (separate extraction)
    print("\n[8/9] Extracting missions & contracts…")
    import subprocess
    mission_script = Path(__file__).parent / "versedb_missions.py"
    if mission_script.exists():
        result = subprocess.run([sys.executable, str(mission_script)], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if any(kw in line for kw in ['Done', 'Total', 'Parsed', 'Filtered', 'Copied']):
                print(f"  {line.strip()}")
        if result.returncode != 0:
            print(f"  WARNING: Mission extraction failed")
            if result.stderr:
                print(f"  {result.stderr[:200]}")
    else:
        print(f"  WARNING: {mission_script} not found — skipping mission extraction")

    # 9. Crafting Recipes (DCB inline struct extraction)
    print("\n[9/9] Extracting crafting recipes…")
    crafting_script = Path(__file__).parent / "crafting_extract.py"
    if crafting_script.exists():
        result = subprocess.run([sys.executable, str(crafting_script)], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if any(kw in line for kw in ['Extracted', 'Unique', 'Saved', 'Copied']):
                print(f"  {line.strip()}")
        if result.returncode != 0:
            print(f"  WARNING: Crafting extraction failed")
            if result.stderr:
                print(f"  {result.stderr[:200]}")
    else:
        print(f"  WARNING: {crafting_script} not found — skipping crafting extraction")

if __name__ == "__main__":
    main()

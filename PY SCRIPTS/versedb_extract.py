"""
versedb_extract.py
==================
Extracts ship, weapon, shield, power plant, cooler, and quantum drive data
from Star Citizen's game files (Data.p4k) and outputs versedb_data.json.
Also runs versedb_missions.py (missions/contracts) and crafting_extract.py (crafting recipes).

PREREQUISITES:
  - unp4k must be on PATH
  - SC Raw Data folder must contain LIVE/ and/or PTU/ with Data.p4k

Usage:
  python versedb_extract.py                  # Extract both LIVE and PTU (default)
  python versedb_extract.py --mode live      # Extract LIVE only
  python versedb_extract.py --mode ptu       # Extract PTU only
  python versedb_extract.py --reextract      # Force re-extraction from p4k (clears intermediate dirs)

The pipeline automatically:
  1. Extracts vehicle XMLs, localization, and Game2.dcb from the p4k (if not already extracted)
  2. Forges the DCB into XML records via unp4k
  3. Parses ships, weapons, shields, power plants, coolers, quantum drives
  4. Enriches from DCB binary (damage, fire rate, power draw, etc.)
  5. Extracts missions & contracts (versedb_missions.py)
  6. Extracts crafting recipes (crafting_extract.py)
  7. Copies all output to app/public/<live|ptu>/

Intermediate files are stored in per-mode folders (sc_data_live/, sc_data_ptu/, etc.)
so LIVE and PTU data never interfere with each other.
"""

import copy
import json
import os
import re
import shutil
import struct
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

# ── Configuration ─────────────────────────────────────────────────────────────

_SC        = Path("/home/bryan/projects/versedb/SC FILES")
_RAW_DATA  = Path("/home/bryan/projects/SC Raw Data")
OUTPUT_FILE = Path(__file__).parent / "versedb_data.json"

# ── Mode-aware paths (set by _configure_mode) ────────────────────────────────
DATA_MODE: str = "live"
VEHICLE_XML_DIR: Path = Path()
FORGE_DIR: Path = Path()
DCB_FILE: Path = Path()
GLOBAL_INI: Path = Path()
BUILD_MANIFEST: Path = Path()
GAME_VERSION: str = "unknown"
APP_DATA_DIR: Path = Path()

def _configure_mode(mode: str) -> None:
    """Set all path globals based on the selected mode ('live' or 'ptu')."""
    global DATA_MODE, VEHICLE_XML_DIR, FORGE_DIR, DCB_FILE, GLOBAL_INI
    global BUILD_MANIFEST, GAME_VERSION, APP_DATA_DIR

    DATA_MODE = mode
    mode_upper = mode.upper()  # LIVE or PTU — matches folder names in SC Raw Data

    # Per-mode intermediate folders so LIVE and PTU never clobber each other
    VEHICLE_XML_DIR = _SC / f"sc_data_xml_{mode}/Data/Scripts/Entities/Vehicles/Implementations/Xml"
    FORGE_DIR       = _SC / f"sc_data_forge_{mode}/libs/foundry/records"
    DCB_FILE        = _SC / f"sc_data_{mode}/Data/Game2.dcb"
    GLOBAL_INI      = _SC / f"sc_data_xml_{mode}/Data/Localization/english/global.ini"
    BUILD_MANIFEST  = _RAW_DATA / mode_upper / "build_manifest.id"
    APP_DATA_DIR    = Path(__file__).parent / "../app/public" / mode

    GAME_VERSION = _read_game_version()

def _read_game_version() -> str:
    """Read build_manifest.id and format as '<major>.<minor>.<patch>-<tag>.<p4change>'."""
    try:
        data = json.loads(BUILD_MANIFEST.read_text())["Data"]
        branch = data.get("Branch", "")
        tag    = data.get("Tag", "ptu")
        p4     = data.get("RequestedP4ChangeNum", "")
        m = re.search(r"(\d+\.\d+\.\d+)", branch)
        ver = m.group(1) if m else data.get("Version", "unknown")
        tag_label = DATA_MODE  # "live" or "ptu" — matches launcher display
        return f"{ver}-{tag_label}.{p4}" if p4 else ver
    except Exception:
        return "unknown"

def _run_p4k_extraction() -> None:
    """Run unp4k to extract vehicle XMLs, localization, DCB, and forge records."""
    import subprocess as sp

    p4k = _RAW_DATA / DATA_MODE.upper() / "Data.p4k"
    if not p4k.exists():
        print(f"  ERROR: {p4k} not found — skipping p4k extraction")
        return

    xml_dir = _SC / f"sc_data_xml_{DATA_MODE}"
    dcb_dir = _SC / f"sc_data_{DATA_MODE}"
    forge_dir = _SC / f"sc_data_forge_{DATA_MODE}"

    steps = [
        ("Extracting vehicle XMLs",
         ["unp4k", "extract", str(p4k), "*Implementations*Xml*.xml", "--convert-xml", "-o", str(xml_dir)]),
        ("Extracting localization",
         ["unp4k", "extract", str(p4k), "*english*global.ini", "-o", str(xml_dir)]),
        ("Extracting Game2.dcb",
         ["unp4k", "extract", str(p4k), "*Game2.dcb", "-o", str(dcb_dir)]),
    ]

    for label, cmd in steps:
        print(f"  {label}…")
        result = sp.run(cmd, capture_output=True, text=True)
        # Print the "Extracted: N files" line
        for line in result.stdout.splitlines():
            if "Extracted" in line:
                print(f"    {line.strip()}")
        if result.returncode != 0:
            print(f"    ERROR: {result.stderr[:200]}")
            return

    # Fix backslash paths (unp4k on Linux uses literal backslashes)
    print("  Fixing backslash paths…")
    for d in (xml_dir, dcb_dir):
        for entry in list(d.iterdir()):
            if "\\" in entry.name:
                dest = d / entry.name.replace("\\", "/")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(entry), str(dest))

    # Forge DCB into XML records
    dcb_path = dcb_dir / "Data/Game2.dcb"
    if dcb_path.exists():
        print("  Forging DCB into XML records…")
        result = sp.run(["unp4k", "dcb", str(dcb_path), "-o", str(forge_dir)],
                        capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if "Exported" in line or "records" in line.lower():
                print(f"    {line.strip()}")
        if result.returncode != 0:
            print(f"    ERROR: {result.stderr[:200]}")
    else:
        print(f"  ERROR: {dcb_path} not found after extraction")

    # Write build version marker so we can detect stale extractions
    marker = dcb_dir / ".build_version"
    marker.write_text(GAME_VERSION)
    print(f"  Build marker written: {GAME_VERSION}")

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

# ── Ship scattergun pellet counts ─────────────────────────────────────────────
# Ship-side scatterguns fire multiple pellets per trigger pull, but the DCB
# damage record only stores per-pellet damage. Multiply by the pellet count
# during extraction so alphaDamage / damage / dps reflect the per-shot total
# the player actually sees in-game.
#
# All known scatterguns fire 8 pellets. Override individual entries here if
# any future variant differs. Discovered by comparing local extraction
# (per-pellet) against the curated DB values (per-shot total) for every
# scattergun in the items table — exact 8x ratio across the board.
SHIP_PELLET_COUNTS = {
    "amrs_scattergun_s3":               8,
    "apar_ballisticscattergun_s1":      8,
    "apar_ballisticscattergun_s1_shark":8,
    "apar_ballisticscattergun_s2":      8,
    "apar_ballisticscattergun_s2_shark":8,
    "apar_ballisticscattergun_s3":      8,
    "apar_ballisticscattergun_s3_shark":8,
    "apar_ballisticscattergun_s6":      8,
    "hrst_laserscattergun_s1":          8,
    "hrst_laserscattergun_s2":          8,
    "hrst_laserscattergun_s3":          8,
    "prar_distortionscattergun_s4":     8,
    "prar_distortionscattergun_s5":     8,
    "prar_distortionscattergun_s6":     8,
}

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
    # Also try underscore-stripped match (e.g., alpha_wolf → alphawolf)
    fc_file = ctrl_dir / f"controller_flight_{ship_lower}.xml.xml"
    if not fc_file.exists():
        candidates = sorted(ctrl_dir.glob(f"controller_flight_{ship_lower}*.xml.xml"))
        if not candidates:
            # Fuzzy: strip underscores from ship name and match against all controller files
            ship_no_uscore = ship_lower.replace('_', '')
            candidates = [f for f in sorted(ctrl_dir.glob("controller_flight_*.xml.xml"))
                          if f.stem.replace(".xml", "").replace("controller_flight_", "").replace('_', '').startswith(ship_no_uscore)]
        # If no candidates, try progressively shorter prefixes (strip variant suffixes)
        if not candidates:
            parts = ship_lower.split('_')
            for end in range(len(parts) - 1, 1, -1):
                prefix = '_'.join(parts[:end])
                candidates = sorted(ctrl_dir.glob(f"controller_flight_{prefix}.xml.xml"))
                if candidates:
                    break
                candidates = sorted(ctrl_dir.glob(f"controller_flight_{prefix}*.xml.xml"))
                if candidates:
                    break
        base = [f for f in candidates
                if not any(x in f.stem for x in ("blade", "_mm_", "rework", "_pu_"))]
        fc_file = base[0] if base else (candidates[0] if candidates else None)
        if not fc_file:
            return {}

    try:
        root = ET.parse(fc_file).getroot()
    except Exception:
        return {}
    return _parse_flight_stats_from_root(root)


def _parse_flight_stats_from_root(root):
    """Extract IFCS flight stats from a parsed flight controller XML root."""
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
    "WeaponGun", "WeaponTachyon", "WeaponMining", "TractorBeam", "MissileLauncher",
    "BombLauncher", "Bomb", "Turret", "TurretBase", "Shield", "PowerPlant", "Cooler", "LifeSupportGenerator",
    "QuantumDrive", "Radar", "Sensor", "QuantumFuelTank", "MiningModifier", "ToolArm", "UtilityTurret", "SalvageHead", "SalvageModifier",
    "EMP", "QuantumInterdictionGenerator", "Module", "FlightController",
}

def parse_vehicle_xml(xml_path, loc):
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError as e:
        print(f"    XML parse error in {xml_path.name}: {e}")
        return None

    root = tree.getroot()
    class_name = xml_path.stem

    # Detect ground vehicles
    vehicle_subtype = root.get("subType", "")
    is_ground_vehicle = vehicle_subtype == "Vehicle_GroundVehicle"

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

    # Hull HP: build full parts tree with hierarchy
    total_hp = 0.0
    body_hp = 0.0
    vital_parts = {}  # flat compat dict
    hull_parts_tree = []  # full tree: [{name, hp, category, children: [...]}]

    def _classify_part(name, cls, hp, depth, part_el, is_vital):
        nl = name.lower()
        if "thruster" in nl:
            return "thruster"
        if is_vital:
            return "vital"
        # Direct children of vital part are secondary structural parts
        if depth == 1:
            return "secondary"
        # Deeper parts: breakable if they have detach data, sub otherwise
        has_detach = part_el is not None and part_el.get("detachRatio") is not None
        if has_detach:
            return "breakable"
        return "sub"

    def _walk_parts(parent_el, depth=0):
        nodes = []
        for part in parent_el.findall("Part"):
            name = part.get("name", "")
            cls = part.get("class", "")
            dm = part.get("damageMax")

            # Check for thruster ItemPorts — look up HP from default loadout
            is_thruster_port = (cls == "ItemPort" and "thruster" in name.lower()
                               and name.lower().startswith("hardpoint_thruster"))
            thruster_hp = 0
            if is_thruster_port:
                # Match hardpoint name to cached thruster entity by pattern
                # e.g. hardpoint_thruster_main_left → {ship}_thruster_main
                hp_suffix = name.lower().replace("hardpoint_thruster_", "")
                # Strip directional suffixes for matching
                for strip in ("_left", "_right", "_top", "_bottom", "_side",
                              "_front_left_top", "_front_left_side",
                              "_front_right_top", "_front_right_side"):
                    if hp_suffix.endswith(strip.replace("_", "")):
                        hp_suffix = hp_suffix[:len(hp_suffix)-len(strip.replace("_",""))]
                        break
                # Try matching against cache keys
                cn_lower = class_name.lower()
                for thr_name, thr_hp in _thruster_hp_cache.items():
                    # e.g. aegs_gladius_thruster_main matches hardpoint_thruster_main_left
                    thr_suffix = thr_name.replace(cn_lower + "_thruster_", "")
                    if hp_suffix.startswith(thr_suffix) or thr_suffix.startswith(hp_suffix):
                        thruster_hp = thr_hp
                        break
                # Also try exact loadout match
                if thruster_hp == 0:
                    thruster_cls = default_loadout_raw.get(name, "")
                    if thruster_cls and thruster_cls.lower() in _thruster_hp_cache:
                        thruster_hp = _thruster_hp_cache[thruster_cls.lower()]

            hp_val = safe_float(dm) if dm else thruster_hp
            if hp_val <= 0 and not is_thruster_port:
                # No HP — recurse into children but don't create a node
                children_el = part.find("Parts")
                if children_el is not None:
                    nodes.extend(_walk_parts(children_el, depth))
                nodes.extend(_walk_parts(part, depth))
                continue

            if hp_val > 0:
                nonlocal total_hp
                total_hp += hp_val if not is_thruster_port else 0  # thrusters don't count toward hull total

            # Detect vital part: matches body_hp or has id=modPart_body
            pid = part.get("id", "")
            is_vital = (pid == "modPart_body" or
                        (depth == 0 and hp_val > 0 and hp_val == body_hp) or
                        (depth == 0 and name.lower() == "body"))
            category = "thruster" if is_thruster_port else _classify_part(name, cls, hp_val, depth, part, is_vital)

            # Recurse into children
            children = []
            children_el = part.find("Parts")
            if children_el is not None:
                children.extend(_walk_parts(children_el, depth + 1))
            children.extend(_walk_parts(part, depth + 1))

            node = {"name": name, "hp": round(hp_val), "category": category, "children": children}
            nodes.append(node)

            # Flat compat
            vital_parts[name] = hp_val

        return nodes

    # Build thruster HP cache from forge entities for this ship
    _thruster_hp_cache = {}
    _thruster_forge_dir = _SC / f"sc_data_forge_{DATA_MODE}/libs/foundry/records/entities/scitem/ships/thrusters"
    if _thruster_forge_dir.exists():
        cn_lower = class_name.lower()
        for tf in _thruster_forge_dir.glob(f"{cn_lower}_thruster_*.xml.xml"):
            try:
                _content = tf.read_text(errors="replace")
                _m = re.search(r'SHealthComponentParams[^>]*Health="([^"]+)"', _content)
                if _m:
                    _thruster_hp_cache[tf.stem.replace(".xml", "")] = safe_float(_m.group(1))
            except Exception:
                pass

    # Map hardpoint names to thruster entity names via the DCB default loadout
    default_loadout_raw = {}
    for dl_el in root.iter("SEntityComponentDefaultLoadout"):
        for item_el in dl_el.iter("SItemPortLoadoutManualParams"):
            port = item_el.get("itemPortName", "")
            ent = item_el.get("entityClassName", "")
            if port and ent:
                default_loadout_raw[port] = ent

    root_parts = root.find(".//Parts")

    # Pre-scan: find body_hp
    # 1. Look for modPart_body or name="body" anywhere in the tree
    # 2. If not found, use the first/largest damageMax part that has children with damageMax
    if root_parts is not None:
        for part in root.iter("Part"):
            pid = part.get("id", "")
            dm = part.get("damageMax")
            if dm and (pid == "modPart_body" or part.get("name", "").lower() == "body"):
                body_hp = safe_float(dm)
                break
        if body_hp == 0:
            # Fallback: largest damageMax part at the first nesting level
            for part in root.iter("Part"):
                dm = part.get("damageMax")
                if dm:
                    hp_val = safe_float(dm)
                    if hp_val > body_hp:
                        body_hp = hp_val

    if root_parts is not None:
        hull_parts_tree = _walk_parts(root_parts)

    if body_hp == 0 and vital_parts:
        body_hp = max(vital_parts.values())

    manufacturer = mfr_from_classname(class_name)

    # Collect hardpoints
    hardpoints = []
    seen_ids = set()

    skipped_parts = {}  # name → hp_entry for Parts with skipPart=1

    for part in root.iter("Part"):
        part_name = part.get("name", "")
        item_port = part.find("ItemPort")
        if item_port is None:
            continue

        flags = item_port.get("flags", "")

        # Skip invisible+uneditable (internal systems) — except critical component types
        if "uneditable" in flags and "invisible" in flags:
            _allowed_invis = {"FlightController", "BombLauncher", "Shield", "PowerPlant", "Cooler", "Radar", "QuantumDrive", "LifeSupportGenerator"}
            types_el_peek = item_port.find("Types")
            is_allowed = types_el_peek is not None and any(
                t.get("type") in _allowed_invis for t in types_el_peek.findall("Type")
            )
            if not is_allowed:
                continue

        min_size = safe_int(item_port.get("minSize") or item_port.get("minsize", 0))
        max_size = safe_int(item_port.get("maxSize") or item_port.get("maxsize", 0))

        types_el = item_port.find("Types")
        if types_el is None:
            continue

        # Allow S0 for component types (ground vehicles use S0 PP, cooler, shield, radar)
        S0_ALLOWED = {"Shield", "PowerPlant", "Cooler", "Radar", "LifeSupportGenerator"}
        if max_size == 0:
            has_s0_type = types_el is not None and any(
                t.get("type") in S0_ALLOWED for t in types_el.findall("Type")
            )
            if not has_s0_type:
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
        # Reclassify Misc ports as Turret when the hardpoint name indicates a turret
        if primary_type == "Misc" and "turret" in part_name.lower():
            port_types = [{"type": "Turret", "subtypes": ""}]
            primary_type = "Turret"
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

        # Parts with skipPart=1 are disabled by default (can be re-enabled by modifications)
        if part.get("skipPart") == "1":
            skipped_parts[hp_id.lower()] = hp_entry
        else:
            hardpoints.append(hp_entry)

    if not hardpoints:
        return None

    # ── Parse Modifications section ──
    # Build id → {element_tag, parent_hardpoint_name} map.
    # The id attr can be on ItemPort, Type, Connection, ControllerDef, or Part.
    # We need to know which hardpoint each id belongs to and what element type it's on.
    id_to_hp = {}  # modId → {"tag": element_tag, "hpName": hardpoint_name, "typeIdx": index}

    # Walk the entire XML tree and map every element with an id attribute
    # to the hardpoint name it belongs to (the nearest ancestor Part with class=ItemPort).
    def _find_hp_name(elem_with_id):
        """Walk up from an element to find the owning hardpoint Part name."""
        # The id may be on the ItemPort itself, a Type, Connection, or ControllerDef.
        # We need to find the Part[@class='ItemPort'] that contains it.
        # Since ElementTree doesn't support parent traversal, we use the parent_map.
        node = elem_with_id
        while node is not None:
            if node.tag == "Part" and node.get("class") == "ItemPort":
                return node.get("name", "")
            node = parent_map.get(node)
        return ""

    parent_map = {child: parent for parent in root.iter() for child in parent}

    for elem in root.iter():
        eid = elem.get("id", "")
        if not eid:
            continue
        hp_name = _find_hp_name(elem)
        entry = {"tag": elem.tag, "hpName": hp_name}
        # For Type elements, track the index within the Types list
        if elem.tag == "Type":
            parent = parent_map.get(elem)
            if parent is not None and parent.tag == "Types":
                entry["typeIdx"] = list(parent).index(elem)
        id_to_hp[eid] = entry

    modifications = {}
    for mod_el in root.findall(".//Modification"):
        mod_name = mod_el.get("name", "").strip()
        if not mod_name:
            continue
        elems = []
        for elem in mod_el.findall(".//Elem"):
            elems.append({
                "idRef": elem.get("idRef", ""),
                "name":  elem.get("name", ""),
                "value": elem.get("value", ""),
            })
        if elems:
            modifications[mod_name] = elems

    return {
        "className":        class_name,
        "name":             display_name,
        "manufacturer":     manufacturer,
        "mass":             round(mass, 0),
        "size":             "unknown",
        "role":             "",
        "career":           "",
        "crew":             1,
        "isGroundVehicle":  is_ground_vehicle,
        "hardpoints":       hardpoints,
        "flightSpoolDelay": round(flight_spool_delay, 1),
        # Hull HP
        "totalHp":          round(total_hp, 0),
        "bodyHp":           round(body_hp, 0),
        "vitalParts":       {k: round(v, 0) for k, v in vital_parts.items() if k.lower() != "body"},
        "hullPartsTree":    hull_parts_tree,
        # Vehicle XML modifications (keyed by modification name)
        "_modifications":   modifications,
        # modId → {tag, hpName, typeIdx} for applying modifications to hardpoints
        "_idToHp":          id_to_hp,
        # Parts with skipPart=1 that can be re-enabled by modifications
        "_skippedParts":    skipped_parts,
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
    if not info or info["type"] not in ("WeaponGun", "WeaponTachyon", "WeaponMining", "TractorBeam"):
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
    mining_dps_ref = dps_refs[0] if dps_refs else None  # first ref = fracture beam (mining power)

    # Component health
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0

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
        "componentHp":    round(component_hp, 0) if component_hp > 0 else None,
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
    if not info or info["type"] not in ("Missile", "Bomb"):
        return None
    is_bomb = info["type"] == "Bomb"
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
    # Explosion radius from explosionParams
    ep = root.find(".//explosionParams")
    explosion_min_radius = safe_float(ep.get("minRadius", 0)) if ep is not None else 0.0
    explosion_max_radius = safe_float(ep.get("maxRadius", 0)) if ep is not None else 0.0
    display = resolve_item_name(loc, class_name)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Bomb" if is_bomb else "Missile",
        "subType":      "Bomb" if is_bomb else guidance,
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
        "explosionMinRadius": round(explosion_min_radius, 1),
        "explosionMaxRadius": round(explosion_max_radius, 1),
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
    # Health
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0
    # EM signature
    em_el = root.find(".//EMSignature")
    em_max = safe_float(em_el.get("nominalSignature", 0)) if em_el is not None else 0.0
    em_decay = safe_float(em_el.get("decayRate", 0)) if em_el is not None else 0.0
    # Distortion
    dist_el = root.find(".//SDistortionParams")
    dist_max = safe_float(dist_el.get("Maximum", 0)) if dist_el is not None else 0.0
    dist_decay_rate = safe_float(dist_el.get("DecayRate", 0)) if dist_el is not None else 0.0
    dist_decay_delay = safe_float(dist_el.get("DecayDelay", 0)) if dist_el is not None else 0.0
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "LifeSupportGenerator",
        "size":         info["size"],
        "grade":        info["grade"],
        "psruRef":      cooling["psruRef"],
        "minConsumptionFraction": cooling["minConsumptionFraction"],
        "componentHp":          round(component_hp, 0),
        "emMax":                round(em_max, 0),
        "emDecayRate":          round(em_decay, 2),
        "distortionMax":        round(dist_max, 0),
        "distortionDecayRate":  round(dist_decay_rate, 0),
        "distortionDecayDelay": round(dist_decay_delay, 1),
        **parse_power_ranges(root),
    }


def parse_jumpdrive_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "JumpDrive":
        return None
    display = resolve_item_name(loc, class_name)
    hp_el = root.find(".//SHealthComponentParams")
    component_hp = safe_float(hp_el.get("Health", 0)) if hp_el is not None else 0.0
    jd = root.find(".//SCItemJumpDriveParams")
    alignment_rate = safe_float(jd.get("alignmentRate", 0)) if jd is not None else 0.0
    tuning_rate = safe_float(jd.get("tuningRate", 0)) if jd is not None else 0.0
    fuel_eff = safe_float(jd.get("fuelUsageEfficiencyMultiplier", 1)) if jd is not None else 1.0
    dist_el = root.find(".//SDistortionParams")
    dist_max = safe_float(dist_el.get("Maximum", 0)) if dist_el is not None else 0.0
    dist_decay_rate = safe_float(dist_el.get("DecayRate", 0)) if dist_el is not None else 0.0
    return {
        "className":       class_name,
        "name":            display,
        "manufacturer":    mfr_from_classname(class_name),
        "type":            "JumpDrive",
        "size":            info["size"],
        "grade":           info["grade"],
        "hp":              round(component_hp, 0),
        "alignmentRate":   round(alignment_rate, 2),
        "tuningRate":      round(tuning_rate, 2),
        "fuelEfficiency":  round(fuel_eff, 1),
        "distortionMax":   round(dist_max, 0),
        "distortionDecayRate": round(dist_decay_rate, 0),
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
        # Extract damageMultiplier (power boost) from first showInUI=1 phase
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


def parse_emp_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "EMP":
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
    emp = root.find(".//SCItemEMPParams")
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "EMP",
        "size":         info["size"],
        "grade":        info["grade"],
        "chargeTime":   round(safe_float(emp.get("chargeTime", 0)), 1) if emp is not None else 0,
        "cooldownTime": round(safe_float(emp.get("cooldownTime", 0)), 1) if emp is not None else 0,
        "distortionDamage": round(safe_float(emp.get("distortionDamage", 0)), 0) if emp is not None else 0,
        "empRadius":    round(safe_float(emp.get("empRadius", 0)), 0) if emp is not None else 0,
    }


def parse_qed_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "QuantumInterdictionGenerator":
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
    qed = root.find(".//SCItemQuantumInterdictionGeneratorParams")
    cooling = parse_cooling_demand(root)
    return {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "QuantumInterdictionGenerator",
        "size":         info["size"],
        "grade":        info["grade"],
        "psruRef":      cooling["psruRef"],
        "basePowerDrawFraction": round(safe_float(qed.get("basePowerDrawFraction", 0)), 2) if qed is not None else 0,
        **parse_power_ranges(root),
    }


def parse_blade_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] != "FlightController":
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
    # Extract Tags from AttachDef for port-tag matching
    ad = root.find(".//AttachDef")
    tags_str = ad.get("Tags", "") if ad is not None else ""
    item_tags = [t.strip() for t in tags_str.split() if t.strip()] if tags_str else []

    result = {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "FlightController",
        "size":         info["size"],
        "grade":        info["grade"],
    }
    if item_tags:
        result["itemTags"] = item_tags
    # Embed flight stats directly on the item
    stats = _parse_flight_stats_from_root(root)
    if stats:
        result.update(stats)
    # Apply blade modifiers (SIFCSModifiersLegacy) if present
    ifcs = root.find(".//IFCSParams")
    if ifcs is not None:
        mod_guid = ifcs.get("modifiersLegacy", "")
        if mod_guid and mod_guid != "null":
            _apply_blade_modifiers(result, mod_guid)
    return result


# Blade modifier definitions (from SIFCSModifiersLegacy forge XMLs)
# PHB (handling): slower speeds, better rotation
# TSB (speed): faster speeds, worse rotation
_BLADE_MODIFIERS = {
    # PHB — flightblade_hnd.xml
    "6cb04e5d-3037-259a-1b6b-04c2a25662ad": {
        "numbers": [-8, -10, -10, -25],  # scm, nav, boostFwd, boostBwd (additive)
        "rotAdd": [1, 2, 1],  # pitch, roll, yaw (additive to base rotation)
        "rotScale": [1.01, 0.99, 1.01],  # pitch, roll, yaw (scalar for boosted)
    },
    # Also match the reversed-endian form
    "259a3037-6cb0-4e5d-ad62-56a2c2046b1b": {
        "numbers": [-8, -10, -10, -25],
        "rotAdd": [1, 2, 1],
        "rotScale": [1.01, 0.99, 1.01],
    },
    # TSB — flightblade_spd.xml
    "924f496f-2fca-46cb-b425-2310d485a9b8": {
        "numbers": [8, 10, 10, 25],  # scm, nav, boostFwd, boostBwd (additive)
        "rotAdd": [-1, -2, -1],  # pitch, roll, yaw
        "rotScale": [0.99, 1.01, 0.99],
    },
    "46cb2fca-924f-496f-b8a9-85d4102325b4": {
        "numbers": [8, 10, 10, 25],
        "rotAdd": [-1, -2, -1],
        "rotScale": [0.99, 1.01, 0.99],
    },
}

def _apply_blade_modifiers(item, mod_guid):
    """Apply SIFCSModifiersLegacy additive/scalar modifiers to flight stats."""
    mod = _BLADE_MODIFIERS.get(mod_guid)
    if not mod:
        return
    nums = mod["numbers"]
    # Additive speed modifiers
    if "scmSpeed" in item:
        item["scmSpeed"] = round(item["scmSpeed"] + nums[0], 1)
    if "navSpeed" in item:
        item["navSpeed"] = round(item["navSpeed"] + nums[1], 1)
    if "boostSpeedFwd" in item:
        item["boostSpeedFwd"] = round(item["boostSpeedFwd"] + nums[2], 1)
    if "boostSpeedBwd" in item:
        item["boostSpeedBwd"] = round(item["boostSpeedBwd"] + nums[3], 1)
    # Additive rotation modifiers (pitch=x, roll=y, yaw=z)
    rot_add = mod["rotAdd"]
    if "pitch" in item:
        item["pitch"] = round(item["pitch"] + rot_add[0], 1)
    if "roll" in item:
        item["roll"] = round(item["roll"] + rot_add[1], 1)
    if "yaw" in item:
        item["yaw"] = round(item["yaw"] + rot_add[2], 1)
    # Scalar boosted rotation
    rot_scale = mod["rotScale"]
    if "pitchBoosted" in item:
        item["pitchBoosted"] = round(item["pitchBoosted"] * rot_scale[0], 1)
    if "rollBoosted" in item:
        item["rollBoosted"] = round(item["rollBoosted"] * rot_scale[1], 1)
    if "yawBoosted" in item:
        item["yawBoosted"] = round(item["yawBoosted"] * rot_scale[2], 1)


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

# Sub-port types we want to expose as loadout sub-slots. Manned turret
# entities also declare Display/Room/Light/etc. ports which aren't
# user-equippable; filtering them here keeps the JSON clean.
WEAPON_SUBPORT_TYPES = frozenset({
    "Turret", "WeaponGun", "WeaponMining", "MiningModifier",
    "SalvageHead", "SalvageModifier", "TractorBeam",
    "MissileLauncher", "BombLauncher", "Missile", "Bomb", "Module",
    "Shield",
})

def _build_subport_dict(port_el, port_name, port_types):
    """Build a sub-port dict for a turret/mount/module's SItemPortDef.

    Note on `Flags`: the source XML uses `Flags="uneditable"` (or
    `$uneditable`) for two distinct concepts:

      1. Engine-structural lock: "this attachment is rigidly mounted on
         the parent and cannot be detached at the simulation level."
         Polaris top turrets, Hammerhead upper guns, etc. all have this
         flag, but those slots are user-swappable in-game.
      2. User-customisation lock: the slot is bespoke to a specific
         ship-tagged item and the player can't replace it (Polaris
         lower-front Maris cannons, Idris main guns).

    The discriminator is `RequiredPortTags`. Case (2) always pairs the
    engine flag with a non-empty bespoke tag filter; case (1) leaves
    the tag fields blank. So we only forward the `uneditable` flag to
    the runtime when both signals are present.
    """
    raw_flags = port_el.get("Flags", "") or ""
    required_tags = port_el.get("RequiredPortTags", "") or ""
    port_tags = port_el.get("PortTags", "") or ""
    sp = {
        "id": port_name,
        "type": port_types[0],
        "minSize": int(port_el.get("MinSize", 0)),
        "maxSize": int(port_el.get("MaxSize", 0)),
        "allTypes": [{"type": t} for t in port_types],
    }
    is_user_locked = "uneditable" in raw_flags and bool(required_tags.strip())
    if is_user_locked:
        sp["flags"] = "$uneditable"
    if port_tags.strip():
        sp["portTags"] = port_tags
    if required_tags.strip():
        sp["requiredPortTags"] = required_tags
    return sp

def parse_weapon_mount_item(root, class_name, loc):
    info = parse_attachdef(root)
    if not info or info["type"] not in ("Turret", "TurretBase"):
        return None
    # Accept: gimbals/fixed mounts, ball turrets, canard (nose) turrets,
    # PDC turrets, and bespoke manned turret structures (Polaris, Hammerhead,
    # Idris, etc.). Manned turrets are TurretBase + MannedTurret in the XML
    # and were previously skipped, leaving their sub-port `Flags` (e.g.
    # uneditable bespoke gun mounts) invisible to the runtime.
    is_manned_turret = info["type"] == "TurretBase" and info["subType"] == "MannedTurret"
    if not is_manned_turret and info["subType"] not in ("GunTurret", "Gun", "BallTurret", "CanardTurret", "PDCTurret"):
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
        "mount_gimbal_s8_perseus":        "rsi_perseus_ballisticcannon_b_s8",
        "mount_gimbal_s8_perseus_bottom": "rsi_perseus_ballisticcannon_b_s8",
    }

    # Extract ship-specific item tags (tags containing '_', strip '$' prefix).
    # These are used for port-tag filtering so items only appear in compatible slots.
    attach_el = root.find(".//AttachDef")
    tags_raw = (attach_el.get("Tags", "") if attach_el is not None else "").split()
    item_tags = [t.lstrip("$") for t in tags_raw if "_" in t]

    # Extract sub-hardpoints this turret/mount provides (gun slots, missile rack slots, etc.)
    # Same pattern as parse_module_item — rich structured data for dynamic UI slot generation.
    # Only include weapon-relevant port types — manned turret entities also expose Display
    # and Room sub-ports (screens, ops centres) which we don't want as loadout slots.
    sub_ports = []
    for port_el in root.iter("SItemPortDef"):
        port_name = port_el.get("Name", "")
        if not port_name:
            continue
        types_el = port_el.findall(".//SItemPortDefTypes")
        port_types = [t.get("Type", "") for t in types_el if t.get("Type")]
        if not port_types:
            continue
        if port_types[0] not in WEAPON_SUBPORT_TYPES:
            continue
        sp = _build_subport_dict(port_el, port_name, port_types)
        sub_ports.append(sp)

    # Manned turret structures (Polaris, Hammerhead, Idris, etc.). Expose
    # them as TurretBase items so the runtime can find their subPorts and
    # honour any per-port `Flags="uneditable"` set in the source XML.
    if is_manned_turret:
        result = {
            "className":    class_name,
            "name":         display,
            "manufacturer": mfr_from_classname(class_name),
            "type":         "TurretBase",
            "subType":      "MannedTurret",
            "size":         info["size"],
            "grade":        info["grade"],
        }
        if sub_ports:
            result["subPorts"] = sub_ports
        if item_tags:
            result["itemTags"] = item_tags
        return result

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
        if sub_ports:
            result["subPorts"] = sub_ports
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
    if sub_ports:
        result["subPorts"] = sub_ports
    weapon_lock = TURRET_WEAPON_LOCK.get(class_name.lower())
    if weapon_lock:
        result["weaponLock"] = weapon_lock
    if item_tags:
        result["itemTags"] = item_tags
    return result

def parse_module_item(root, class_name, loc):
    """Parse a ship module (e.g. Aurora MK II cargo/combat modules)."""
    info = parse_attachdef(root)
    if not info or info["type"] != "Module":
        return None

    # Skip abstract base modules with no localization
    loc_el = root.find(".//AttachDef/Localization") or root.find(".//Localization")
    loc_name_ref = loc_el.get("Name", "") if loc_el is not None else ""
    if loc_name_ref in ("@LOC_PLACEHOLDER", "@LOC_EMPTY", ""):
        return None

    display = loc_lookup(loc, loc_name_ref) if loc_name_ref else resolve_item_name(loc, class_name)
    if not display or display.startswith("@"):
        display = resolve_item_name(loc, class_name)
    if not display or display.startswith("@"):
        return None

    # Extract sub-hardpoints that this module provides (like turrets expose sub-slots)
    sub_ports = []
    for port_el in root.iter("SItemPortDef"):
        port_name = port_el.get("Name", "")
        if not port_name:
            continue
        types_el = port_el.findall(".//SItemPortDefTypes")
        port_types = [t.get("Type", "") for t in types_el if t.get("Type")]
        if not port_types:
            continue
        if port_types[0] not in WEAPON_SUBPORT_TYPES:
            continue
        sp = _build_subport_dict(port_el, port_name, port_types)
        sub_ports.append(sp)

    # Extract item tags for port-tag filtering
    attach_el = root.find(".//AttachDef")
    tags_raw = (attach_el.get("Tags", "") if attach_el is not None else "").split()
    item_tags = [t.lstrip("$") for t in tags_raw if "_" in t]

    result = {
        "className":    class_name,
        "name":         display,
        "manufacturer": mfr_from_classname(class_name),
        "type":         "Module",
        "size":         info["size"],
        "grade":        info["grade"],
    }
    if sub_ports:
        result["subPorts"] = sub_ports
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
    "bombcompartments":  parse_missile_rack_item,
    "weapons/missiles":  parse_missile_projectile_item,
    "weapon_mounts":     parse_weapon_mount_item,
    "turret":            parse_weapon_mount_item,
    "utility/mining/miningarm": parse_miningarm_item,
    "utility/salvage/salvagehead": parse_salvagehead_item,
    "utility/salvage/salvagemodifiers": parse_miningarm_item,  # reuse generic parser
    "module":            parse_module_item,
    "weapons/emp":       parse_emp_item,
    "weapons/qig":       parse_qed_item,
    "quantumenforcementdevice": parse_qed_item,
    "jumpdrive":             parse_jumpdrive_item,
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

    # Flight blades (and standard controllers): in the controller folder
    # Skip internal variants: _mm_ (master mode), _rework, _pu_ (AI)
    _BLADE_SKIP = re.compile(r'_mm_|_rework|_pu_ai|_pu_pirate')
    blade_dir = ships_dir / "controller"
    if blade_dir.exists():
        count = 0
        for xml_file in blade_dir.glob("controller_flight_*.xml.xml"):
            class_name = xml_file.stem.replace(".xml", "")
            if class_name in items or _BLADE_SKIP.search(class_name):
                continue
            try:
                root = ET.parse(xml_file).getroot()
                parsed = parse_blade_item(root, class_name, loc)
                if parsed:
                    items[class_name] = parsed
                    count += 1
            except Exception:
                pass
        print(f"    flight blades: {count} items")

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

# Bespoke weapons whose ammo files use a different naming convention.
# Maps weapon className (lowercase) → ammo key (as produced by ammo_filename_key).
BESPOKE_AMMO_ALIASES = {
    "krig_ballisticgatling_bespoke_s4": "krig_wolf_ballisticgatling_s4",
    "krig_laserrepeater_bespoke_s4":   "krig_wolf_laserrepeater_s4",
}

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
        data = ammo_data.get(key) or ammo_data.get(BESPOKE_AMMO_ALIASES.get(key, ""))
        if not data:
            sorted_key = "_".join(sorted(key.split("_")))
            data = ammo_sorted.get(sorted_key)
        if data:
            item["projectileSpeed"] = data["speed"]
            item["range"]           = data["range"]
            speed_enriched += 1
    print(f"  Enriched {speed_enriched} weapons with speed/range")

def extract_mining_locations(forge_dir, dcb_path):
    """Extract per-location mining mineral distributions from HarvestableProviderPreset XMLs + DCB."""
    hpp_base = forge_dir / "harvestable" / "providerpresets"
    if not hpp_base.exists():
        print("  WARNING: harvestable/providerpresets not found")
        return []

    # Build HarvestablePreset GUID → name map from DCB
    with open(dcb_path, "rb") as f:
        d = f.read()
    h = _dcb_parse_header(d)
    hp_si = h["struct_by_name"].get("HarvestablePreset")
    if hp_si is None:
        print("  WARNING: HarvestablePreset struct not found in DCB")
        return []

    def _uuid_to_mixed_le(uuid_str):
        clean = uuid_str.replace('-', '')
        if len(clean) != 32: return None
        try: b = bytes.fromhex(clean)
        except ValueError: return None
        return b[3::-1] + b[5:3:-1] + b[7:5:-1] + b[8:16]

    hp_guid_to_name = {}
    for ri in range(h["n_records"]):
        rp = h["rec_start"] + ri * 32
        if struct.unpack_from("<I", d, rp + 8)[0] != hp_si: continue
        guid_raw = d[rp + 12: rp + 28]
        try:
            rname = h["blob"](struct.unpack_from("<I", d, rp)[0])
            hp_guid_to_name[guid_raw] = rname.replace("HarvestablePreset.", "")
        except: pass

    # Location display name mapping
    LOC_NAMES = {
        "hpp_stanton1": "Hurston", "hpp_stanton1a": "Aberdeen", "hpp_stanton1b": "Arial",
        "hpp_stanton1c": "Ita", "hpp_stanton1d": "Magda",
        "hpp_stanton2a": "Cellin", "hpp_stanton2b": "Daymar", "hpp_stanton2c": "Yela",
        "hpp_stanton2c_belt": "Yela Belt",
        "hpp_stanton3a": "Lyria", "hpp_stanton3b": "Wala",
        "hpp_stanton4": "microTech", "hpp_stanton4a": "Calliope",
        "hpp_stanton4b": "Clio", "hpp_stanton4c": "Euterpe",
        "hpp_aaronhalo": "Aaron Halo",
        # Lagrange presets are shared profiles mapped to multiple points.
        # Mapping validated against community mining data.
        "hpp_lagrange_occupied": "Lagrange (Occupied)",
        "hpp_pyro1": "Pyro I", "hpp_pyro2": "Pyro II", "hpp_pyro3": "Pyro III",
        "hpp_pyro4": "Pyro IV", "hpp_pyro5a": "Pyro Va", "hpp_pyro5b": "Pyro Vb",
        "hpp_pyro5c": "Pyro Vc", "hpp_pyro5d": "Pyro Vd", "hpp_pyro5e": "Pyro Ve",
        "hpp_pyro5f": "Pyro Vf", "hpp_pyro6": "Pyro VI",
        "hpp_nyx_keegerbelt": "Keeger Belt (Nyx)", "hpp_nyx_glaciemring": "Glaciem Ring (Nyx)",
        "hpp_pyro_akirocluster": "Akiro Cluster", "hpp_pyro_deepspaceasteroids": "Pyro Deep Space",
        "hpp_pyro_cool01": "Pyro Cool Zone 1", "hpp_pyro_cool02": "Pyro Cool Zone 2",
        "hpp_pyro_warm01": "Pyro Warm Zone 1", "hpp_pyro_warm02": "Pyro Warm Zone 2",
        "hpp_shipgraveyard_001": "Ship Graveyard",
        "asteroidcluster_medium_yield": "Asteroid Cluster (Medium)",
        "asteroidcluster_low_yield": "Asteroid Cluster (Low)",
    }

    # Clean preset name → mineral display name
    def _mineral_name(preset):
        n = preset
        # Strip all known prefixes (may be stacked, e.g., "Mining_AsteroidCommon_Iron")
        while True:
            stripped = False
            for pfx in ("Mining_", "FPSMining_", "GroundVehicleMining_", "GroundVehicle",
                         "FPS", "Asteroid", "Common_", "Uncommon_", "Rare_",
                         "Epic_", "Legendary_"):
                if n.startswith(pfx):
                    n = n[len(pfx):]
                    stripped = True
            if not stripped:
                break
        return n or preset

    def _mineral_tier(preset):
        p = preset.lower()
        if "legendary" in p: return "Legendary"
        if "epic" in p: return "Epic"
        if "rare" in p: return "Rare"
        if "uncommon" in p: return "Uncommon"
        return "Common"

    GROUP_LABELS = {
        "SpaceShip_Mineables": "ship",
        "GroundVehicle_Mineables": "roc",
        "FPS_Mineables": "hand",
    }

    # Extract MineableElement properties (instability, resistance, etc.)
    sdefs = h["struct_defs"]
    me_si = h["struct_by_name"].get("MineableElement")
    element_props = {}
    if me_si and me_si in h["struct_data"]:
        me_off2, me_cnt2 = h["struct_data"][me_si]
        me_rs2 = sdefs[me_si][4]
        for ri in range(h["n_records"]):
            rp = h["rec_start"] + ri * 32
            if struct.unpack_from("<I", d, rp + 8)[0] != me_si: continue
            variant = struct.unpack_from("<H", d, rp + 28)[0]
            try: rname = h["blob"](struct.unpack_from("<I", d, rp)[0])
            except: continue
            name = rname.split(".")[-1].replace("_Ore","").replace("_Raw","")
            # Strip prefixes for consistency
            for pfx in ("MinableElement_FPS_", "MinableElement_GroundVehicle_", "MinableElement_"):
                if name.startswith(pfx): name = name[len(pfx):]
            if "template" in name.lower() or "Test" in name: continue
            inst = me_off2 + variant * me_rs2
            element_props[name.lower()] = {
                "name": name,
                "instability": round(struct.unpack_from("<f", d, inst + 20)[0], 1),
                "resistance": round(struct.unpack_from("<f", d, inst + 24)[0], 2),
                "optimalWindow": round(struct.unpack_from("<f", d, inst + 28)[0], 2),
                "optimalWindowRand": round(struct.unpack_from("<f", d, inst + 32)[0], 2),
                "optimalThinness": round(struct.unpack_from("<f", d, inst + 36)[0], 2),
                "explosionMultiplier": round(struct.unpack_from("<f", d, inst + 40)[0], 2),
                "clusterFactor": round(struct.unpack_from("<f", d, inst + 44)[0], 2),
            }
        print(f"  Mineral element properties: {len(element_props)}")

    results = []
    for xml_file in sorted(hpp_base.rglob("*.xml.xml")):
        root = ET.parse(xml_file).getroot()
        hpp_name = xml_file.stem.replace(".xml", "")
        location = LOC_NAMES.get(hpp_name.lower(), hpp_name)

        mining = {}  # group → [{ mineral, tier, probability }]
        for gel in root.iter("HarvestableElementGroup"):
            gname = gel.get("groupName", "")
            group_key = GROUP_LABELS.get(gname)
            if not group_key: continue
            entries = []
            for eel in gel.iter("HarvestableElement"):
                harv_uuid = eel.get("harvestable", "")
                if not harv_uuid or harv_uuid == "null": continue
                rel_prob = safe_float(eel.get("relativeProbability", 0))
                dcb_guid = _uuid_to_mixed_le(harv_uuid)
                if not dcb_guid: continue
                hp_name = hp_guid_to_name.get(dcb_guid, "")
                if not hp_name: continue
                if not any(kw in hp_name for kw in ("Mining", "FPS", "GroundVehicle")): continue
                entries.append({
                    "mineral": _mineral_name(hp_name),
                    "tier": _mineral_tier(hp_name),
                    "probability": rel_prob,
                })
            if entries:
                total = sum(e["probability"] for e in entries)
                for e in entries:
                    e["percent"] = round(e["probability"] / total * 100, 1) if total > 0 else 0
                mining[group_key] = sorted(entries, key=lambda x: -x["probability"])

        if mining:
            # Determine system
            system = "Stanton"
            if "pyro" in hpp_name.lower(): system = "Pyro"
            elif "nyx" in hpp_name.lower(): system = "Nyx"
            results.append({
                "id": hpp_name.lower(),
                "location": location,
                "system": system,
                "mining": mining,
            })

    # Expand Lagrange presets into individual points.
    # Each preset is a shared mineral profile used by multiple Lagrange points.
    LAGRANGE_EXPANSION = {
        "hpp_lagrange_a": ["HUR-L1", "HUR-L4"],
        "hpp_lagrange_b": ["ARC-L5", "CRU-L4", "MIC-L3"],
        "hpp_lagrange_c": ["HUR-L5", "MIC-L1", "MIC-L5"],
        "hpp_lagrange_d": ["ARC-L3", "CRU-L5", "MIC-L4"],
        "hpp_lagrange_e": ["CRU-L1", "HUR-L3"],
        "hpp_lagrange_f": ["ARC-L1", "ARC-L2", "ARC-L4", "HUR-L2"],
        "hpp_lagrange_g": ["CRU-L2", "CRU-L3"],
        "hpp_lagrange_occupied": ["MIC-L2"],
    }
    expanded = []
    for loc in results:
        points = LAGRANGE_EXPANSION.get(loc["id"])
        if points:
            for pt in points:
                expanded.append({
                    "id": f"lagrange_{pt.lower().replace('-', '')}",
                    "location": pt,
                    "system": "Stanton",
                    "mining": loc["mining"],
                })
        else:
            expanded.append(loc)
    results = expanded

    # Attach element stats to each mineral entry
    for loc in results:
        for group_key, entries in loc["mining"].items():
            for e in entries:
                mineral_lower = e["mineral"].lower()
                props = element_props.get(mineral_lower)
                if props:
                    e["instability"] = props["instability"]
                    e["resistance"] = props["resistance"]

    print(f"  Mining locations extracted: {len(results)}")
    return {"locations": results, "elements": list(element_props.values())}


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
    key = f"vehicle_name{variant_cls}".lower()
    if key in loc:
        return loc[key]
    # Strip common infixes like _gs_ (Aurora): rsi_aurora_gs_mr → rsi_aurora_mr
    stripped = re.sub(r'_gs_', '_', variant_cls)
    key2 = f"vehicle_name{stripped}".lower()
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
        r'_sec$|_hurstondynamics|_tutorial|_derelict|_wreck|_boarded|'
        r'_teach$|_showdown$|_bis\d|_gamemaster|_invictus|_bombless|_s3bombs|'
        r'_nointerior|_nodebris|_citizencon|_drug|_shipshowdown|_shipboarded|'
        r'_tier_|_plat$|_fw_\d|_ai_|_nocargo|_halfcargo|_override|_spawn$|'
        r'_utility$|_civilian$|_stunt|_temp$|_crewless|_mission_|_swarm$|'
        r'_psec$|_advocacy$|_low_poly|_dropship|_pu$'
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

    # Manual variant expansion for ships whose variants don't share the base prefix
    MANUAL_VARIANTS = {
        "ORIG_300i": ["orig_315p", "orig_325a", "orig_350r"],
        "VNCL_Scythe": ["vncl_glaive"],
        "TMBL_Cyclone": ["TMBL_Cyclone_AA", "TMBL_Cyclone_MT", "TMBL_Cyclone_RC", "TMBL_Cyclone_RN", "TMBL_Cyclone_TR"],
        "KRIG_P52_Merlin": ["krig_p72_archimedes"],
        "rsi_apollo_medivac": ["rsi_hermes"],  # Hermes uses Apollo vehicle XML with modification="Hermes"
        "RSI_Ursa_Rover": ["rsi_ursa_medivac"],
        "TMBL_Storm": ["tmbl_storm_aa"],
    }
    for base_cls, variant_list in MANUAL_VARIANTS.items():
        base_ship = expanded.get(base_cls)
        if not base_ship:
            continue
        for variant_cls in variant_list:
            if variant_cls in expanded:
                continue  # already expanded via prefix matching
            clone = copy.deepcopy(base_ship)
            clone["className"] = variant_cls
            clone["name"] = _resolve_variant_name(variant_cls, loc)
            expanded[variant_cls] = clone
            variants_added += 1

    print(f"  Expanded {variants_added} variants from {len(ships)} base vehicles → {len(expanded)} total ships")
    return expanded


def _apply_vehicle_modification(ship, mod_name):
    """
    Apply a named vehicle XML modification to a ship's hardpoints.
    Reads from ship['_modifications'] and ship['_idToHp'] (set by parse_vehicle_xml).
    Supports: type, flags, minSize/maxSize, subtypes changes on hardpoints.
    """
    mods = ship.get("_modifications", {})
    id_to_hp = ship.get("_idToHp", {})
    if mod_name not in mods:
        return
    elems = mods[mod_name]
    hp_by_name = {hp["id"].lower(): hp for hp in ship.get("hardpoints", [])}

    for elem in elems:
        id_ref = elem["idRef"]
        prop = elem["name"].lower()
        value = elem["value"]
        info = id_to_hp.get(id_ref)

        if not info:
            continue
        hp_name = info.get("hpName", "").lower()
        hp = hp_by_name.get(hp_name)

        # Non-hardpoint changes (structural Parts like hull body)
        if prop == "damagemax" and not hp:
            ship["bodyHp"] = safe_float(value)
            continue

        # Re-enable a previously skipped Part (must check before the hp guard)
        if prop == "skippart" and value == "0" and not hp:
            skipped = ship.get("_skippedParts", {})
            if hp_name in skipped:
                restored = skipped.pop(hp_name)
                ship["hardpoints"].append(restored)
                hp_by_name[hp_name] = restored
            continue

        if not hp:
            continue

        tag = info.get("tag", "")
        if tag == "Type" and prop == "type":
            # Change a hardpoint's type (e.g., Misc → QuantumInterdictionGenerator)
            type_idx = info.get("typeIdx", 0)
            all_types = hp.get("allTypes", [])
            if type_idx < len(all_types):
                all_types[type_idx]["type"] = value
            # Update primary type if it's the first Type element
            if type_idx == 0:
                hp["type"] = value
        elif tag == "Type" and prop in ("subtypes", "subtype"):
            type_idx = info.get("typeIdx", 0)
            all_types = hp.get("allTypes", [])
            if type_idx < len(all_types):
                all_types[type_idx]["subtypes"] = value
            if type_idx == 0:
                hp["subtypes"] = value
        elif tag == "ItemPort" and prop == "flags":
            hp["flags"] = value
        elif tag == "ItemPort" and prop in ("minsize", "minSize"):
            hp["minSize"] = safe_int(value)
        elif tag == "ItemPort" and prop in ("maxsize", "maxSize"):
            hp["maxSize"] = safe_int(value)
        elif prop == "flags":
            # flags can be set on non-ItemPort elements too (e.g., Part)
            hp["flags"] = value
        elif prop in ("minsize", "minSize"):
            hp["minSize"] = safe_int(value)
        elif prop in ("maxsize", "maxSize"):
            hp["maxSize"] = safe_int(value)
        elif prop == "skippart" and value == "1":
            # Remove this hardpoint from the ship
            ship["hardpoints"] = [h for h in ship["hardpoints"] if h["id"].lower() != hp_name]
            hp_by_name.pop(hp_name, None)
        elif prop == "skippart" and value == "0":
            # Re-enable a previously skipped Part
            skipped = ship.get("_skippedParts", {})
            if hp_name in skipped and hp_name not in hp_by_name:
                restored = skipped.pop(hp_name)
                ship["hardpoints"].append(restored)
                hp_by_name[hp_name] = restored
        elif prop == "damagemax":
            # Hull HP change — apply to ship level
            ship["totalHp"] = safe_float(value)
            ship["bodyHp"] = safe_float(value)


def enrich_ships_from_dcb(ships, forge_dir, loc):
    spaceship_dir = forge_dir / "entities" / "spaceships"
    if not spaceship_dir.exists():
        print(f"  WARNING: spaceships dir not found")
        return

    # Build normalized lookup: strip underscores for fuzzy matching
    # (handles cases like KRIG_L22_alpha_wolf ↔ krig_l22_alphawolf)
    ship_keys_by_lower = {}
    ship_keys_no_uscore = {}
    for k in ships:
        ship_keys_by_lower[k.lower()] = k
        ship_keys_no_uscore[k.lower().replace('_', '')] = k

    enriched = 0
    for xml_file in spaceship_dir.glob("*.xml"):
        stem = xml_file.stem.replace(".xml", "")
        matched = ship_keys_by_lower.get(stem.lower()) \
                or ship_keys_no_uscore.get(stem.lower().replace('_', ''))
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

            # Apply vehicle XML modifications for this variant
            mod_name = vc.get("modification", "").strip()
            if mod_name:
                _apply_vehicle_modification(ship, mod_name)

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
                    _allowed_invis_forge = {"FlightController", "BombLauncher", "Shield", "PowerPlant", "Cooler", "Radar", "QuantumDrive", "LifeSupportGenerator"}
                    types_el_chk = port_def.find("Types")
                    if not (types_el_chk is not None and any(
                        t.get("Type") in _allowed_invis_forge for t in types_el_chk.findall("SItemPortDefTypes")
                    )):
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

    # Forge entity name -> vehicle XML name aliases (when names differ)
    FORGE_ALIASES = {
        "anvl_c8_pisces":       "ANVL_Pisces",
        "krig_l22_alphawolf":   "KRIG_L22_alpha_wolf",
    }

    enriched = 0
    # Scan both spaceships and ground vehicles directories
    scan_dirs = [spaceship_dir]
    gv_dir = forge_dir / "entities" / "groundvehicles"
    if gv_dir.exists():
        scan_dirs.append(gv_dir)

    for scan_dir in scan_dirs:
        for xml_file in sorted(scan_dir.glob("*.xml")):
            stem = xml_file.stem.replace(".xml", "")
            alias = FORGE_ALIASES.get(stem.lower())
            matched = next((k for k in ships if k.lower() == (alias or stem).lower()), None)
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

    # Enrich thruster HP in hull parts tree using the now-available default loadout
    _thruster_forge_dir = _SC / f"sc_data_forge_{DATA_MODE}/libs/foundry/records/entities/scitem/ships/thrusters"
    _thruster_hp_global = {}  # cache: entity_class -> HP

    def _enrich_thruster_hp(nodes, dl):
        for node in nodes:
            if node.get("category") == "thruster" and node.get("hp", 0) == 0:
                hp_name = node["name"]
                thruster_cls = dl.get(hp_name, "")
                if thruster_cls:
                    tcl = thruster_cls.lower()
                    if tcl not in _thruster_hp_global:
                        forge_path = _thruster_forge_dir / f"{thruster_cls}.xml.xml"
                        if forge_path.exists():
                            try:
                                content = forge_path.read_text(errors="replace")
                                m = re.search(r'SHealthComponentParams[^>]*Health="([^"]+)"', content)
                                _thruster_hp_global[tcl] = safe_float(m.group(1)) if m else 0
                            except Exception:
                                _thruster_hp_global[tcl] = 0
                        else:
                            _thruster_hp_global[tcl] = 0
                    node["hp"] = round(_thruster_hp_global[tcl])
            _enrich_thruster_hp(node.get("children", []), dl)

    for ship in ships.values():
        if ship.get("hullPartsTree") and ship.get("defaultLoadout"):
            _enrich_thruster_hp(ship["hullPartsTree"], ship["defaultLoadout"])

    # Normalize variant-suffixed loadout keys.
    # Some variants (e.g., Zeus CL) use port names like "hardpoint_cooler_left_cl"
    # in their loadout, but the shared vehicle XML has "hardpoint_cooler_left".
    # Remap these so the frontend can match loadout keys to hardpoint IDs.
    remapped_total = 0
    for ship_cls, ship in ships.items():
        dl = ship.get("defaultLoadout")
        if not dl:
            continue
        hp_ids = {hp["id"].lower() for hp in ship.get("hardpoints", [])}
        # Build suffix from the variant portion of the class name (e.g., "_cl", "_es")
        # by finding keys that don't match any hardpoint but would if suffix stripped
        parts = ship_cls.lower().rsplit("_", 1)
        if len(parts) < 2:
            continue
        suffix = "_" + parts[1]  # e.g., "_cl"
        remapped = {}
        for key, val in list(dl.items()):
            base_key = key.lower().split(".")[0]  # top-level port, ignore sub-slots
            if base_key not in hp_ids and base_key.endswith(suffix):
                new_key = key[:-(len(suffix))] + key[len(key) - len(suffix) + len(suffix):]
                # Strip suffix from the top-level port portion only
                new_key = key.replace(base_key, base_key[:-len(suffix)], 1)
                remapped[key] = new_key
        if remapped:
            for old_key, new_key in remapped.items():
                dl[new_key] = dl.pop(old_key)
            remapped_total += len(remapped)
    if remapped_total:
        print(f"  Remapped {remapped_total} variant-suffixed loadout keys")

    # Fallback loadouts for ships with empty DCB data
    _300_BASE_LOADOUT = {
        "hardpoint_weapon_nose":             "mount_gimbal_s3",
        "hardpoint_weapon_nose.hardpoint_class_2": "behr_lasercannon_s3",
        "hardpoint_weapon_wing_left":        "mount_gimbal_s3",
        "hardpoint_weapon_wing_left.hardpoint_class_2": "behr_ballisticrepeater_s3",
        "hardpoint_weapon_wing_right":       "mount_gimbal_s3",
        "hardpoint_weapon_wing_right.hardpoint_class_2": "behr_ballisticrepeater_s3",
        "hardpoint_shield_generator_left":   "shld_seco_s01_web_scitem",
        "hardpoint_shield_generator_right":  "shld_seco_s01_web_scitem",
        "hardpoint_cooler_left":             "cool_lplt_s01_arcticstorm_scitem",
        "hardpoint_cooler_right":            "cool_lplt_s01_arcticstorm_scitem",
        "hardpoint_power_plant":             "powr_lplt_s01_powerbolt_scitem",
        "hardpoint_radar":                   "radr_wlop_s01_capstan",
        "hardpoint_life_support":            "lfsp_tydt_s01_comfortair",
        "hardpoint_quantum_drive.hardpoint_jump_drive": "jdrv_tars_s01_explorer_scitem",
    }
    FALLBACK_LOADOUTS = {
        "ORIG_300i": {**_300_BASE_LOADOUT,
            "hardpoint_quantum_drive": "qdrv_tars_s01_expedition_scitem",
        },
        "orig_315p": {**_300_BASE_LOADOUT,
            "hardpoint_quantum_drive": "qdrv_godi_s01_goliath_scitem",
            "hardpoint_tractor.turret_left": "grin_tractorbeam_s2",
        },
        "orig_325a": {
            "hardpoint_weapon_nose":             "mount_gimbal_s4",
            "hardpoint_weapon_nose.hardpoint_class_2": "behr_lasercannon_s4",
            "hardpoint_weapon_wing_left":        "mount_gimbal_s3",
            "hardpoint_weapon_wing_left.hardpoint_class_2": "behr_ballisticrepeater_s3",
            "hardpoint_weapon_wing_right":       "mount_gimbal_s3",
            "hardpoint_weapon_wing_right.hardpoint_class_2": "behr_ballisticrepeater_s3",
            "hardpoint_weapon_missilerack_left":  "mrck_s03_behr_dual_s02",
            "hardpoint_weapon_missilerack_left.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_weapon_missilerack_left.missile_02_attach": "misl_s02_em_taln_dominator",
            "hardpoint_weapon_missilerack_right": "mrck_s03_behr_dual_s02",
            "hardpoint_weapon_missilerack_right.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_weapon_missilerack_right.missile_02_attach": "misl_s02_em_taln_dominator",
            "hardpoint_weapon_missilerack_center": "mrck_s05_behr_quad_s03",
            "hardpoint_weapon_missilerack_center.missile_01_attach": "misl_s03_cs_fski_arrester",
            "hardpoint_weapon_missilerack_center.missile_02_attach": "misl_s03_cs_fski_arrester",
            "hardpoint_weapon_missilerack_center.missile_03_attach": "misl_s03_cs_fski_arrester",
            "hardpoint_weapon_missilerack_center.missile_04_attach": "misl_s03_cs_fski_arrester",
            "hardpoint_shield_generator_left":   "shld_godi_s01_allstop_scitem",
            "hardpoint_shield_generator_right":  "shld_godi_s01_allstop_scitem",
            "hardpoint_cooler_left":             "cool_aegs_s01_bracer_scitem",
            "hardpoint_cooler_right":            "cool_aegs_s01_bracer_scitem",
            "hardpoint_power_plant":             "powr_aegs_s01_regulus_scitem",
            "hardpoint_quantum_drive":           "qdrv_wetk_s01_beacon_scitem",
            "hardpoint_quantum_drive.hardpoint_jump_drive": "jdrv_tars_s01_explorer_scitem",
            "hardpoint_radar":                   "radr_grnp_s01_ecouter",
            "hardpoint_life_support":            "lfsp_tydt_s01_comfortair",
        },
        "orig_350r": {
            "hardpoint_weapon_nose":             "mount_gimbal_s3",
            "hardpoint_weapon_nose.hardpoint_class_2": "behr_lasercannon_s3",
            "hardpoint_weapon_wing_left":        "mount_gimbal_s3",
            "hardpoint_weapon_wing_left.hardpoint_class_2": "klwe_laserrepeater_s3",
            "hardpoint_weapon_wing_right":       "mount_gimbal_s3",
            "hardpoint_weapon_wing_right.hardpoint_class_2": "klwe_laserrepeater_s3",
            "hardpoint_weapon_missilerack_left":  "mrck_s02_behr_single_s02",
            "hardpoint_weapon_missilerack_left.missile_01_attach": "misl_s02_cs_thcn_strikeforce",
            "hardpoint_weapon_missilerack_right": "mrck_s02_behr_single_s02",
            "hardpoint_weapon_missilerack_right.missile_01_attach": "misl_s02_cs_thcn_strikeforce",
            "hardpoint_shield_generator_left":   "shld_yorm_s01_targa_scitem",
            "hardpoint_shield_generator_right":  "shld_yorm_s01_targa_scitem",
            "hardpoint_cooler_left":             "cool_acom_s01_quickcool_scitem",
            "hardpoint_cooler_right":            "cool_acom_s01_quickcool_scitem",
            "hardpoint_power_plant":             "powr_acom_s01_sunflare_scitem",
            "hardpoint_quantum_drive":           "qdrv_rsi_s01_eos_scitem",
            "hardpoint_quantum_drive.hardpoint_jump_drive": "jdrv_tars_s01_explorer_scitem",
            "hardpoint_radar":                   "radr_nave_s01_snsr6",
            "hardpoint_life_support":            "lfsp_tydt_s01_comfortair",
        },
    }
    for ship_cls, fallback in FALLBACK_LOADOUTS.items():
        if ship_cls in ships and not ships[ship_cls].get("defaultLoadout"):
            ships[ship_cls]["defaultLoadout"] = fallback
            enriched += 1
            print(f"  Fallback loadout applied: {ship_cls}")

    # Module default overrides — inject defaults for module slots not populated in DCB.
    # Also defines module loadouts: sub-slot items that should be equipped when a module is active.
    MODULE_DEFAULTS = {
        "rsi_aurora_mk2": {
            "hardpoint_module": "rsi_aurora_mk2_module_cargo",
        },
    }
    # Per-module default loadouts: when this module is equipped, these sub-slots are populated.
    # Key format: "hardpoint_module.<sub_port_id>" for racks, dot-extended for missiles.
    MODULE_LOADOUTS = {
        "rsi_aurora_mk2_module_missile": {
            "hardpoint_module.missile_01_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_01_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_02_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_02_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_03_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_03_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_04_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_04_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_05_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_05_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_06_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_06_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_07_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_07_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.missile_08_rack": "mrck_s01_rsi_aurora_mk2_combat_module_rack",
            "hardpoint_module.missile_08_rack.missile_01_attach": "misl_s02_em_taln_dominator",
            "hardpoint_module.hardpoint_shield_generator_back": "shld_behr_s01_5sa_scitem",
        },
    }
    module_count = 0
    for ship_cls, module_loadout in MODULE_DEFAULTS.items():
        if ship_cls in ships and ships[ship_cls].get("defaultLoadout") is not None:
            dl = ships[ship_cls]["defaultLoadout"]
            for slot, item_cls in module_loadout.items():
                if slot not in dl:
                    dl[slot] = item_cls
                    module_count += 1
            # Inject module loadout entries for the default module
            default_module_cls = module_loadout.get("hardpoint_module", "")
            if default_module_cls in MODULE_LOADOUTS:
                for sub_slot, sub_cls in MODULE_LOADOUTS[default_module_cls].items():
                    if sub_slot not in dl:
                        dl[sub_slot] = sub_cls
                        module_count += 1
            # Also inject loadouts for ALL modules into the ship's defaultLoadout
            # so the UI can populate sub-slots when swapping modules
            for mod_cls, mod_loadout in MODULE_LOADOUTS.items():
                for sub_slot, sub_cls in mod_loadout.items():
                    if sub_slot not in dl:
                        dl[sub_slot] = sub_cls
    if module_count:
        print(f"  Module defaults injected: {module_count} slots")

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
    dmg_resist_refs = {}  # ship className -> hex index for DamageResistance
    enriched = 0
    for ship in ships.values():
        dl_armor = ship.get("defaultLoadout") or {}
        armor_cls = dl_armor.get("hardpoint_armor", "") or dl_armor.get("hardpoint_armour", "")
        # Fallback: derive armor class from ship className (armr_{className})
        # Try exact match first, then strip trailing segments for variant → base fallback
        if not armor_cls:
            base = ship["className"].lower()
            candidates = [f"armr_{base}"]
            parts = base.split("_")
            for i in range(len(parts) - 1, 1, -1):
                candidates.append(f"armr_{'_'.join(parts[:i])}")
            for cand in candidates:
                if (armor_dir / f"{cand}.xml.xml").exists():
                    armor_cls = cand
                    break
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
                # Extract DamageResistance reference for durability damage modifiers
                m2 = re.search(r'DamageResistances="DamageResistance\[([0-9A-Fa-f]+)\]"', txt)
                if m2:
                    dmg_resist_refs[ship["className"]] = m2.group(1)
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

        # Read durability damage modifiers from DCB DamageResistance records
        # Layout: 73 bytes per record
        #   [0]   bool IgnoreMeleeDamage
        #   [1]   f32 PhysicalResistance
        #   [13]  f32 EnergyResistance
        #   [17]  f32 DistortionResistance (slot A)
        #   [21]  f32 DistortionResistance (slot B)
        # Values are multipliers: <1 = damage reduced, >1 = damage amplified
        dr_si = h["struct_by_name"].get("DamageResistance")
        if dr_si is not None and dr_si in h["struct_data"] and dmg_resist_refs:
            dr_off, dr_cnt = h["struct_data"][dr_si]
            rec_size = 73
            dr_enriched = 0
            for cls_name, hex_idx in dmg_resist_refs.items():
                idx = int(hex_idx, 16)
                if idx >= dr_cnt:
                    continue
                base = dr_off + idx * rec_size
                phys_r = struct.unpack_from("<f", dcb_d, base + 1)[0]
                enrg_r = struct.unpack_from("<f", dcb_d, base + 13)[0]
                # Distortion: check both slots, take the non-zero one
                dist_a = struct.unpack_from("<f", dcb_d, base + 17)[0]
                dist_b = struct.unpack_from("<f", dcb_d, base + 21)[0]
                dist_r = dist_a if dist_a != 0 else dist_b
                if cls_name in ships:
                    ships[cls_name]["durabilityPhys"] = round(phys_r, 4)
                    ships[cls_name]["durabilityEnrg"] = round(enrg_r, 4)
                    ships[cls_name]["durabilityDist"] = round(dist_r, 4)
                    dr_enriched += 1
            print(f"  Durability damage modifiers enriched: {dr_enriched} ships")

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


def enrich_shield_face_type(ships, forge_dir):
    """Extract shield FaceType (Bubble/Quadrant) from per-ship shield controller entities."""
    ctrl_dir = forge_dir / "entities" / "scitem" / "ships" / "controller"
    if not ctrl_dir.exists():
        return
    enriched = 0
    for ship_cls, ship in ships.items():
        # Try common naming patterns for the shield controller
        cn = ship_cls.lower()
        candidates = [
            f"controller_shield_{cn}.xml.xml",
            f"controller_shield_{cn.replace('_', '')}.xml.xml",
        ]
        for cand in candidates:
            path = ctrl_dir / cand
            if path.exists():
                try:
                    content = path.read_text(errors="replace")
                    m = re.search(r'FaceType="(\w+)"', content)
                    if m:
                        ship["shieldFaceType"] = m.group(1)  # "Bubble" or "Quadrant"
                        enriched += 1
                except Exception:
                    pass
                break
        if "shieldFaceType" not in ship:
            # Infer from shield size: S1/S2 = Bubble, S3+ = Quadrant
            shield_hps = [hp for hp in ship.get("hardpoints", []) if hp.get("type") == "Shield"]
            if shield_hps:
                max_shield_size = max(hp.get("maxSize", 1) for hp in shield_hps)
                ship["shieldFaceType"] = "Quadrant" if max_shield_size >= 3 else "Bubble"
            else:
                ship["shieldFaceType"] = "Bubble"
    print(f"  Shield face type enriched: {enriched} ships (from forge)")


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
    pdt_si = si("ProjectileDetonationParams")
    ep_si = si("ExplosionParams")

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

    def get_detonation(bpp_idx):
        """Read ProjectileDetonationParams from BPP instance (pointer at +0/+4)."""
        if not pdt_si or pdt_si not in sd or bpp_si not in sd: return None
        b_off, b_cnt = sd[bpp_si]
        b_rs = sdefs[bpp_si][4]
        if bpp_idx >= b_cnt: return None
        inst = b_off + bpp_idx * b_rs
        ptr_si2 = u32at(inst); ptr_ii2 = u32at(inst + 4)
        if ptr_si2 != pdt_si: return None
        p_off, p_cnt = sd[pdt_si]
        p_rs = sdefs[pdt_si][4]
        if ptr_ii2 >= p_cnt: return None
        pinst = p_off + ptr_ii2 * p_rs
        return {
            "minRadius": round(struct.unpack_from("<f", d, pinst + 20)[0], 2),
            "maxRadius": round(struct.unpack_from("<f", d, pinst + 24)[0], 2),
        }

    def get_explosion_damage(bpp_idx):
        """Read explosion damage for distortion weapons.
        The explosion DamageInfo is consistently at bullet_DI_index - 1."""
        if bpp_si not in sd or di_si not in sd: return None
        b_off, b_cnt = sd[bpp_si]
        b_rs = sdefs[bpp_si][4]
        if bpp_idx >= b_cnt: return None
        inst = b_off + bpp_idx * b_rs
        # Bullet DamageInfo pointer at bytes 16-23
        ptr_si2 = u32at(inst + 16); bullet_di = u32at(inst + 20)
        if ptr_si2 != di_si: return None
        # Explosion DamageInfo is at index - 1
        exp_di = bullet_di - 1
        di_off2, di_cnt2 = sd[di_si]
        if exp_di < 0 or exp_di >= di_cnt2: return None
        base = di_off2 + exp_di * 24
        v = struct.unpack_from("<6f", d, base)
        total = sum(v)
        if total > 0.01:
            return {"physical":round(v[0],4),"energy":round(v[1],4),"distortion":round(v[2],4),
                    "thermal":round(v[3],4),"biochemical":round(v[4],4),"stun":round(v[5],4)}
        return None

    def get_penetration(bpp_idx):
        """Read penetration distance and radius from BPP instance (offsets +73/+77/+81)."""
        if bpp_si not in sd: return None
        b_off, b_cnt = sd[bpp_si]
        b_rs = sdefs[bpp_si][4]
        if bpp_idx >= b_cnt: return None
        inst = b_off + bpp_idx * b_rs
        dist = round(struct.unpack_from("<f", d, inst + 73)[0], 4)
        min_r = round(struct.unpack_from("<f", d, inst + 77)[0], 4)
        max_r = round(struct.unpack_from("<f", d, inst + 81)[0], 4)
        if dist <= 0 and min_r <= 0 and max_r <= 0: return None
        return {"distance": dist, "minRadius": min_r, "maxRadius": max_r}

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
        alias = BESPOKE_AMMO_ALIASES.get(key, "")
        bpp_idx = ammo_to_bpp.get(key) or ammo_to_bpp.get(key+"_ammo") \
               or ammo_to_bpp.get(alias) or ammo_to_bpp.get(alias+"_ammo")
        dmg = None
        if bpp_idx is not None:
            dmg = get_damage(bpp_idx)
            # If bullet damage is near-zero, check explosion damage (distortion weapons)
            if dmg and sum(dmg.values()) < 0.01 and bpp_idx is not None:
                exp_dmg = get_explosion_damage(bpp_idx)
                if exp_dmg:
                    dmg = exp_dmg
        # Fallback to forge XML damageInfo for ballistic/distortion weapons
        if not dmg:
            dmg = forge_ammo_damage.get(key) or forge_ammo_damage.get(key+"_ammo") \
               or forge_ammo_damage.get(alias) or forge_ammo_damage.get(alias+"_ammo")
        if not dmg: continue
        # Scattergun pellet multiplication: the DCB damage record stores
        # per-pellet damage, but the player-facing alpha is per-shot total.
        # Multiply each damage component by the pellet count for any weapon
        # in SHIP_PELLET_COUNTS. Without this, every scattergun's curated DB
        # values would conflict with the local extraction on every diff.
        pellets = SHIP_PELLET_COUNTS.get(class_name.lower(), 1)
        if pellets > 1:
            dmg = {k: round(v * pellets, 4) for k, v in dmg.items()}
            item["pelletCount"] = pellets
        item["damage"] = dmg
        item["alphaDamage"] = round(sum(dmg.values()), 4)
        # Detonation params (proximity radius for distortion/scatter weapons)
        if bpp_idx is not None:
            det = get_detonation(bpp_idx)
            if det and det["maxRadius"] > 0:
                item["detonationMinRadius"] = det["minRadius"]
                item["detonationMaxRadius"] = det["maxRadius"]
            # Penetration distance and radius (all weapons)
            pen = get_penetration(bpp_idx)
            if pen:
                item["penetrationDistance"] = pen["distance"]
                item["penetrationMinRadius"] = pen["minRadius"]
                item["penetrationMaxRadius"] = pen["maxRadius"]
        dmg_enriched += 1

    pen_count = sum(1 for i in items.values() if i.get("penetrationDistance"))
    det_count = sum(1 for i in items.values() if i.get("detonationMaxRadius"))
    print(f"  Weapons enriched with damage: {dmg_enriched} ({pen_count} with penetration, {det_count} with detonation)")

    # ── Enrich missile damage via DamageInfo index ────────────────────────────
    misl_enriched = 0
    if di_si and di_si in sd:
        di_off, di_cnt = sd[di_si]
        for item in items.values():
            if item.get("type") not in ("Missile", "Bomb"): continue
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
                # Pattern 4: charged fire action (tachyon/singe cannons, mass drivers)
                # Total cycle = chargeTime + cooldownTime + innerFireDelay
                # Inner fire rate is per-weapon, stored in DCB struct (not in forge XML).
                # Validated against SPViewer:
                #   Singe S1-S3: inner=89  → S2=24.8, S3=18.9 RPM
                #   KLWE Sledge S1-S3: inner=30  → S2=17.1, S3=13.3 RPM
                #   APAR Strife S2: inner=60  → 17.1 RPM
                CHARGED_INNER_RATES = {
                    "tachyoncannon": 89.0,   # Singe (Banu)
                    "klwe_massdriver": 30.0,  # Sledge (Klaus & Werner)
                    "apar_massdriver": 60.0,  # Strife (Apocalypse Arms)
                }
                if rpm == 0:
                    for el in root.iter("SWeaponActionFireChargedParams"):
                        charge = safe_float(el.get("chargeTime", 0))
                        cooldown = safe_float(el.get("cooldownTime", 0))
                        if charge > 0:
                            inner = 89.0  # default
                            for prefix, rate in CHARGED_INNER_RATES.items():
                                if prefix in class_name.lower():
                                    inner = rate
                                    break
                            cycle = charge + cooldown + 60.0 / inner
                            rpm = round(60.0 / cycle, 1)
                            break
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
                max_regen_per_sec = f32at(base + 24)  # f32[6]
                if max_ammo_load > 0:
                    item["ammoCount"]       = round(max_ammo_load)
                    item["regenCooldown"]   = round(cooldown, 4)
                    item["costPerBullet"]   = round(cost_per_bullet, 2)
                    item["requestedAmmoLoad"] = round(req_ammo_load, 2)
                    item["maxAmmoLoad"]     = round(max_ammo_load)
                    item["maxRegenPerSec"]  = round(max_regen_per_sec, 2)
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
        psru_enriched = {"Shield": 0, "Cooler": 0, "LifeSupportGenerator": 0, "Radar": 0, "QuantumInterdictionGenerator": 0}
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

def main(mode: str = "live"):
    _configure_mode(mode)

    print("=" * 60)
    print(f"VerseDB Extractor — Star Citizen Data Pipeline [{DATA_MODE.upper()}]")
    print("=" * 60)

    # Step 0: Extract from p4k if intermediate dirs are missing or stale
    need_extract = not VEHICLE_XML_DIR.exists() or not FORGE_DIR.exists() or not DCB_FILE.exists()
    if not need_extract:
        # Check if extracted data matches current build
        marker = _SC / f"sc_data_{DATA_MODE}" / ".build_version"
        if marker.exists():
            extracted_version = marker.read_text().strip()
            if extracted_version != GAME_VERSION:
                print(f"\n  Build changed: {extracted_version} → {GAME_VERSION}")
                print(f"  Clearing stale intermediate dirs…")
                for suffix in (f"sc_data_xml_{DATA_MODE}", f"sc_data_{DATA_MODE}", f"sc_data_forge_{DATA_MODE}"):
                    stale_dir = _SC / suffix
                    if stale_dir.exists():
                        shutil.rmtree(stale_dir)
                need_extract = True
        else:
            # No marker — legacy dirs, re-extract to be safe
            need_extract = True
    if need_extract:
        print(f"\n[0] Extracting from {DATA_MODE.upper()} p4k…")
        _run_p4k_extraction()

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

    # 2a. DCB entity count safety check — detect forge export gaps
    spaceship_forge_dir = FORGE_DIR / "entities" / "spaceships"
    if spaceship_forge_dir.exists() and DCB_FILE.exists():
        forge_count = len(list(spaceship_forge_dir.glob("*.xml.xml")))
        try:
            with open(DCB_FILE, "rb") as f:
                dcb_raw = f.read()
            needle = b"entities/spaceships/"
            dcb_entities = set()
            idx = 0
            while True:
                idx = dcb_raw.find(needle, idx)
                if idx == -1:
                    break
                end = dcb_raw.find(b".xml", idx)
                if end > 0:
                    path = dcb_raw[idx:end+4].decode("utf-8", errors="replace")
                    dcb_entities.add(path.split("/")[-1].replace(".xml", ""))
                idx = (end if end > 0 else idx) + 1
            gap = len(dcb_entities) - forge_count
            if gap > 0:
                missing_names = dcb_entities - set(f.stem.replace(".xml", "") for f in spaceship_forge_dir.glob("*.xml.xml"))
                print(f"  ⚠ FORGE EXPORT GAP: {gap} DCB entities not exported ({len(dcb_entities)} in DCB, {forge_count} exported)")
                for m in sorted(missing_names):
                    print(f"    Missing: {m}")
            else:
                print(f"  Forge export check: {forge_count} entities OK (matches DCB)")
            del dcb_raw
        except Exception as e:
            print(f"  Forge export check failed: {e}")

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

    # Remove hardpoints that don't belong on specific variants
    HP_EXCLUSIONS = {
        "ORIG_300i":   {"hardpoint_tractor"},  # tractor turret only on 315p
        "orig_325a":   {"hardpoint_tractor"},
        "orig_350r":   {"hardpoint_tractor"},
        "espr_talon":        {"hardpoint_leg_blankingplate_right", "hardpoint_leg_blankingplate_left"},  # blankingplate racks only on Shrike
        "espr_talon_shrike": {"hardpoint_missile_right", "hardpoint_missile_left"},  # S3 missile racks only on Talon
        "crus_starlifter_c2": {                                     # A2-only turrets
            "hardpoint_bridge_remote_turret",                       # Turret 6
            "hardpoint_forward_left_remote_turret",                 # Turret 2
            "hardpoint_forward_right_remote_turret",                # Turret 3
            "hardpoint_rear_left_remote_turret",                    # Turret 4
            "hardpoint_rear_right_remote_turret",                   # Turret 5
            "hardpoint_remote_turret_bottom",                       # Nose turret (M2+A2 only)
            "hardpoint_bombrack_left",                              # Bomb racks A2-only
            "hardpoint_bombrack_right",
            "hardpoint_shield_generator_c",                         # 3rd shield A2-only
        },
        "crus_starlifter_m2": {                                     # A2-only turrets
            "hardpoint_bridge_remote_turret",                       # Turret 6
            "hardpoint_forward_left_remote_turret",                 # Turret 2
            "hardpoint_forward_right_remote_turret",                # Turret 3
            "hardpoint_rear_left_remote_turret",                    # Turret 4
            "hardpoint_rear_right_remote_turret",                   # Turret 5
            "hardpoint_bombrack_left",                              # Bomb racks A2-only
            "hardpoint_bombrack_right",
            "hardpoint_shield_generator_c",                         # 3rd shield A2-only
        },
        "cnou_mustang_alpha": {"hardpoint_rocket_wing_left", "hardpoint_rocket_wing_right"},  # rockets only on Delta
        "cnou_mustang_beta":  {"hardpoint_rocket_wing_left", "hardpoint_rocket_wing_right"},
        "cnou_mustang_gamma": {"hardpoint_rocket_wing_left", "hardpoint_rocket_wing_right"},
        "cnou_mustang_omega": {"hardpoint_rocket_wing_left", "hardpoint_rocket_wing_right"},
        "aegs_sabre_peregrine": {"hardpoint_weapon_left_nose", "hardpoint_weapon_right_nose",
                                 "hardpoint_weapon_left_wing", "hardpoint_weapon_right_wing",
                                 "hardpoint_weapon_missilerack_right", "hardpoint_weapon_missilerack_left"},
        "aegs_sabre_firebird": {"hardpoint_weapon_left_nose", "hardpoint_weapon_right_nose",
                                "hardpoint_weapon_missilerack_right", "hardpoint_weapon_missilerack_left"},
        "rsi_zeus_es": {"hardpoint_tractor_beam", "hardpoint_bounty_turret_top", "hardpoint_passenger_turret_top"},
        "rsi_zeus_cl": {"hardpoint_bounty_turret_top", "hardpoint_passenger_turret_top",
                        "hardpoint_bounty_emp", "hardpoint_bounty_quantum_damp"},
        "aegs_avenger_stalker": {"hardpoint_weapon_emp"},
        "aegs_avenger_titan": {"hardpoint_weapon_emp"},
        "aegs_avenger_titan_renegade": {"hardpoint_weapon_emp"},
        "aegs_vanguard": {"hardpoint_weapon_emp"},
        "aegs_vanguard_harbinger": {"hardpoint_weapon_emp"},
        "aegs_vanguard_hoplite": {"hardpoint_weapon_emp"},
        "rsi_scorpius_antares": {"hardpoint_remote_turret", "hardpoint_turret_missile_camera"},
        "rsi_perseus": {
            "hardpoint_turret_torpedo_camera",
            "hardpoint_torpedo_storage_left_01", "hardpoint_torpedo_storage_left_02",
            "hardpoint_torpedo_storage_left_03", "hardpoint_torpedo_storage_left_04",
            "hardpoint_torpedo_storage_left_05", "hardpoint_torpedo_storage_left_06",
            "hardpoint_torpedo_storage_left_07", "hardpoint_torpedo_storage_left_08",
            "hardpoint_torpedo_storage_left_09", "hardpoint_torpedo_storage_left_10",
            "hardpoint_torpedo_storage_right_01", "hardpoint_torpedo_storage_right_02",
            "hardpoint_torpedo_storage_right_03", "hardpoint_torpedo_storage_right_04",
            "hardpoint_torpedo_storage_right_05", "hardpoint_torpedo_storage_right_06",
            "hardpoint_torpedo_storage_right_07", "hardpoint_torpedo_storage_right_08",
            "hardpoint_torpedo_storage_right_09", "hardpoint_torpedo_storage_right_10",
        },
        "aegs_idris_m": {"hardpoint_camera_turret_lower", "hardpoint_camera_turret_upper",
                         "hardpoint_rear_turret_tail", "hardpoint_rear_turret_tail_cap"},
        "aegs_idris_p": {"hardpoint_camera_turret_lower", "hardpoint_camera_turret_upper",
                         "hardpoint_rear_turret_tail_cap"},
    }
    for ship_cls, excluded_ids in HP_EXCLUSIONS.items():
        if ship_cls in ships:
            ships[ship_cls]["hardpoints"] = [
                hp for hp in ships[ship_cls].get("hardpoints", [])
                if hp["id"].lower() not in {x.lower() for x in excluded_ids}
            ]

    # Hornet Mk I: nose turret is bespoke (not swappable) — mark as uneditable
    _hornet_mk1_lock_nose = [
        "anvl_hornet_f7c", "anvl_hornet_f7c_wildfire",
        "anvl_hornet_f7cm", "anvl_hornet_f7cm_heartseeker",
    ]
    for hcls in _hornet_mk1_lock_nose:
        if hcls in ships:
            for hp in ships[hcls].get("hardpoints", []):
                if hp["id"].lower() == "hardpoint_class_4_nose":
                    hp["flags"] = "$uneditable"

    # Talon: missile hardpoints exist in entity XML but not in base vehicle XML
    if "espr_talon" in ships:
        talon = ships["espr_talon"]
        for side in ("left", "right"):
            hp_id = f"hardpoint_missile_{side}"
            if not any(hp["id"].lower() == hp_id for hp in talon["hardpoints"]):
                talon["hardpoints"].append({
                    "id": hp_id, "label": f"Missile Rack - {side.title()}",
                    "type": "MissileLauncher", "subtypes": "MissileRack",
                    "minSize": 3, "maxSize": 3, "flags": "",
                    "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}],
                })

    # Guardian / Guardian MX: quantum damp hardpoint only exists on the QI variant
    for gcls in ("mrai_guardian", "mrai_guardian_mx"):
        if gcls in ships:
            ships[gcls]["hardpoints"] = [
                hp for hp in ships[gcls].get("hardpoints", [])
                if hp["id"].lower() != "hardpoint_quantum_damp"
            ]

    # Guardian (all variants): LS hardpoint in forge entity XML but missing from vehicle XML
    for gcls in ("mrai_guardian", "mrai_guardian_mx", "mrai_guardian_qi"):
        if gcls in ships:
            g = ships[gcls]
            if not any(hp["id"].lower() == "hardpoint_lifesupport" for hp in g["hardpoints"]):
                g["hardpoints"].append({
                    "id": "hardpoint_lifesupport", "label": "Life Support",
                    "type": "LifeSupportGenerator", "subtypes": "",
                    "minSize": 1, "maxSize": 1, "flags": "",
                    "allTypes": [{"type": "LifeSupportGenerator", "subtypes": ""}],
                })
                g.setdefault("defaultLoadout", {})["hardpoint_lifesupport"] = "lfsp_tydt_s01_comfortair"

    # All Cyclone variants: remove locked module mount (not swappable in-game)
    for cyc_cls in ("TMBL_Cyclone", "TMBL_Cyclone_AA", "TMBL_Cyclone_MT", "TMBL_Cyclone_RC", "TMBL_Cyclone_RN", "TMBL_Cyclone_TR"):
        if cyc_cls in ships:
            ships[cyc_cls]["hardpoints"] = [hp for hp in ships[cyc_cls]["hardpoints"] if hp["id"] != "hardpoint_module_attach"]

    # Cyclone AA: promote module sub-ports (missile racks + EMP) as visible hardpoints
    if "TMBL_Cyclone_AA" in ships:
        aa = ships["TMBL_Cyclone_AA"]
        aa_hps = [
            {"id": "hardpoint_module_attach.hardpoint_missilerack_left", "label": "Missile Rack - Left",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 2, "maxSize": 2, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_module_attach.hardpoint_missilerack_right", "label": "Missile Rack - Right",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 2, "maxSize": 2, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_module_attach.hardpoint_weapon_emp", "label": "EMP",
             "type": "EMP", "subtypes": "",
             "minSize": 1, "maxSize": 1, "flags": "uneditable",
             "allTypes": [{"type": "EMP", "subtypes": ""}]},
        ]
        for hp in aa_hps:
            if not any(h["id"] == hp["id"] for h in aa["hardpoints"]):
                aa["hardpoints"].append(hp)

    # Cyclone MT: remove module mount (locked), promote sub-ports as visible hardpoints
    if "TMBL_Cyclone_MT" in ships:
        mt = ships["TMBL_Cyclone_MT"]
        mt["hardpoints"] = [hp for hp in mt["hardpoints"] if hp["id"] != "hardpoint_module_attach"]
        mt_hps = [
            {"id": "hardpoint_module_attach.hardpoint_missilerack_left", "label": "Missile Rack - Left",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 3, "maxSize": 3, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_module_attach.hardpoint_missilerack_right", "label": "Missile Rack - Right",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 3, "maxSize": 3, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_module_attach.turret_weapon", "label": "Turret Weapon",
             "type": "WeaponGun", "subtypes": "Gun",
             "minSize": 1, "maxSize": 1, "flags": "uneditable",
             "allTypes": [{"type": "WeaponGun", "subtypes": "Gun"}]},
        ]
        for hp in mt_hps:
            if not any(h["id"] == hp["id"] for h in mt["hardpoints"]):
                mt["hardpoints"].append(hp)

    # Cyclone TR: promote turret weapon from module sub-port
    if "TMBL_Cyclone_TR" in ships:
        tr = ships["TMBL_Cyclone_TR"]
        tr_hp = {"id": "hardpoint_module_attach.turret_weapon", "label": "Turret Weapon",
                 "type": "WeaponGun", "subtypes": "Gun",
                 "minSize": 1, "maxSize": 1, "flags": "uneditable",
                 "allTypes": [{"type": "WeaponGun", "subtypes": "Gun"}]}
        if not any(h["id"] == tr_hp["id"] for h in tr["hardpoints"]):
            tr["hardpoints"].append(tr_hp)

    # Storm AA: remove inherited turret (replaced by missile module), promote missile racks
    if "tmbl_storm_aa" in ships:
        saa = ships["tmbl_storm_aa"]
        saa["hardpoints"] = [hp for hp in saa["hardpoints"] if hp["id"] != "hardpoint_primary_turret"]
        saa_hps = [
            {"id": "hardpoint_primary_turret.hardpoint_missile_rack_s1_left", "label": "Missile Rack S1 - Left",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 1, "maxSize": 1, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_primary_turret.hardpoint_missile_rack_s1_right", "label": "Missile Rack S1 - Right",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 1, "maxSize": 1, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_primary_turret.hardpoint_missile_rack_s2_left", "label": "Missile Rack S2 - Left",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 2, "maxSize": 2, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
            {"id": "hardpoint_primary_turret.hardpoint_missile_rack_s2_right", "label": "Missile Rack S2 - Right",
             "type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack",
             "minSize": 2, "maxSize": 2, "flags": "uneditable",
             "allTypes": [{"type": "MissileLauncher", "subtypes": "GroundVehicleMissileRack"}]},
        ]
        for hp in saa_hps:
            if not any(h["id"] == hp["id"] for h in saa["hardpoints"]):
                saa["hardpoints"].append(hp)

    # Idris M/P: nose railgun hardpoint accepts WeaponGun and MissileLauncher (torpedo)
    for idris_cls in ("aegs_idris_m", "aegs_idris_p"):
        if idris_cls in ships:
            for hp in ships[idris_cls].get("hardpoints", []):
                if hp["id"] == "hardpoint_nose_railgun":
                    hp["allTypes"] = [
                        {"type": "WeaponGun", "subtypes": "Gun"},
                        {"type": "MissileLauncher", "subtypes": "MissileRack"},
                    ]
                    break

    # Idris M/P: add Hammerfall torpedo default loadout keys so missiles populate when equipped
    for idris_cls in ("aegs_idris_m", "aegs_idris_p"):
        if idris_cls in ships:
            dl = ships[idris_cls].setdefault("defaultLoadout", {})
            for n in range(1, 21):  # 20 torpedoes
                key = f"hardpoint_nose_railgun.missile_{n:02d}_attach"
                if key not in dl:
                    dl[key] = "misl_s12_cs_taln_calamity"

    # Idris-P: nose weapon not in DCB loadout — equip Exodus-10 Laser Beam
    if "aegs_idris_p" in ships:
        idris_p_dl = ships["aegs_idris_p"].setdefault("defaultLoadout", {})
        if "hardpoint_nose_railgun" not in idris_p_dl:
            idris_p_dl["hardpoint_nose_railgun"] = "hrst_laserbeam_bespoke"

    # Hornet Mk I variants: nose turret loadout missing from DCB
    # The class_4_nose hardpoint should have the nose turret with 2× S1 laser repeaters
    _hornet_mk1_nose = {
        "hardpoint_class_4_nose": "anvl_hornet_f7c_nose_turret",
        "hardpoint_class_4_nose.hardpoint_class_1_left": "klwe_laserrepeater_s1",
        "hardpoint_class_4_nose.hardpoint_class_1_right": "klwe_laserrepeater_s1",
    }
    for hcls in ("anvl_hornet_f7c", "anvl_hornet_f7c_wildfire"):
        if hcls in ships:
            dl = ships[hcls].setdefault("defaultLoadout", {})
            for k, v in _hornet_mk1_nose.items():
                if k not in dl:
                    dl[k] = v

    # Origin 890 Jump radar: previously needed a manual patch here because the
    # invisible+uneditable filter dropped it. Now that the filter allows Radar
    # (and other critical component types) through, the radar flows naturally
    # from parse_vehicle_xml. Patch removed 2026-04-09.

    # Drake Cutter Rambler / Scout: variant-specific hardpoints live on child
    # geometry parts (roof, scout console) not on the vehicle XML itself, so
    # the parser never sees them. Synthesize from default loadout item sizes.
    _cutter_variant_patches = {
        "drak_cutter_rambler": [
            {"id": "hardpoint_expo_shield", "label": "Shield Generator", "type": "Shield", "size": 1},
            {"id": "hardpoint_expo_powerplant", "label": "Power Plant", "type": "PowerPlant", "size": 1},
        ],
        "drak_cutter_scout": [
            {"id": "hardpoint_scout_shieldgen", "label": "Shield Generator", "type": "Shield", "size": 1},
            {"id": "hardpoint_scout_powerplant", "label": "Power Plant", "type": "PowerPlant", "size": 2},
            {"id": "hardpoint_scout_cooler", "label": "Cooler", "type": "Cooler", "size": 2},
            {"id": "hardpoint_scout_radar", "label": "Radar", "type": "Radar", "size": 2},
            {"id": "hardpoint_scout_quantumdrive", "label": "Quantum Drive", "type": "QuantumDrive", "size": 1},
        ],
    }
    for cls, patches in _cutter_variant_patches.items():
        if cls in ships:
            hps = ships[cls].setdefault("hardpoints", [])
            existing = {hp["id"].lower() for hp in hps}
            patch_ids = {p["id"].lower() for p in patches}
            for p in patches:
                if p["id"].lower() not in existing:
                    hps.append({
                        "id": p["id"],
                        "label": p["label"],
                        "type": p["type"],
                        "subtypes": "",
                        "minSize": p["size"],
                        "maxSize": p["size"],
                        "flags": "",
                        "allTypes": [{"type": p["type"], "subtypes": ""}],
                    })
            # Clear CIG's invisible+uneditable flags on these ports — they're
            # swappable in-game despite what the XML says
            for hp in hps:
                if hp["id"].lower() in patch_ids and ("invisible" in hp.get("flags", "") or "uneditable" in hp.get("flags", "")):
                    hp["flags"] = ""

    # Aegis Aurora Mk II: CIG removed the module slot's port-tag filter in
    # build 4.7.0-live.11592622, leaving the slot untagged while the Aurora
    # cargo/combat module items still carry their RSI_Aurora_Mk2_Module
    # itemTags. The picker's "tagged item + untagged slot → reject" rule
    # would then empty the Aurora module picker entirely, breaking the
    # existing Aurora module workflow. Restore the canonical tag filter so
    # the slot keeps accepting (only) Aurora-tagged modules. The pattern
    # also serves as the reference shape for any future modular ship.
    if "rsi_aurora_mk2" in ships:
        for hp in ships["rsi_aurora_mk2"].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_module":
                if not hp.get("portTags"):
                    hp["portTags"] = "RSI_Aurora_Mk2_Module"
                fl = hp.get("flags") or ""
                if "exclusive_tags" not in fl:
                    hp["flags"] = (fl + " exclusive_tags").strip()

    # Sabre Firebird: CIG's loadout has the Mantis gatling on the wing slot
    # directly, with a self-referencing child entry under .hardpoint_class_2 —
    # an artefact of how their data was edited at some point. The in-game
    # state is gimballed: VariPuck S3 mount with the Mantis on its child slot.
    # Patch the parent entry so the loadout view renders the correct shape.
    if "aegs_sabre_firebird" in ships:
        dl = ships["aegs_sabre_firebird"].setdefault("defaultLoadout", {})
        for wing in ("hardpoint_weapon_left_wing", "hardpoint_weapon_right_wing"):
            child = f"{wing}.hardpoint_class_2"
            # Only patch when the parent slot is the bare gun and the child
            # entry already has the gun — avoids stomping any future CIG fix.
            if (dl.get(wing) == "gats_ballisticgatling_s3" and
                    dl.get(child) == "gats_ballisticgatling_s3"):
                dl[wing] = "mount_gimbal_s3"

    # F7C-R Tracker & F7C-S Ghost Mk I: nose is empty by default, can equip F7C Nose Turret
    for hcls in ("anvl_hornet_f7cr", "anvl_hornet_f7cs"):
        if hcls not in ships:
            continue
        dl = ships[hcls].setdefault("defaultLoadout", {})
        for k in list(dl.keys()):
            if k.lower().startswith("hardpoint_class_4_nose"):
                del dl[k]
        for hp in ships[hcls].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_nose":
                hp["portTags"] = "ANVL_Hornet_Center"
                hp["flags"] = "front nose exclusive_tags"

    # F7C-R Tracker Mk I: center slot also accepts WillsOp Radar (not Ghost Cap)
    if "anvl_hornet_f7cr" in ships:
        for hp in ships["anvl_hornet_f7cr"].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_center":
                hp["portTags"] = "ANVL_Hornet_Base ANVL_Hornet_Tracker"

    # F7C-S Ghost Mk I: center slot also accepts Ghost Center Cap (not WillsOp Radar)
    if "anvl_hornet_f7cs" in ships:
        for hp in ships["anvl_hornet_f7cs"].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_center":
                hp["portTags"] = "ANVL_Hornet_Base ANVL_Hornet_Ghost"

    # Hornet Mk II: default center item is cargo_door entity which isn't extracted as an item.
    # Replace with the actual cargo module item.
    for hcls in ("anvl_hornet_f7c_mk2", "anvl_hornet_f7cr_mk2", "anvl_hornet_f7cs_mk2"):
        if hcls in ships:
            dl = ships[hcls].setdefault("defaultLoadout", {})
            if dl.get("hardpoint_class_4_center") == "anvl_hornet_f7c_mk2_cargo_door":
                dl["hardpoint_class_4_center"] = "anvl_hornet_f7c_mk2_cargo_mod"

    # Hornet Mk II variants: nose slot is empty by default (not pre-equipped)
    # Remove any Mk I nose turret keys that may have been injected above
    for hcls in ("anvl_hornet_f7c_mk2", "anvl_hornet_f7cr_mk2", "anvl_hornet_f7cs_mk2"):
        if hcls in ships:
            dl = ships[hcls].setdefault("defaultLoadout", {})
            for k in list(dl.keys()):
                if k.lower().startswith("hardpoint_class_4_nose"):
                    del dl[k]

    # Hornet Mk II (F7C variants): DCB missile loadout uses hardpoint_missile_rack_left/right
    # but base vehicle hardpoints are hardpoint_class_3_*_bay_door. Replace with correct mapping.
    _hornet_mk2_missile_remap = {
        "hardpoint_missile_rack_left": "hardpoint_class_3_left_bay_door",
        "hardpoint_missile_rack_right": "hardpoint_class_3_right_bay_door",
    }
    for hcls in ("anvl_hornet_f7c_mk2", "anvl_hornet_f7cr_mk2", "anvl_hornet_f7cs_mk2"):
        if hcls not in ships:
            continue
        dl = ships[hcls].setdefault("defaultLoadout", {})
        for old_key, new_key in _hornet_mk2_missile_remap.items():
            if old_key in dl and new_key not in dl:
                dl[new_key] = dl.pop(old_key)
            for k in list(dl.keys()):
                if k.startswith(old_key + "."):
                    suffix = k[len(old_key):]
                    new_child = new_key + suffix
                    if new_child not in dl:
                        dl[new_child] = dl.pop(k)

    # Hornet Mk II variants: DCB loadout uses hardpoint_weapon_* keys but base vehicle XML
    # uses hardpoint_class_*. Remap loadout keys to match the hardpoint definitions.
    _hornet_mk2_weapon_remap = {
        "hardpoint_weapon_left_wing": "hardpoint_class_2_left_wing",
        "hardpoint_weapon_right_wing": "hardpoint_class_2_right_wing",
        "hardpoint_weapon_center": "hardpoint_class_4_center",
    }
    for hcls in ("anvl_hornet_f7c_mk2", "anvl_hornet_f7cr_mk2", "anvl_hornet_f7cs_mk2"):
        if hcls not in ships:
            continue
        dl = ships[hcls].setdefault("defaultLoadout", {})
        for old_key, new_key in _hornet_mk2_weapon_remap.items():
            if old_key in dl and new_key not in dl:
                dl[new_key] = dl.pop(old_key)
            for k in list(dl.keys()):
                if k.startswith(old_key + "."):
                    suffix = k[len(old_key):]
                    new_child = new_key + suffix
                    if new_child not in dl:
                        dl[new_child] = dl.pop(k)

    # Hornet Mk II: center configurable slot restricted to Mk II-tagged turrets only
    for hcls in ("anvl_hornet_f7c_mk2",):
        if hcls not in ships:
            continue
        for hp in ships[hcls].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_center":
                hp["portTags"] = "ANVL_Hornet_Mk2_Center"
                hp["flags"] = (hp.get("flags", "") + " exclusive_tags").strip()

    # F7C-R Tracker Mk II: center also accepts WillsOp Mk II Radar
    if "anvl_hornet_f7cr_mk2" in ships:
        for hp in ships["anvl_hornet_f7cr_mk2"].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_center":
                hp["portTags"] = "ANVL_Hornet_Mk2_Center ANVL_Hornet_Tracker_Mk2"
                hp["flags"] = (hp.get("flags", "") + " exclusive_tags").strip()

    # Hornet Mk II (F7C, F7C-R, F7C-S): nose slot restricted to the Mk II S2 Nose Turret only
    for hcls in ("anvl_hornet_f7c_mk2", "anvl_hornet_f7cr_mk2", "anvl_hornet_f7cs_mk2"):
        if hcls not in ships:
            continue
        for hp in ships[hcls].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_nose":
                hp["portTags"] = "ANVL_Hornet_F7C_Mk2_Nose"
                hp["flags"] = "front nose exclusive_tags"

    # F7C-S Ghost Mk II: center slot also accepts Ghost Mk II Center Cap
    if "anvl_hornet_f7cs_mk2" in ships:
        for hp in ships["anvl_hornet_f7cs_mk2"].get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_class_4_center":
                hp["portTags"] = "ANVL_Hornet_Mk2_Center ANVL_Hornet_Ghost_Mk2"
                hp["flags"] = (hp.get("flags", "") + " exclusive_tags").strip()

    # Hornet Mk I F7C-M / Heartseeker: DCB loadout uses hardpoint_gun_* keys
    _hornet_mk1_gun_remap = {
        "hardpoint_gun_wing_left": "hardpoint_class_2_left_wing",
        "hardpoint_gun_wing_right": "hardpoint_class_2_right_wing",
        "hardpoint_gun_center": "hardpoint_class_4_center",
        "hardpoint_gun_nose": "hardpoint_class_4_nose",
    }
    for hcls in ("anvl_hornet_f7cm", "anvl_hornet_f7cm_heartseeker"):
        if hcls not in ships:
            continue
        dl = ships[hcls].setdefault("defaultLoadout", {})
        for old_key, new_key in _hornet_mk1_gun_remap.items():
            if old_key in dl and new_key not in dl:
                dl[new_key] = dl.pop(old_key)
            for k in list(dl.keys()):
                if k.startswith(old_key + "."):
                    suffix = k[len(old_key):]
                    new_child = new_key + suffix
                    if new_child not in dl:
                        dl[new_child] = dl.pop(k)

    # Avenger Titan Renegade: wing sub-slots have missiles instead of guns in DCB loadout
    if "aegs_avenger_titan_renegade" in ships:
        ren_dl = ships["aegs_avenger_titan_renegade"].setdefault("defaultLoadout", {})
        ren_dl["hardpoint_weapon_gun_class1_left_wing.hardpoint_class_2"] = "amrs_lasercannon_s3"
        ren_dl["hardpoint_weapon_gun_class1_right_wing.hardpoint_class_2"] = "amrs_lasercannon_s3"

    # Polaris: top remote missile turret entity not extracted — remap to missile rack directly
    if "RSI_Polaris" in ships:
        pol = ships["RSI_Polaris"]
        dl = pol.setdefault("defaultLoadout", {})
        # Promote missile rack to the turret hardpoint level
        old_prefix = "hardpoint_turret_remote_top.hardpoint_missile"
        new_prefix = "hardpoint_turret_remote_top"
        # Replace turret entity with missile rack
        dl[new_prefix] = dl.pop(old_prefix, dl.get(new_prefix, ""))
        # Re-key missile sub-slots: remove the .hardpoint_missile intermediate
        rekeyed = {}
        for k, v in list(dl.items()):
            if k.startswith(old_prefix + "."):
                new_key = new_prefix + k[len(old_prefix):]
                rekeyed[new_key] = v
                del dl[k]
        dl.update(rekeyed)

    # Perseus: LS hardpoint is in forge entity XML but missing from vehicle XML
    if "rsi_perseus" in ships:
        per = ships["rsi_perseus"]
        per["hardpoints"].append({
            "id": "hardpoint_lifesupport", "label": "Life Support", "type": "LifeSupportGenerator",
            "subtypes": "", "minSize": 3, "maxSize": 3, "flags": "",
            "allTypes": [{"type": "LifeSupportGenerator", "subtypes": ""}],
        })
        per.setdefault("defaultLoadout", {})["hardpoint_lifesupport"] = "lfsp_tydt_s03_comfortairmax"

    # 890 Jump: system hardpoints defined as Part class="ItemPort" in vehicle XML, not SItemPortDef.
    # Pipeline doesn't extract them. Add manually.
    if "ORIG_890Jump" in ships:
        j890 = ships["ORIG_890Jump"]
        j890_hps = j890.setdefault("hardpoints", [])
        j890_missing = [
            ("hardpoint_powerplant_01", "Power Plant", "PowerPlant", 4, "$uneditable"),
            ("hardpoint_shield_generator_left", "Shield Left", "Shield", 4, ""),
            ("hardpoint_shield_generator_right", "Shield Right", "Shield", 4, ""),
            ("hardpoint_cooler_left", "Cooler Left", "Cooler", 4, ""),
            ("hardpoint_cooler_right", "Cooler Right", "Cooler", 4, ""),
            ("hardpoint_quantum_drive", "Quantum Drive", "QuantumDrive", 4, ""),
            ("hardpoint_lifesupport", "Life Support", "LifeSupportGenerator", 4, "uneditable"),
        ]
        existing_ids = {hp["id"].lower() for hp in j890_hps}
        for hp_id, label, hp_type, size, flags in j890_missing:
            if hp_id.lower() not in existing_ids:
                j890_hps.append({
                    "id": hp_id, "label": label, "type": hp_type,
                    "subtypes": "", "minSize": size, "maxSize": size, "flags": flags,
                    "allTypes": [{"type": hp_type, "subtypes": ""}],
                })
        # Thruster power bars — 890 Jump has 10 bars in-game
        if not j890.get("thrusterPowerBars"):
            j890["thrusterPowerBars"] = 10
        # Missile turrets: remap to MissileLauncher so they display as missile racks
        # In-game these are remote missile turrets with MSD-481 racks + 8× Ignite II
        dl890 = j890.setdefault("defaultLoadout", {})
        for mt_id in ("hardpoint_remote_missile_turret_left", "hardpoint_remote_missile_turret_right",
                       "hardpoint_remote_missile_turret_leftL", "hardpoint_remote_missile_turret_rightL"):
            # Promote the missile rack from sub-slot to the turret level
            rack_key = f"{mt_id.lower()}.turret_missile_rack"
            rack_cls = dl890.get(rack_key, "")
            if rack_cls:
                dl890[mt_id.lower()] = rack_cls
                del dl890[rack_key]
                # Re-key missile children: remove .turret_missile_rack intermediate
                for k in list(dl890.keys()):
                    if k.startswith(rack_key + "."):
                        new_key = mt_id.lower() + k[len(rack_key):]
                        dl890[new_key] = dl890.pop(k)
            # Change hardpoint type to MissileLauncher
            for hp in j890_hps:
                if hp["id"].lower() == mt_id.lower():
                    hp["type"] = "MissileLauncher"
                    hp["subtypes"] = "MissileRack"
                    hp["allTypes"] = [{"type": "MissileLauncher", "subtypes": "MissileRack"}]
                    hp["flags"] = "$uneditable"
                    hp["label"] = "Remote Missile Turret"
                    break

    # Tractor beam arms should display as tractor turrets, not mining tools
    for tcls, tid in [("rsi_zeus_cl", "hardpoint_tractor_beam"),
                       ("rsi_hermes", "hardpoint_remote_tractor_turret")]:
        if tcls in ships:
            for hp in ships[tcls]["hardpoints"]:
                if hp["id"].lower() == tid:
                    hp["type"] = "Turret"
                    hp["allTypes"] = [{"type": "Turret", "subtypes": ""}]

    # Scorpius Antares: "Interdiction" modification adds QED to modPart_Spine2
    # Both EMP and QED are locked (not swappable) on the Antares
    if "rsi_scorpius_antares" in ships:
        ant = ships["rsi_scorpius_antares"]
        ant["hardpoints"].append({
            "id": "hardpoint_qed", "label": "QED", "type": "QuantumInterdictionGenerator",
            "subtypes": "", "minSize": 3, "maxSize": 3, "flags": "$uneditable",
            "allTypes": [{"type": "QuantumInterdictionGenerator", "subtypes": ""}],
        })
        ant.setdefault("defaultLoadout", {})["hardpoint_qed"] = "qed_rsi_s03_scorpius"
        for hp in ant["hardpoints"]:
            if hp["id"] == "hardpoint_EMP":
                hp["flags"] = "$uneditable"

    # Add wing weapon hardpoints for P-52 Merlin and P-72 Archimedes
    # These come from wing sub-components, not the main entity XML
    _wing_hp_template = {
        "type": "Turret", "subtypes": "GunTurret", "minSize": 1, "maxSize": 1, "flags": "",
        "allTypes": [{"type": "Turret", "subtypes": "GunTurret"}, {"type": "WeaponGun", "subtypes": "Gun"}],
    }
    _radar_hp = {"id": "hardpoint_radar", "label": "Radar", "type": "Radar", "subtypes": "",
                  "minSize": 0, "maxSize": 0, "flags": "invisible", "allTypes": [{"type": "Radar", "subtypes": ""}]}
    _ls_hp = {"id": "hardpoint_lifesupport", "label": "Life Support", "type": "LifeSupportGenerator", "subtypes": "",
              "minSize": 0, "maxSize": 1, "flags": "invisible", "allTypes": [{"type": "LifeSupportGenerator", "subtypes": ""}]}
    if "KRIG_P52_Merlin" in ships:
        ships["KRIG_P52_Merlin"]["hardpoints"].extend([
            {**_wing_hp_template, "id": "hardpoint_wing_left.hardpoint_weapon_gun_left_wing", "label": "Wing Gun - Left"},
            {**_wing_hp_template, "id": "hardpoint_wing_right.hardpoint_weapon_gun_right_wing", "label": "Wing Gun - Right"},
            dict(_radar_hp), dict(_ls_hp),
        ])
    if "krig_p72_archimedes" in ships:
        ships["krig_p72_archimedes"]["hardpoints"].extend([
            {**_wing_hp_template, "id": "hardpoint_wing_left.hardpoint_weapon_gun_left_wing", "label": "Wing Gun - Outer Left"},
            {**_wing_hp_template, "id": "hardpoint_wing_left.hardpoint_weapon_gun_innerleft_wing", "label": "Wing Gun - Inner Left"},
            {**_wing_hp_template, "id": "hardpoint_wing_right.hardpoint_weapon_gun_right_wing", "label": "Wing Gun - Outer Right"},
            {**_wing_hp_template, "id": "hardpoint_wing_right.hardpoint_weapon_gun_innerright_wing", "label": "Wing Gun - Inner Right"},
            dict(_radar_hp), dict(_ls_hp),
        ])

    # Add Retaliator module hardpoints (front + rear bays for cargo/torpedo modules)
    if "AEGS_Retaliator" in ships:
        ships["AEGS_Retaliator"]["hardpoints"].extend([
            {"id": "hardpoint_front_module", "label": "Front Module Bay",
             "type": "Module", "subtypes": "", "minSize": 1, "maxSize": 10,
             "flags": "exclusive_tags", "portTags": "AEGS_Retaliator_Module_Front",
             "allTypes": [{"type": "Module", "subtypes": ""}]},
            {"id": "hardpoint_rear_module", "label": "Rear Module Bay",
             "type": "Module", "subtypes": "", "minSize": 1, "maxSize": 10,
             "flags": "exclusive_tags", "portTags": "AEGS_Retaliator_Module_Rear",
             "allTypes": [{"type": "Module", "subtypes": ""}]},
        ])

    # Add Sabre Firebird bespoke internal missile rack (24x S3 Thunderbolt III)
    if "aegs_sabre_firebird" in ships:
        ships["aegs_sabre_firebird"]["hardpoints"].append({
            "id": "hardpoint_weapon_missilerack", "label": "Internal Missile Rack",
            "type": "MissileLauncher", "subtypes": "MissileRack", "minSize": 6, "maxSize": 6,
            "flags": "$uneditable", "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}]})

    # Add MIS-specific internal missile launchers (2x S5 bespoke racks, 10x S3 missiles each)
    if "misc_freelancer_mis" in ships:
        ships["misc_freelancer_mis"]["hardpoints"].extend([
            {"id": "hardpoint_weapon_missilelauncher_left", "label": "Internal Launcher - Left",
             "type": "MissileLauncher", "subtypes": "MissileRack", "minSize": 5, "maxSize": 5,
             "flags": "$uneditable", "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}]},
            {"id": "hardpoint_weapon_missilelauncher_right", "label": "Internal Launcher - Right",
             "type": "MissileLauncher", "subtypes": "MissileRack", "minSize": 5, "maxSize": 5,
             "flags": "$uneditable", "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}]},
        ])

    # Hardpoint modifications for specific variants
    if "orig_325a" in ships:
        s325 = ships["orig_325a"]
        # Nose is S4 on 325a (S3 on other 300-series)
        for hp in s325.get("hardpoints", []):
            if hp["id"].lower() == "hardpoint_weapon_nose":
                hp["minSize"] = 4
                hp["maxSize"] = 4
        # 325a has a third (bespoke center) missile rack
        s325["hardpoints"].append({
            "id": "hardpoint_weapon_missilerack_center",
            "label": "Missile Rack",
            "type": "MissileLauncher",
            "subtypes": "",
            "minSize": 5,
            "maxSize": 5,
            "flags": "",
            "allTypes": [{"type": "MissileLauncher", "subtypes": ""}],
        })
        # Upgrade the two side racks from S2 to S3
        for hp in s325.get("hardpoints", []):
            if hp["id"].lower() in ("hardpoint_weapon_missilerack_left", "hardpoint_weapon_missilerack_right"):
                hp["minSize"] = 3
                hp["maxSize"] = 3

    # Manual cargo overrides for ships missing DCB cargo data
    CARGO_OVERRIDES = {"ORIG_300i": 8, "orig_315p": 12, "orig_325a": 4, "orig_350r": 0,
                       "rsi_aurora_mk2": 2,  # base cargo without module
                       "argo_moth": 224,
                       "ARGO_MOLE": 32}
    for ship_cls, scu in CARGO_OVERRIDES.items():
        if ship_cls in ships:
            ships[ship_cls]["cargoCapacity"] = scu

    enrich_countermeasures(ships, FORGE_DIR)
    enrich_shield_face_type(ships, FORGE_DIR)
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
        "aegs_avenger_titan": {
            "accelFwd": 15.2, "accelRetro": 3.9, "accelStrafe": 6.0, "accelUp": 6.0, "accelDown": 4.0,
            "accelAbFwd": 26.5, "accelAbRetro": 5.1, "accelAbStrafe": 8.1, "accelAbUp": 8.1, "accelAbDown": 5.4,
            "accelTestedDate": "2026-04-06", "accelCheckedBy": "Zimmy",
        },
        "aegs_avenger_titan_renegade": {
            "accelFwd": 15.2, "accelRetro": 3.9, "accelStrafe": 6.0, "accelUp": 6.0, "accelDown": 4.0,
            "accelAbFwd": 26.5, "accelAbRetro": 5.1, "accelAbStrafe": 8.1, "accelAbUp": 8.1, "accelAbDown": 5.4,
            "accelTestedDate": "2026-04-06", "accelCheckedBy": "Zimmy",
        },
        "aegs_gladius": {
            "accelFwd": 12.6, "accelRetro": 2.7, "accelStrafe": 6.0, "accelUp": 9.2, "accelDown": 3.0,
            "accelAbFwd": 19.6, "accelAbRetro": 3.3, "accelAbStrafe": 11.9, "accelAbUp": 11.8, "accelAbDown": 3.9,
            "accelTestedDate": "2026-03-24", "accelCheckedBy": "VerseTools Admin",
        },
        "anvl_hornet_f7cm_mk2": {
            "accelFwd": 9.7, "accelRetro": 3.1, "accelStrafe": 6.4, "accelUp": 6.8, "accelDown": 3.9,
            "accelAbFwd": 15.0, "accelAbRetro": 4.4, "accelAbStrafe": 8.6, "accelAbUp": 9.2, "accelAbDown": 5.3,
            "accelTestedDate": "2026-03-24", "accelCheckedBy": "VerseTools Admin",
        },
        "rsi_aurora_mk2": {
            "accelFwd": 9.2, "accelRetro": 3.0, "accelStrafe": 5.2, "accelUp": 5.2, "accelDown": 4.0,
            "accelAbFwd": 15.3, "accelAbRetro": 3.4, "accelAbStrafe": 7.0, "accelAbUp": 6.8, "accelAbDown": 5.6,
            "accelTestedDate": "2026-03-25", "accelCheckedBy": "VerseTools Admin",
        },
        "rsi_aurora_gs_se": {
            "accelFwd": 11.8, "accelRetro": 3.9, "accelStrafe": 7.1, "accelUp": 7.1, "accelDown": 5.6,
            "accelAbFwd": 16.5, "accelAbRetro": 5.1, "accelAbStrafe": 9.6, "accelAbUp": 9.3, "accelAbDown": 7.8,
            "accelTestedDate": "2026-03-26", "accelCheckedBy": "VerseTools Admin",
        },
        "aegs_reclaimer": {
            "accelFwd": 2.0, "accelRetro": 1.5, "accelStrafe": 1.0, "accelUp": 2.0, "accelDown": 2.0,
            "accelAbFwd": 2.7, "accelAbRetro": 2.1, "accelAbStrafe": 1.3, "accelAbUp": 2.8, "accelAbDown": 2.6,
            "accelTestedDate": "2026-03-26", "accelCheckedBy": "VerseTools Admin",
        },
        "anvl_asgard": {
            "accelFwd": 4.6, "accelRetro": 2.5, "accelStrafe": 3.5, "accelUp": 3.8, "accelDown": 3.8,
            "accelAbFwd": 6.9, "accelAbRetro": 3.6, "accelAbStrafe": 4.3, "accelAbUp": 5.0, "accelAbDown": 5.4,
            "accelTestedDate": "2026-03-26", "accelCheckedBy": "VerseTools Admin",
        },
        "krig_l22_alpha_wolf": {
            "accelFwd": 13.9, "accelRetro": 4.7, "accelStrafe": 10.2, "accelUp": 10.2, "accelDown": 5.4,
            "accelAbFwd": 19.5, "accelAbRetro": 6.1, "accelAbStrafe": 13.7, "accelAbUp": 13.2, "accelAbDown": 7.6,
            "accelTestedDate": "2026-03-26", "accelCheckedBy": "VerseTools Admin",
        },
        "rsi_polaris": {
            "accelFwd": 2.7, "accelRetro": 1.5, "accelStrafe": 1.5, "accelUp": 2.0, "accelDown": 2.0,
            "accelAbFwd": 4.1, "accelAbRetro": 1.8, "accelAbStrafe": 2.0, "accelAbUp": 2.6, "accelAbDown": 2.4,
            "accelTestedDate": "2026-03-26", "accelCheckedBy": "VerseTools Admin",
        },
        "ANVL_Hurricane": {
            "accelFwd": 10, "accelRetro": 3.6, "accelStrafe": 7.5, "accelUp": 7.5, "accelDown": 4.5,
            "accelAbFwd": 15.5, "accelAbRetro": 5.1, "accelAbStrafe": 10, "accelAbUp": 9.8, "accelAbDown": 6,
            "accelTestedDate": "2026-03-27", "accelCheckedBy": "VerseTools Admin",
        },
        "ARGO_MOLE": {
            "accelFwd": 4.9, "accelRetro": 3.4, "accelStrafe": 2.7, "accelUp": 3, "accelDown": 2.9,
            "accelAbFwd": 6.9, "accelAbRetro": 4.8, "accelAbStrafe": 3.5, "accelAbUp": 4.2, "accelAbDown": 3.8,
            "accelTestedDate": "2026-03-27", "accelCheckedBy": "VerseTools Admin",
        },
        "AEGS_Eclipse": {
            "accelFwd": 10.5, "accelRetro": 4.5, "accelStrafe": 6.5, "accelUp": 6.5, "accelDown": 3.5,
            "accelAbFwd": 15.7, "accelAbRetro": 6.3, "accelAbStrafe": 8.8, "accelAbUp": 8.4, "accelAbDown": 4.9,
            "accelTestedDate": "2026-04-01", "accelCheckedBy": "Zimmy",
        },
        "aegs_sabre_comet": {
            "accelFwd": 11.9, "accelRetro": 4.2, "accelStrafe": 8.4, "accelUp": 8.9, "accelDown": 4.7,
            "accelAbFwd": 18.5, "accelAbRetro": 5.8, "accelAbStrafe": 11.4, "accelAbUp": 11.6, "accelAbDown": 6.3,
            "accelTestedDate": "2026-04-01", "accelCheckedBy": "Zimmy",
        },
        "aegs_sabre": {
            "accelFwd": 11.9, "accelRetro": 4.2, "accelStrafe": 8.4, "accelUp": 8.9, "accelDown": 4.7,
            "accelAbFwd": 18.5, "accelAbRetro": 5.8, "accelAbStrafe": 11.4, "accelAbUp": 11.6, "accelAbDown": 6.3,
            "accelTestedDate": "2026-04-01", "accelCheckedBy": "Zimmy",
        },
        "aegs_sabre_firebird": {
            "accelFwd": 14.6, "accelRetro": 3.4, "accelStrafe": 4.3, "accelUp": 5.8, "accelDown": 3.4,
            "accelAbFwd": 24.8, "accelAbRetro": 4.4, "accelAbStrafe": 5.9, "accelAbUp": 7.9, "accelAbDown": 4.6,
            "accelTestedDate": "2026-04-01", "accelCheckedBy": "Zimmy",
        },
        "DRAK_Cutlass_Black": {
            "accelFwd": 10.3, "accelRetro": 3.8, "accelStrafe": 8, "accelUp": 8.2, "accelDown": 4.1,
            "accelAbFwd": 15.5, "accelAbRetro": 5.4, "accelAbStrafe": 10.8, "accelAbUp": 10.7, "accelAbDown": 5.8,
            "accelTestedDate": "2026-04-02", "accelCheckedBy": "Roma-Starkiller",
        },
        # ── Community-submitted acceleration data (auto-accel workflow) ──
        "ANVL_Arrow": {
            "accelFwd": 13.5, "accelRetro": 4.5, "accelStrafe": 10.8, "accelUp": 10.8, "accelDown": 5.2,
            "accelAbFwd": 20, "accelAbRetro": 6.3, "accelAbStrafe": 14, "accelAbUp": 14, "accelAbDown": 7.1,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
        },
        "ANVL_Hawk": {
            "accelFwd": 12.8, "accelRetro": 4.1, "accelStrafe": 9.7, "accelUp": 9.7, "accelDown": 4.8,
            "accelAbFwd": 19.9, "accelAbRetro": 5.7, "accelAbStrafe": 12.6, "accelAbUp": 12.6, "accelAbDown": 6.5,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
        },
        "anvl_hornet_f7c_mk2": {
            "accelFwd": 10.9, "accelRetro": 3.9, "accelStrafe": 7.5, "accelUp": 7.9, "accelDown": 4.6,
            "accelAbFwd": 16.9, "accelAbRetro": 5.5, "accelAbStrafe": 10.2, "accelAbUp": 10.7, "accelAbDown": 6.2,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "anvl_hornet_f7cm": {
            "accelFwd": 10.9, "accelRetro": 3.9, "accelStrafe": 7.2, "accelUp": 7.9, "accelDown": 4.4,
            "accelAbFwd": 17, "accelAbRetro": 5.4, "accelAbStrafe": 9.8, "accelAbUp": 10.7, "accelAbDown": 6,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
        },
        "ARGO_RAFT": {
            "accelFwd": 4, "accelRetro": 2.1, "accelStrafe": 3, "accelUp": 3, "accelDown": 2,
            "accelAbFwd": 5.6, "accelAbRetro": 3, "accelAbStrafe": 3.9, "accelAbUp": 4.2, "accelAbDown": 2.6,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "CNOU_Nomad": {
            "accelFwd": 10.1, "accelRetro": 3.5, "accelStrafe": 6, "accelUp": 7.7, "accelDown": 4.7,
            "accelAbFwd": 15.7, "accelAbRetro": 4.9, "accelAbStrafe": 7.8, "accelAbUp": 10.1, "accelAbDown": 6.3,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "CRUS_Intrepid": {
            "accelFwd": 12.6, "accelRetro": 3.8, "accelStrafe": 5.7, "accelUp": 6.5, "accelDown": 5.6,
            "accelAbFwd": 17.7, "accelAbRetro": 4.9, "accelAbStrafe": 7.7, "accelAbUp": 8.5, "accelAbDown": 7.8,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "CRUS_Star_Runner": {
            "accelFwd": 6.2, "accelRetro": 3.1, "accelStrafe": 2.6, "accelUp": 3.1, "accelDown": 2.6,
            "accelAbFwd": 10.6, "accelAbRetro": 3.7, "accelAbStrafe": 3.5, "accelAbUp": 4, "accelAbDown": 3.1,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "crus_starlifter_m2": {
            "accelFwd": 4.4, "accelRetro": 1.7, "accelStrafe": 2.1, "accelUp": 2.2, "accelDown": 2.2,
            "accelAbFwd": 6.6, "accelAbRetro": 2.1, "accelAbStrafe": 2.9, "accelAbUp": 2.8, "accelAbDown": 2.6,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "espr_talon": {
            "accelFwd": 13.1, "accelRetro": 4.2, "accelStrafe": 10.2, "accelUp": 10.4, "accelDown": 5.2,
            "accelAbFwd": 20.3, "accelAbRetro": 5.9, "accelAbStrafe": 13.5, "accelAbUp": 13.5, "accelAbDown": 7,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
        },
        "espr_talon_shrike": {
            "accelFwd": 13.5, "accelRetro": 4.4, "accelStrafe": 10.7, "accelUp": 10.7, "accelDown": 5.3,
            "accelAbFwd": 20.9, "accelAbRetro": 6.1, "accelAbStrafe": 14, "accelAbUp": 14, "accelAbDown": 7.2,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_constellation_andromeda": {
            "accelFwd": 5.2, "accelRetro": 2.6, "accelStrafe": 2.6, "accelUp": 3.1, "accelDown": 2.6,
            "accelAbFwd": 7.8, "accelAbRetro": 3.1, "accelAbStrafe": 3.5, "accelAbUp": 4, "accelAbDown": 3.1,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_constellation_phoenix": {
            "accelFwd": 5, "accelRetro": 2.5, "accelStrafe": 2.4, "accelUp": 3, "accelDown": 2.4,
            "accelAbFwd": 7.5, "accelAbRetro": 3, "accelAbStrafe": 3.3, "accelAbUp": 3.9, "accelAbDown": 2.9,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_constellation_taurus": {
            "accelFwd": 5, "accelRetro": 2.5, "accelStrafe": 2.6, "accelUp": 3.2, "accelDown": 2.6,
            "accelAbFwd": 7.5, "accelAbRetro": 3, "accelAbStrafe": 3.5, "accelAbUp": 4.2, "accelAbDown": 3.1,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "RSI_Mantis": {
            "accelFwd": 14.8, "accelRetro": 3.4, "accelStrafe": 4.3, "accelUp": 5.8, "accelDown": 3.4,
            "accelAbFwd": 24.7, "accelAbRetro": 4.5, "accelAbStrafe": 5.9, "accelAbUp": 7.8, "accelAbDown": 4.5,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_zeus_es": {
            "accelFwd": 8.5, "accelRetro": 2.6, "accelStrafe": 3, "accelUp": 3, "accelDown": 2.7,
            "accelAbFwd": 11.1, "accelAbRetro": 3.3, "accelAbStrafe": 4.1, "accelAbUp": 3.9, "accelAbDown": 3.5,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
        },
        "misc_starlancer_max": {
            "accelFwd": 3.2, "accelRetro": 1.8, "accelStrafe": 2, "accelUp": 2.3, "accelDown": 2.3,
            "accelAbFwd": 4.3, "accelAbRetro": 2.5, "accelAbStrafe": 2.6, "accelAbUp": 3.3, "accelAbDown": 3,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "misc_starlancer_tac": {
            "accelFwd": 2.9, "accelRetro": 1.6, "accelStrafe": 1.8, "accelUp": 2.1, "accelDown": 2.1,
            "accelAbFwd": 3.9, "accelAbRetro": 2.3, "accelAbStrafe": 2.4, "accelAbUp": 3, "accelAbDown": 2.8,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "mrai_guardian": {
            "accelFwd": 9.3, "accelRetro": 3.5, "accelStrafe": 7.5, "accelUp": 7.5, "accelDown": 7.5,
            "accelAbFwd": 14, "accelAbRetro": 4.9, "accelAbStrafe": 10.2, "accelAbUp": 9.8, "accelAbDown": 10.6,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "mrai_guardian_mx": {
            "accelFwd": 9.2, "accelRetro": 3.5, "accelStrafe": 6.8, "accelUp": 6.8, "accelDown": 6.8,
            "accelAbFwd": 13.8, "accelAbRetro": 4.9, "accelAbStrafe": 9.2, "accelAbUp": 8.8, "accelAbDown": 9.5,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_apollo_medivac": {
            "accelFwd": 4.2, "accelRetro": 2.4, "accelStrafe": 2.9, "accelUp": 2, "accelDown": 1.9,
            "accelAbFwd": 5.9, "accelAbRetro": 3.4, "accelAbStrafe": 3.8, "accelAbUp": 2.8, "accelAbDown": 2.5,
            "accelTestedDate": "2026-04-04", "accelCheckedBy": "Zimmy",
        },
        "rsi_meteor": {
            "accelFwd": 15.2, "accelRetro": 2.9, "accelStrafe": 4.2, "accelUp": 5.5, "accelDown": 3.2,
            "accelAbFwd": 25.4, "accelAbRetro": 3.8, "accelAbStrafe": 5.7, "accelAbUp": 7.4, "accelAbDown": 4.3,
            "accelTestedDate": "2026-04-03", "accelCheckedBy": "Zimmy",
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
            ship["accelCheckedBy"] = ""

    # 4. Components
    print("\n[4/6] Scanning components…")
    items = scan_components(FORGE_DIR, loc)
    print(f"  Total: {len(items)} components")

    # Module metadata enrichment
    # Rocket pod stat overrides (damage from detonation, not extractable from standard ammo chain)
    # Per-rocket: 150 physical damage, 60 RPM, 700 m/s, 2100m range, 3s lifetime
    _rocket_dmg = {"physical": 150, "energy": 0, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0}
    _rocket_base = {"alphaDamage": 150, "damage": _rocket_dmg, "fireRate": 60, "projectileSpeed": 700, "range": 2100, "isBallistic": True, "dps": 150}
    ROCKET_POD_OVERRIDES = {
        "rpod_s1_hrst_6x_s1":   {**_rocket_base, "ammoCount": 12},
        "rpod_s2_hrst_12x_s1":  {**_rocket_base, "ammoCount": 24},
        "rpod_s3_hrst_18x_s1":  {**_rocket_base, "ammoCount": 36},
        "rpod_s1_fski_3x_s3":   {**_rocket_base, "ammoCount": 6},
        "rpod_s2_fski_6x_s3":   {**_rocket_base, "ammoCount": 12},
        "rpod_s3_fski_9x_s3":   {**_rocket_base, "ammoCount": 18},
        "rpod_s1_thcn_4x_s2":   {**_rocket_base, "ammoCount": 8},
        "rpod_s2_thcn_8x_s2":   {**_rocket_base, "ammoCount": 16},
        "rpod_s3_thcn_12x_s2":  {**_rocket_base, "ammoCount": 24},
    }
    for cls, overrides in ROCKET_POD_OVERRIDES.items():
        if cls in items:
            items[cls].update(overrides)

    # Hornet variant-specific utility mounts (not auto-extracted from forge data)
    # F7C-R Tracker: WillsOp Long Look Radar
    items["umnt_anvl_s5_rotodome"] = {
        "className": "umnt_anvl_s5_rotodome",
        "name": "WillsOp Long Look Radar",
        "manufacturer": "Anvil Aerospace",
        "type": "Module",
        "size": 5,
        "grade": "1",
        "itemTags": ["ANVL_Hornet_Tracker"],
    }
    items["umnt_anvl_s5_rotodome_mk2"] = {
        "className": "umnt_anvl_s5_rotodome_mk2",
        "name": "WillsOp Long Look Radar Mk II",
        "manufacturer": "Anvil Aerospace",
        "type": "Module",
        "size": 5,
        "grade": "1",
        "itemTags": ["ANVL_Hornet_Tracker_Mk2"],
    }
    # F7C-S Ghost: Center Cap (stealth cap)
    items["umnt_anvl_s5_cap"] = {
        "className": "umnt_anvl_s5_cap",
        "name": "Anvil Hornet Ghost Center Cap",
        "manufacturer": "Anvil Aerospace",
        "type": "Module",
        "size": 5,
        "grade": "1",
        "itemTags": ["ANVL_Hornet_Ghost"],
    }
    items["umnt_anvl_s5_cap_mk2"] = {
        "className": "umnt_anvl_s5_cap_mk2",
        "name": "Anvil Hornet Ghost Mk II Center Cap",
        "manufacturer": "Anvil Aerospace",
        "type": "Module",
        "size": 5,
        "grade": "1",
        "itemTags": ["ANVL_Hornet_Ghost_Mk2"],
    }

    # Hornet cargo modules: add 2 SCU cargo capacity
    for cargo_cls in ("anvl_hornet_f7c_cargo_mod", "anvl_hornet_f7c_mk2_cargo_mod"):
        if cargo_cls in items:
            items[cargo_cls]["cargoBonus"] = 2

    # F7C-M Mk II Ball Turret: missile rack is bespoke (locked to Custom-481 with Spark I missiles)
    if "anvl_hornet_f7cm_mk2_ball_turret" in items:
        turret = items["anvl_hornet_f7cm_mk2_ball_turret"]
        for sp in turret.get("subPorts", []):
            if sp["id"] == "hardpoint_missile_rack":
                sp["locked"] = "mrck_s04_anvl_hornet_f7cm_mk2_turret"

    # Add F7C Mk II nose tag to the Mk II S2 Nose Turret item
    if "anvl_hornet_f7c_mk2_nose_turret" in items:
        tags = items["anvl_hornet_f7c_mk2_nose_turret"].setdefault("itemTags", [])
        if "ANVL_Hornet_F7C_Mk2_Nose" not in tags:
            tags.append("ANVL_Hornet_F7C_Mk2_Nose")

    # Beam weapon overrides (damage not extractable from standard ammo chain)
    BEAM_OVERRIDES = {
        "hrst_laserbeam_bespoke": {
            "damage": {"physical": 0, "energy": 15000, "distortion": 0, "thermal": 0, "biochemical": 0, "stun": 0},
            "alphaDamage": 15000, "dps": 15000, "fireRate": 60,
            "penetrationDistance": 29.4, "penetrationMinRadius": 1.47, "penetrationMaxRadius": 2.94,
        },
    }
    for cls, overrides in BEAM_OVERRIDES.items():
        if cls in items:
            items[cls].update(overrides)

    # Name overrides for items with auto-generated names
    NAME_OVERRIDES = {
        "mrck_s10_aegs_idris_nose_s12_torpedo": 'HMF-T12 "Hammerfall" Torpedo Launcher',
        "mrck_s05_rsi_perseus_torpedo_l": "5105 Torpedo Rack",
        "mrck_s05_rsi_perseus_torpedo_r": "5105 Torpedo Rack",
        "qdrv_acas_s01_foxfire_scitem": "FoxFire Quantum Drive",
        "qdrv_acas_s01_lightfire_scitem": "LightFire Quantum Drive",
        "shld_banu_s02_placeholder_scitem": "Sukoran Shield",
        "shld_rsi_s04_polaris_scitem": "Glacis Shield",
        "jdrv_tars_s01_explorer_scitem": "Explorer Jump Module",
        "jdrv_tars_s02_excelsior_scitem": "Excelsior Jump Module",
        "jdrv_tars_s03_exodus_scitem": "Exodus Jump Module",
        "jdrv_tars_s04_c_explorer": "Explorer Jump Module (Capital)",
        "jdrv_aegs_s04_javelin_scitem": "Javelin Jump Module",
        "jdrv_orig_s04_890j_scitem": "890 Jump Module",
        "jdrv_wetk_s04_idris_scitem": "Exfiltrate Jump Module",
        "jdrv_rsi_s04_bengal_scitem": "Bengal Jump Module",
    }
    for cls, name in NAME_OVERRIDES.items():
        if cls in items:
            items[cls]["name"] = name

    # Auto-clean ugly auto-generated names (title-cased classNames with no localization)
    _MFR_MAP = {
        "aegs": "Aegis", "anvl": "Anvil", "rsi": "RSI", "crus": "Crusader", "misc": "MISC",
        "orig": "Origin", "drak": "Drake", "behr": "Behring", "gats": "Gatling Arms",
        "klwe": "Klaus & Werner", "espr": "Esperia", "krig": "Kruger", "cnou": "C.O.",
        "taln": "Talisman", "vncl": "Vanduul", "argo": "ARGO", "mrai": "Mirai",
        "godi": "Godelius", "seco": "Seal Corp", "lplt": "Lightning Power",
        "wlop": "Wei-Tek", "grnp": "Greycat", "tmbl": "Tumbril", "fski": "FIRESTORM",
    }
    _TYPE_MAP = {
        "shld": "Shield", "powr": "Power Plant", "cool": "Cooler", "qdrv": "Quantum Drive",
        "radr": "Radar", "lfsp": "Life Support", "mrck": "Missile Rack",
        "bmbrck": "Bomb Rack", "gmrck": "Gimbal Missile Rack",
    }
    _SIZE_RE = re.compile(r'[_]s0*(\d+)(?:[_]|$)', re.IGNORECASE)

    def _auto_clean_name(cls_name, item):
        """Generate a readable name from className when localization failed."""
        name = item.get("name", "")
        itype = item.get("type", "")

        # Detect auto-generated: starts with type prefix like "Shld " or "Mrck "
        prefix_lower = cls_name.split("_")[0].lower()
        is_ugly = prefix_lower in _TYPE_MAP and name.replace(" ", "_").lower().startswith(prefix_lower)
        if not is_ugly:
            return name  # already localized

        parts = cls_name.lower().split("_")
        # Extract type
        type_label = _TYPE_MAP.get(parts[0], itype)
        # Extract manufacturer
        mfr = ""
        for p in parts[1:]:
            if p in _MFR_MAP:
                mfr = _MFR_MAP[p]
                break
        # Extract size
        size_match = _SIZE_RE.search(cls_name)
        size = f"S{size_match.group(1)}" if size_match else ""
        # Build name
        if mfr and size:
            return f"{mfr} {size} {type_label}"
        elif mfr:
            return f"{mfr} {type_label}"
        elif size:
            return f"{size} {type_label}"
        return name  # give up

    for cls, item in items.items():
        cleaned = _auto_clean_name(cls, item)
        if cleaned != item.get("name"):
            item["name"] = cleaned

    MODULE_META = {
        "rsi_aurora_mk2_module_cargo":              {"cargoBonus": 6},
        "aegs_retaliator_module_front_cargo":       {"cargoBonus": 36},
        "aegs_retaliator_module_rear_cargo":        {"cargoBonus": 36},
    }
    for cls, meta in MODULE_META.items():
        if cls in items:
            items[cls].update(meta)

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

    # 6b. Extract mining location data
    print("\n[6b] Extracting mining locations…")
    mining_locations = extract_mining_locations(FORGE_DIR, DCB_FILE)

    # Ships missing FC hardpoint in vehicle XML but having a flight controller item
    _MISSING_FC_HP = ["ANVL_Paladin"]
    for ship_cls in _MISSING_FC_HP:
        if ship_cls in ships:
            s = ships[ship_cls]
            if not any(hp["type"] == "FlightController" for hp in s.get("hardpoints", [])):
                s["hardpoints"].append({
                    "id": "hardpoint_controller_flight", "label": "Flight Controller",
                    "type": "FlightController", "subtypes": "", "minSize": 1, "maxSize": 1,
                    "flags": "invisible uneditable",
                    "allTypes": [{"type": "FlightController", "subtypes": ""}],
                })
                s.setdefault("defaultLoadout", {})["hardpoint_controller_flight"] = f"controller_flight_{ship_cls.lower()}"

    # Auto-assign default flight controller for ships with FC hardpoints but no default
    fc_assigned = 0
    for ship_cls, ship in ships.items():
        for hp in ship.get("hardpoints", []):
            if hp["type"] != "FlightController":
                continue
            dl = ship.setdefault("defaultLoadout", {})
            hp_key = hp["id"].lower()
            existing = dl.get(hp_key, "")
            if existing and existing in items:
                break
            # Try matching controller by ship className with progressive prefix shortening
            ship_lower = ship_cls.lower()
            parts = ship_lower.split("_")
            matched = None
            for end in range(len(parts), 1, -1):
                prefix = "_".join(parts[:end])
                candidate = f"controller_flight_{prefix}"
                if candidate in items and items[candidate].get("type") == "FlightController":
                    matched = candidate
                    break
            if matched:
                dl[hp_key] = matched
                fc_assigned += 1
            break
    print(f"  Auto-assigned {fc_assigned} flight controller defaults")

    # 7. Write output
    print("\n[7/7] Writing output…")
    # Strip internal-only temp fields before serializing
    for item in items.values():
        item.pop("_damageInfoIdx", None)
        item.pop("_miningModRefs", None)
        item.pop("_miningDpsRef", None)
    # Display-name overrides (localization corrections)
    DISPLAY_NAME_FIXES = {
        "Havoc Scattergun Sharkmouth Edition": "Havoc Sharkmouth Edition",
        "Hellion Scattergun Sharkmouth Edition": "Hellion Sharkmouth Edition",
        "Predator Scattergun Sharkmouth Edition": "Predator Sharkmouth Edition",
    }
    for item in items.values():
        if item.get("name") in DISPLAY_NAME_FIXES:
            item["name"] = DISPLAY_NAME_FIXES[item["name"]]
    SKIP_SHIPS = {
        "AEGS_Idris_FW_25", "RSI_Bengal",               # capitals — no usable loadout data
        "aegs_idris_m_pu",                               # NPC PU variant of Idris-M
        "ANVL_Hornet_F7A_MK1",                           # NPC F7A variant (no loadout)
        "EA_destructable_probe", "Low_Poly_Ship",        # not real ships
        "probe_turret_1_a", "probe_comms_1_a",           # probes / turret entities
    }
    # Deduplicate ships that differ only by className casing (keep the one with a loadout)
    seen_names = {}
    for cls, ship in list(ships.items()):
        name = ship.get("name", "")
        if name in seen_names:
            prev_cls = seen_names[name]
            prev_has = bool(ships[prev_cls].get("defaultLoadout"))
            curr_has = bool(ship.get("defaultLoadout"))
            if curr_has and not prev_has:
                del ships[prev_cls]
                seen_names[name] = cls
            else:
                del ships[cls]
        else:
            seen_names[name] = cls
    ship_list = [s for s in ships.values() if s["className"] not in SKIP_SHIPS]

    # ── Deduplicate ship-specific gimbal mounts ──────────────────────────────
    # Many ships have their own gimbal variant (e.g., mount_gimbal_s3_perseus)
    # that is functionally identical to the canonical (mount_gimbal_s3).
    # Remap defaultLoadout references to the canonical and drop the dupes.
    GIMBAL_REMAP = {
        "mount_gimbal_s2_vncl_blade":              "mount_gimbal_s2",
        "mount_gimbal_s2_vng_s2":                  "mount_gimbal_s2",
        "mount_gimbal_s3_perseus":                 "mount_gimbal_s3",
        "mount_gimbal_s3_perseus_bottom":          "mount_gimbal_s3",
        "mount_gimbal_s3_perseus_bottom_left":     "mount_gimbal_s3",
        "mount_gimbal_s3_perseus_right":           "mount_gimbal_s3",
        "mount_gimbal_s3_polaris":                 "mount_gimbal_s3",
        "mount_gimbal_s3_vncl_blade":              "mount_gimbal_s3",
        "mount_gimbal_s4_crus_intrepid":           "mount_gimbal_s4",
        "mount_gimbal_s4_paladin_turret":          "mount_gimbal_s4",
        "mount_gimbal_s4_polaris":                 "mount_gimbal_s4",
        "mount_gimbal_s4_vncl_stinger":            "mount_gimbal_s4",
        "mount_gimbal_s5_rsi_meteor":              "mount_gimbal_s5_invsi",
        "mount_gimbal_s6_polaris":                 "mount_gimbal_s6",
        "mount_gimbal_s6_polaris_right":           "mount_gimbal_s6",
        "mount_gimbal_s8_perseus_bottom":          "mount_gimbal_s8_perseus",
    }
    for ship in ship_list:
        dl = ship.get("defaultLoadout", {})
        for key, val in list(dl.items()):
            if val in GIMBAL_REMAP:
                dl[key] = GIMBAL_REMAP[val]
    for dupe_cls in GIMBAL_REMAP:
        items.pop(dupe_cls, None)
    print(f"  Deduplicated {len(GIMBAL_REMAP)} ship-specific gimbal variants")

    # ── Tag-lock bespoke ship turrets/mounts ────────────────────────────────
    # Items with itemTags are filtered to only show on hardpoints with matching
    # portTags. Add tags to bespoke items that are missing them.
    BESPOKE_ITEM_TAGS = {
        "drak_dual_s1":                 "$DRAK_Caterpillar_Turret",
        "drak_dual_s3":                 "$DRAK_Caterpillar_Turret",
        "anvl_terrapin_nose_turret_s3": "$ANVL_Terrapin_Nose",
        "cnou_mustang_nose_turret_s3":  "$CNOU_Mustang_Nose",
        "anvl_arrow_turret":            "$ANVL_Arrow_Nose",
        "anvl_lightning_f8c_turret_s3": "$ANVL_Lightning_F8C",
    }
    for item_cls, tag in BESPOKE_ITEM_TAGS.items():
        if item_cls in items:
            tags = items[item_cls].setdefault("itemTags", [])
            if tag not in tags:
                tags.append(tag)

    # Add matching portTags to the ships that use these bespoke items
    BESPOKE_SHIP_PORTS = {
        ("drak_caterpillar", "drak_caterpillar_pirate"): {
            ("hardpoint_weapon_left", "hardpoint_weapon_right", "hardpoint_weapon_top"):
                "$DRAK_Caterpillar_Turret",
        },
        ("anvl_terrapin", "anvl_terrapin_medic"): {
            ("hardpoint_weapon_nose",): "$ANVL_Terrapin_Nose",
        },
        ("cnou_mustang_alpha", "cnou_mustang_beta", "cnou_mustang_delta", "cnou_mustang_gamma", "cnou_mustang_omega"): {
            ("hardpoint_weapon_nose",): "$CNOU_Mustang_Nose",
        },
        ("ANVL_Arrow",): {
            ("hardpoint_weapon_nose",): "$ANVL_Arrow_Nose",
        },
        ("anvl_lightning_f8c",): {
            ("hardpoint_weapon_nose",): "$ANVL_Lightning_F8C",
        },
    }
    for ship in ship_list:
        cls_lower = ship["className"].lower()
        for ship_group, port_map in BESPOKE_SHIP_PORTS.items():
            if cls_lower in {s.lower() for s in ship_group}:
                for hp_ids, tag in port_map.items():
                    for hp in ship.get("hardpoints", []):
                        if hp["id"].lower() in {h.lower() for h in hp_ids}:
                            hp["portTags"] = tag

    item_list = list(items.values())

    def count_type(t):
        return sum(1 for i in item_list if i.get("type") == t)

    dps_count = sum(1 for i in item_list if i.get("dps", 0) > 0)

    # ── Post-extraction integrity checks ─────────────────────────────────
    # Hard assertions for data that has been accidentally lost before.
    # If ANY check fails the extractor refuses to write output.
    # Add new entries whenever a fragile data point is fixed so it can
    # never silently regress again.

    def _find_ship(cls):
        return next((s for s in ship_list if s["className"] == cls), None)

    def _find_item(cls):
        return next((i for i in item_list if i["className"] == cls), None)

    def _ship_has_hp(cls, hp_id):
        s = _find_ship(cls)
        return s and any(h["id"] == hp_id for h in s.get("hardpoints", []))

    def _ship_lacks_hp(cls, hp_id):
        s = _find_ship(cls)
        return s and not any(h["id"] == hp_id for h in s.get("hardpoints", []))

    def _item_has_subport(cls, sp_id):
        i = _find_item(cls)
        return i and any(sp["id"] == sp_id for sp in i.get("subPorts", []))

    def _ship_hp_count(cls, id_fragment):
        s = _find_ship(cls)
        if not s: return -1
        return sum(1 for h in s.get("hardpoints", []) if id_fragment in h["id"])

    INTEGRITY_CHECKS = [
        # Aurora Mk II: DM module shield lives on the MODULE, not the ship
        ("Aurora DM shield on module",
         lambda: _item_has_subport("rsi_aurora_mk2_module_missile", "hardpoint_shield_generator_back")),
        ("Aurora ship has exactly 2 shields",
         lambda: _ship_hp_count("rsi_aurora_mk2", "shield_generator") == 2),

        # Hercules: C2/M2 must NOT have A2-only hardpoints
        ("C2 lacks bridge turret",
         lambda: _ship_lacks_hp("crus_starlifter_c2", "hardpoint_bridge_remote_turret")),
        ("C2 lacks forward turrets",
         lambda: _ship_lacks_hp("crus_starlifter_c2", "hardpoint_forward_left_remote_turret")),
        ("C2 has exactly 2 shields",
         lambda: _ship_hp_count("crus_starlifter_c2", "shield_generator") == 2),
        ("M2 lacks bridge turret",
         lambda: _ship_lacks_hp("crus_starlifter_m2", "hardpoint_bridge_remote_turret")),
        ("M2 lacks forward turrets",
         lambda: _ship_lacks_hp("crus_starlifter_m2", "hardpoint_forward_left_remote_turret")),
        ("M2 has exactly 2 shields",
         lambda: _ship_hp_count("crus_starlifter_m2", "shield_generator") == 2),
        ("A2 has exactly 3 shields",
         lambda: _ship_hp_count("crus_starlifter_a2", "shield_generator") == 3),
    ]

    integrity_failures = []
    for label, check in INTEGRITY_CHECKS:
        try:
            if not check():
                integrity_failures.append(label)
        except Exception as e:
            integrity_failures.append(f"{label} (error: {e})")

    if integrity_failures:
        print("\n" + "=" * 60)
        print("  INTEGRITY CHECK FAILED — output NOT written")
        print("=" * 60)
        for f in integrity_failures:
            print(f"  ✗ {f}")
        print("\nFix the above before re-running. These checks exist because")
        print("this data has been accidentally lost in previous extractions.")
        print("=" * 60)
        sys.exit(1)
    else:
        print(f"\n  Integrity checks passed: {len(INTEGRITY_CHECKS)}/{len(INTEGRITY_CHECKS)}")

    output = {
        "meta": {
            "game":          f"Star Citizen {DATA_MODE.upper()}",
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
            "miningLocations": len(mining_locations.get("locations", [])),
        },
        "ships": ship_list,
        "items": item_list,
        "miningLocations": mining_locations.get("locations", []),
        "miningElements": mining_locations.get("elements", []),
    }

    # ── Generate changelog by diffing against previous extraction ──────────────
    CHANGELOG_FILE = Path(__file__).parent / "versedb_changelog.json"
    CHANGELOG_APP  = APP_DATA_DIR / "versedb_changelog.json"

    TRACKED_FIELDS = {
        "ship": ["mass", "hp", "cargoCapacity", "weaponPowerPoolSize", "thrusterPowerBars",
                 "armorPhysical", "armorEnergy", "armorDistortion", "armorThermal"],
        "WeaponGun": ["dps", "alphaDamage", "fireRate", "projectileSpeed", "range",
                      "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
                      "maxRegenPerSec", "powerDraw"],
        "WeaponTachyon": ["dps", "alphaDamage", "fireRate", "projectileSpeed", "range",
                          "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
                          "maxRegenPerSec", "powerDraw"],
        "TractorBeam": ["dps", "alphaDamage", "fireRate", "powerDraw"],
        "Shield": ["hp", "regenRate", "damagedRegenDelay", "downedRegenDelay",
                   "resistPhysMax", "resistPhysMin", "resistEnrgMax", "resistEnrgMin",
                   "resistDistMax", "resistDistMin"],
        "PowerPlant": ["powerOutput"],
        "Cooler": ["coolingRate"],
        "QuantumDrive": ["speed", "spoolTime", "fuelRate"],
        "Radar": ["aimMin", "aimMax"],
        "MissileLauncher": ["missileSize", "capacity"],
        "Missile": ["alphaDamage", "speed", "lockTime", "lockRangeMax"],
    }

    def _category_for(item):
        t = item.get("type", "")
        if t in ("WeaponGun", "WeaponTachyon"): return "weapon"
        if t == "TractorBeam": return "tractor"
        if t == "Shield": return "shield"
        if t == "PowerPlant": return "powerplant"
        if t == "Cooler": return "cooler"
        if t == "QuantumDrive": return "quantumdrive"
        if t == "Radar": return "radar"
        if t in ("MissileLauncher", "BombLauncher"): return "missilelauncher"
        if t == "Missile": return "missile"
        return t.lower()

    def _diff_entities(old_map, new_map, tracked, is_ship=False):
        changes, added, removed = [], [], []
        cat = "ship" if is_ship else None
        all_keys = set(old_map) | set(new_map)
        for key in sorted(all_keys):
            old_e = old_map.get(key)
            new_e = new_map.get(key)
            if not old_e and new_e:
                c = cat or _category_for(new_e)
                added.append({"category": c, "className": key, "name": new_e.get("name", key)})
                continue
            if old_e and not new_e:
                c = cat or _category_for(old_e)
                removed.append({"category": c, "className": key, "name": old_e.get("name", key)})
                continue
            etype = "ship" if is_ship else new_e.get("type", "")
            fields_to_check = tracked.get(etype, [])
            field_diffs = []
            for f in fields_to_check:
                ov = old_e.get(f)
                nv = new_e.get(f)
                if ov is None and nv is None: continue
                if ov != nv:
                    field_diffs.append({"field": f, "old": ov, "new": nv})
            if field_diffs:
                c = cat or _category_for(new_e)
                changes.append({
                    "category": c,
                    "className": key,
                    "name": new_e.get("name", key),
                    "fields": field_diffs,
                })
        return changes, added, removed

    if OUTPUT_FILE.exists():
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                prev = json.load(f)
            prev_version = prev.get("meta", {}).get("version", "unknown")
            new_version = output["meta"]["version"]

            if prev_version != new_version:
                prev_ships = {s["className"]: s for s in prev.get("ships", [])}
                new_ships = {s["className"]: s for s in ship_list}
                prev_items = {i["className"]: i for i in prev.get("items", [])}
                new_items = {i["className"]: i for i in item_list}

                ship_changes, ship_added, ship_removed = _diff_entities(prev_ships, new_ships, TRACKED_FIELDS, is_ship=True)
                item_changes, item_added, item_removed = _diff_entities(prev_items, new_items, TRACKED_FIELDS, is_ship=False)

                all_changes = ship_changes + item_changes
                all_added = ship_added + item_added
                all_removed = ship_removed + item_removed

                if all_changes or all_added or all_removed:
                    from datetime import datetime, timezone
                    entry = {
                        "fromVersion": prev_version,
                        "toVersion": new_version,
                        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        "changes": all_changes,
                        "added": all_added,
                        "removed": all_removed,
                    }

                    # Load existing changelog or start fresh
                    changelog = {"meta": {"generatedAt": "", "entries": 0}, "changelog": []}
                    if CHANGELOG_FILE.exists():
                        try:
                            with open(CHANGELOG_FILE, "r", encoding="utf-8") as f:
                                changelog = json.load(f)
                        except Exception:
                            pass

                    # Don't add duplicate entries for the same version pair
                    existing = [(e["fromVersion"], e["toVersion"]) for e in changelog["changelog"]]
                    if (prev_version, new_version) not in existing:
                        changelog["changelog"].insert(0, entry)  # newest first
                        changelog["meta"]["generatedAt"] = datetime.now(timezone.utc).isoformat()
                        changelog["meta"]["entries"] = len(changelog["changelog"])

                        with open(CHANGELOG_FILE, "w", encoding="utf-8") as f:
                            json.dump(changelog, f, indent=2, ensure_ascii=False)
                        CHANGELOG_APP.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(CHANGELOG_FILE, CHANGELOG_APP)

                        print(f"\n[CHANGELOG] {prev_version} → {new_version}")
                        print(f"  Changes: {len(all_changes)}, Added: {len(all_added)}, Removed: {len(all_removed)}")
                    else:
                        print(f"\n[CHANGELOG] Entry already exists for {prev_version} → {new_version}, skipped")
                else:
                    print(f"\n[CHANGELOG] No tracked field changes between {prev_version} and {new_version}")
            else:
                print(f"\n[CHANGELOG] Same version ({new_version}), no diff generated")
        except Exception as e:
            print(f"\n[CHANGELOG] Error generating changelog: {e}")
    else:
        print(f"\n[CHANGELOG] No previous extraction found, changelog generation skipped")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    # Auto-copy to app/public/<live|ptu>/
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OUTPUT_FILE, APP_DATA_DIR / "versedb_data.json")

    size_mb = OUTPUT_FILE.stat().st_size / 1_048_576
    m = output["meta"]
    print(f"\n{'=' * 60}")
    print(f"Done!  {OUTPUT_FILE}")
    print(f"  Copied to {APP_DATA_DIR / 'versedb_data.json'}")
    print(f"  Size:          {size_mb:.1f} MB")
    print(f"  Ships:         {m['shipCount']}")
    print(f"  Weapons:       {m['weapons']} ({m['weaponsWithDPS']} with DPS)")
    print(f"  Shields:       {m['shields']}")
    print(f"  Power Plants:  {m['powerPlants']}")
    print(f"  Coolers:       {m['coolers']}")
    print(f"  Quantum Drives:{m['quantumDrives']}")

    # 8. Missions & Contracts (separate extraction)
    print("\n[8/10] Extracting missions & contracts…")
    import subprocess
    sub_env = {**os.environ, "VERSEDB_DATA_MODE": DATA_MODE}
    mission_script = Path(__file__).parent / "versedb_missions.py"
    if mission_script.exists():
        result = subprocess.run([sys.executable, str(mission_script)], capture_output=True, text=True, env=sub_env)
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
    print("\n[9/10] Extracting crafting recipes…")
    crafting_script = Path(__file__).parent / "crafting_extract.py"
    if crafting_script.exists():
        result = subprocess.run([sys.executable, str(crafting_script)], capture_output=True, text=True, env=sub_env)
        for line in result.stdout.splitlines():
            if any(kw in line for kw in ['Extracted', 'Unique', 'Saved', 'Copied']):
                print(f"  {line.strip()}")
        if result.returncode != 0:
            print(f"  WARNING: Crafting extraction failed")
            if result.stderr:
                print(f"  {result.stderr[:200]}")
    else:
        print(f"  WARNING: {crafting_script} not found — skipping crafting extraction")

    # Shop prices were previously fetched here (step [10/10]) and embedded
    # into each ship/item's JSONB row. Removed: the canonical source is now
    # the standalone `shop_prices` table managed by the admin "Refresh UEX
    # Prices" button, and the API's exportFullDb (api/db.js) joins from
    # that table at serve time so the frontend payload shape is unchanged.
    # Embedding shopPrices in the extractor produced a large diff-noise
    # surface on every admin import (49/199 ships didn't match UEX in any
    # given run, so the diff would propose to overwrite the cached snapshot
    # with empty). The standalone-table architecture solves this cleanly.
    #
    # versedb_shop_scrape.py is preserved for manual use if needed.

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="VerseDB Extractor — Star Citizen Data Pipeline")
    parser.add_argument("--mode", choices=["live", "ptu", "both"], default="both",
                        help="Which build to extract: live, ptu, or both (default: both)")
    parser.add_argument("--reextract", action="store_true",
                        help="Force re-extraction from p4k even if intermediate dirs exist")
    args = parser.parse_args()

    modes = ["live", "ptu"] if args.mode == "both" else [args.mode]
    for m in modes:
        if args.reextract:
            # Remove intermediate dirs to force fresh extraction
            for suffix in (f"sc_data_xml_{m}", f"sc_data_{m}", f"sc_data_forge_{m}"):
                d = _SC / suffix
                if d.exists():
                    shutil.rmtree(d)
                    print(f"  Cleared {d}")
        main(m)
        if len(modes) > 1:
            print("\n" + "─" * 60 + "\n")

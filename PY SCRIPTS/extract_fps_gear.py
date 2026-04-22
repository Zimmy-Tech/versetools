"""
extract_fps_gear.py
===================
Extracts non-weapon, non-armor FPS loadout items from the forged DCB records
and writes versedb_fps_gear.json. Covers: tools (medgun, tractor, multitool +
heads), consumables (medpens, oxy, keycards), deployables (trip mines, timed
explosives), melee weapons (knives), mines, and ship-side FPS gadgets.

Grenades live with the weapons extractor. Clothing is skipped.

Usage:
  python3 extract_fps_gear.py [--target live|ptu]

Reads:
  SC FILES/sc_data_forge_{mode}/libs/foundry/records/entities/scitem/
  SC FILES/sc_data_xml_{mode}/Data/Localization/english/global.ini

Writes:
  app/public/{mode}/versedb_fps_gear.json
"""

import argparse
import json
import re
from pathlib import Path

_parser = argparse.ArgumentParser(description="Extract FPS gear data")
_parser.add_argument("--target", choices=["live", "ptu"], default="live")
_args = _parser.parse_args()
_MODE = _args.target

_BASE = Path(__file__).resolve().parent.parent
_SC   = _BASE / "SC FILES"

FORGE = _SC / f"sc_data_forge_{_MODE}" / "libs" / "foundry" / "records" / "entities" / "scitem"
GLOBAL_INI = _SC / f"sc_data_xml_{_MODE}" / "Data" / "Localization" / "english" / "global.ini"

if not FORGE.exists():
    FORGE = _SC / "sc_data_forge" / "libs" / "foundry" / "records" / "entities" / "scitem"
if not GLOBAL_INI.exists():
    GLOBAL_INI = _SC / "sc_data_xml_live" / "Data" / "Localization" / "english" / "global.ini"

OUT_FILE = _BASE / "app" / "public" / _MODE / "versedb_fps_gear.json"

# Manual display-name overrides for items whose in-game loc entry is
# @LOC_PLACEHOLDER (CIG hasn't localized them yet) but that players can
# legitimately encounter in the world. Tighten or expand as the game catches up.
MANUAL_NAMES: dict[str, str] = {
    "orbgn_none_consumable_keycard":                 "Orbital Keycard",
    "orbgn_none_consumable_keycard_security":        "Orbital Security Keycard",
    "orbgn_none_consumable_keycard_maintenance":     "Orbital Maintenance Keycard",
    "orbgn_none_consumable_keycard_orbitalaccess":   "Orbital Access Keycard",
    "orbgn_none_consumable_keycard_orbitalsecurity": "Orbital High-Security Keycard",
    "rclmr_consumable_hackingchip_01":               "Reclaimer Hacking Chip",
    "behr_ltp_01":                                   "Behring LTP Device",
    "behr_ltp_01_primed":                            "Behring LTP (Primed)",
    "behr_ltp_01_primed_5m":                         "Behring LTP (Primed, 5m)",
    "behr_ltp_01_primed_sweeping":                   "Behring LTP (Primed, Sweeping)",
    "behr_timed_explosive_01":                       "Behring Timed Explosive",
    "behr_prx_kinetic_01":                           "Behring Proximity Mine",
    "none_melee_01":                                 "Combat Knife",
    # SLAM is a real in-game drug stored under a different loc-key pattern
    # (items_commodities_slam → "SLAM"). 01/02 match the Medical Pen convention
    # of base + Xtra variant (see AdrenaPen/AdrenaPen Xtra, etc.).
    "none_consumable_slam_01":                       "SLAM",
    "none_consumable_slam_02":                       "SLAM Xtra",
    # Crusader "emergency medicate-all" — player-facing name unknown; this is
    # a best-guess pending CIG localization. The XML only references the
    # generic @medbed_heal action label.
    "crlf_consumable_ea_medicateall_01":             "Emergency MedPack",
}

# ClassName prefixes/stems to exclude from the FPS gear list entirely.
SKIP_STEMS = (
    "fps_device_test_",       # dev-only
)
# Full-match excludes for one-offs.
SKIP_EXACT = {
    "behr_ltp_kinetic_01_miningbase",
    "rkhm_dply_shield_01_miningbase",
}

MANUFACTURER_MAP = {
    "behr": "Behring", "gmni": "Gemini", "ksar": "Kastak Arms",
    "klwe": "Klaus & Werner", "volt": "Voltaire", "lbco": "Lightning Bolt Co.",
    "grin": "Greycat Industrial", "crlf": "Crusader", "kegr": "Klaus & Werner",
    "apar": "Apocalypse Arms", "none": "Unknown", "hdgw": "Hedgeway",
    "sasu": "Sakura Sun", "yorm": "Yormandi", "glsn": "Gallenson",
    "banu": "Banu", "rrs": "RRS", "utfl": "UTFL", "rclmr": "Reclaimer",
    "orbgn": "Orbital", "shin": "Shubin Interstellar", "thcn": "Thermyte Concern",
}

# AttachDef (Type, SubType) → display category. Items whose combo isn't here
# are dropped. We're intentionally narrow so we don't pull in cargo boxes,
# food/drink, mobiglas props, etc.
CATEGORY_MAP = {
    # Consumables
    ("FPS_Consumable", "Medical"):   "Consumable / Medical",
    ("FPS_Consumable", "MedPack"):   "Consumable / MedPack",
    ("FPS_Consumable", "OxygenCap"): "Consumable / Oxygen",
    ("FPS_Consumable", "Hacking"):   "Consumable / Hacking",
    # Deployables
    ("FPS_Deployable", "Small"):     "Deployable",
    ("FPS_Deployable", "Medium"):    "Deployable",
    # Tripwire & proximity mines use mixed AttachDef types
    ("Grenade", "Small"):            "Mine / Trip",
    # Tools & gadgets that parse as WeaponPersonal/Gadget/etc — handled below
    # by directory instead.
}

# Stems we want even if their AttachDef wouldn't normally match (tools in
# fps_weapons dir). Value becomes the category.
FPS_WEAPONS_TOOL_STEMS = {
    "crlf_medgun_01":              "Tool / Medical",
    # ParaMed mission-reward variants — rwd01/03 use the standard Hemozal
    # subtype so they're stat-equivalent to base; rwd02 (AA Support) loads
    # a different healing subtype (18603d6d) → distinct HP/sec once the
    # DCB subtype table is extracted.
    "crlf_medgun_01_msn_rwd01":    "Tool / Medical",
    "crlf_medgun_01_msn_rwd02":    "Tool / Medical",
    "crlf_medgun_01_msn_rwd03":    "Tool / Medical",
    "grin_tractor_01":             "Tool / Tractor Beam",
    "grin_multitool_01":           "Tool / Multi-Tool",
}

# Multi-tool head overrides — these get moved out of the generic
# "Multi-Tool Head — *" bucket into their proper functional category
# and given their in-game attachment names.
MULTITOOL_HEAD_CATEGORY_OVERRIDES: dict[str, tuple[str, str]] = {
    # className → (category, display_name)
    "grin_multitool_01_default_healing": ("Tool / Medical", "LifeGuard Attachment"),
}

# Which items carry an actual healing beam worth extracting medGunSpec from.
# Every multitool head XML technically contains the heal-beam action (the
# base multitool defines it), but only these items actually USE it — so
# only these get the spec emitted to avoid "9 copies of the same Multi-Tool"
# in the output.
HEALING_TOOLS = {
    "crlf_medgun_01",                      # ParaMed (base)
    "crlf_medgun_01_msn_rwd01",            # ParaMed "AA Transport"
    "crlf_medgun_01_msn_rwd02",            # ParaMed "AA Support" — unique drug
    "crlf_medgun_01_msn_rwd03",            # ParaMed "AA Defense"
    "grin_multitool_01_default_healing",   # LifeGuard Attachment
}

# Multitool attachment heads — loadout cares about these as swappable modules.
MULTITOOL_HEAD_PREFIX = "grin_multitool_01_default_"

# Skin/variant skip regex (same as weapons extractor)
SKIP_VARIANT_RE = re.compile(
    r'_(?:tint|mat|black|green|tan|luminalia|xenothreat|yellow|store|'
    r'contestedzone|300|firerats|collector|cen\d|imp\d|shin\d|blue|pink|red|white|'
    r'orange|grey|chrome|gold|silver|purple|arctic|urban|engraved|chromic|'
    r'acid|sunset|lumi|uee|camo|headhunters|spc|tow|reward|msn_rwd|prop|'
    r'ea_elim|brown|digi|iae\d{4}|cc\d{2}|optic_|concierge)'
)

# Template / placeholder file suffixes
TEMPLATE_RE = re.compile(r'(_template(_\w+)?|_placeholder|_ai|_nocarry(_\d+m)?|_test|_test_\w+)$')


def load_localization(ini_path: Path) -> dict:
    """Loader that strips grammatical suffixes (,P / ,F / ,M) from keys."""
    loc = {}
    if not ini_path.exists():
        print(f"  WARNING: localization missing: {ini_path}")
        return loc
    with open(ini_path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith(("#", ";")):
                k, _, v = line.partition("=")
                k = k.strip().lower()
                base = re.sub(r",\w$", "", k)
                if base not in loc:
                    loc[base] = v.strip()
    return loc


def safe_float(v, default=0.0):
    try: return float(v)
    except (TypeError, ValueError): return default


def get_manufacturer(stem: str) -> str:
    # Most items use `<mfr>_<rest>` — but `mining_gadget_<mfr>_<name>` inverts
    # that, putting the category first. Special-case so the correct mfr
    # token is chosen instead of returning "mining".
    parts = stem.split("_")
    pfx = parts[0].lower()
    if pfx == "mining" and len(parts) >= 3:
        pfx = parts[2].lower()
    return MANUFACTURER_MAP.get(pfx, pfx.upper())


def parse_entity(xml_path: Path, loc: dict) -> dict | None:
    """Parse a single entity XML and return a gear record or None."""
    try:
        xml = xml_path.read_text(errors="replace")
    except Exception:
        return None

    stem = xml_path.stem.replace(".xml", "").lower()
    if stem.startswith("entityclassdefinition."):
        stem = stem.split(".", 1)[1]

    # AttachDef
    m = re.search(r'<AttachDef\s+([^>]+?)>', xml)
    attrs = m.group(1) if m else ""
    def _attr(name):
        mm = re.search(rf'(?<![A-Za-z]){name}="([^"]*)"', attrs)
        return mm.group(1) if mm else ""
    attach_type = _attr("Type")
    sub_type    = _attr("SubType")
    try: size = int(_attr("Size") or 0)
    except ValueError: size = 0

    # Loc key — use the explicit Name attr when present, fall back to stem.
    # Accept any `@item_*` key (not just @item_name*) so items like mining
    # gadgets, which localize as `@item_Mining_Gadget_GadgetN`, resolve.
    m_name = re.search(r'Name="(@item_[^"]+)"', xml)
    loc_key = m_name.group(1).lstrip("@").lower() if m_name else f"item_name{stem}"
    display_name = loc.get(loc_key, "")

    # Description loc key — used to parse stat lines out of the shipped
    # in-game description (authoritative, CIG-curated values).
    m_desc = re.search(r'Description="(@item_[^"]+)"', xml)
    desc_key = m_desc.group(1).lstrip("@").lower() if m_desc else ""
    description_text = loc.get(desc_key, "") if desc_key else ""

    # Mass
    mass = 0.0
    m_mass = re.search(r'<SEntityRigidPhysicsControllerParams[^>]*Mass="([^"]+)"', xml)
    if m_mass:
        mass = safe_float(m_mass.group(1))

    return {
        "className": stem,
        "name": display_name,
        "manufacturer": get_manufacturer(stem),
        "attachType": attach_type,
        "subType": sub_type,
        "size": size,
        "mass": round(mass, 4),
        "_desc": description_text,
        "_xml": xml,
    }


def is_skip(stem: str) -> bool:
    if SKIP_VARIANT_RE.search(stem): return True
    if TEMPLATE_RE.search(stem):     return True
    return False


# Mining-gadget stat labels → normalized field names. Loc Desc uses human
# labels like "Laser Instability" / "Instability" — both map to the same
# instabilityPct field. Values are signed percentages (e.g. -70 means -70%).
_MINING_DESC_FIELDS: list[tuple[str, str]] = [
    ("instabilityPct",   r"(?:Laser\s+)?Instability"),
    ("resistancePct",    r"Resistance"),
    ("clusterFactorPct", r"Cluster\s+Modifier"),
    ("windowSizePct",    r"Optimal\s+Charge\s+Window\s+Size"),
    ("windowRatePct",    r"Optimal\s+Charge\s+Window\s+Rate"),
]


def parse_mining_spec(desc: str) -> dict:
    """Pull signed-percent modifier lines out of a mining gadget's loc Desc.
    These are CIG-shipped display values and should agree with the DCB FMM
    pool. Returns a dict with any fields present — missing lines stay absent."""
    if not desc:
        return {}
    out: dict = {}
    for field, label in _MINING_DESC_FIELDS:
        m = re.search(rf"{label}:\s*([+-]?\d+(?:\.\d+)?)%", desc, re.IGNORECASE)
        if m:
            out[field] = safe_float(m.group(1))
    return out


def parse_melee_spec(desc: str) -> dict:
    """Pull blade-size from the knife loc Desc (e.g. 'Size: 15 cm').
    Damage numbers are DCB-only — covered by a separate TODO."""
    if not desc: return {}
    m = re.search(r"Size:\s*(\d+(?:\.\d+)?)\s*cm", desc, re.IGNORECASE)
    return {"bladeSizeCm": safe_float(m.group(1))} if m else {}


def parse_throwable_spec(xml: str, desc: str) -> dict:
    """Extract trigger, timing, and explosion params for grenades / mines /
    deployables. Reads the inline polymorphic struct data published in the
    newer forge export — damage numbers and radii are directly available
    (earlier DCB-ref format is not supported here)."""
    out: dict = {}

    # Trigger type — the new format is a child polymorphic tag
    # (e.g. <SSensorMineProximityTrigger>), not an attribute ref.
    m_trig_new = re.search(r'<SSensorMine(Proximity|Laser|\w+)Trigger\b', xml)
    if m_trig_new:
        out["triggerType"] = m_trig_new.group(1)

    # Proximity / laser trigger geometry (inline attrs on the trigger tag).
    m_prox = re.search(r'<SSensorMineProximityTrigger\s+([^>]+)', xml)
    if m_prox:
        attrs = m_prox.group(1)
        r = re.search(r'Radius="([^"]+)"', attrs)
        wr = re.search(r'WarningRadius="([^"]+)"', attrs)
        if r:  out["triggerRadiusM"] = safe_float(r.group(1))
        if wr: out["warningRadiusM"] = safe_float(wr.group(1))
    m_laser_mine = re.search(r'<SSensorMineLaserTrigger\s+([^>]+)', xml)
    if m_laser_mine:
        attrs = m_laser_mine.group(1)
        ll = re.search(r'LaserLength="([^"]+)"', attrs)
        if ll: out["laserLengthM"] = safe_float(ll.group(1))

    # Primary explosion — pick the one named "Explosion". Some items publish
    # a secondary (e.g. frag's cluster sub-blast, LTP "MineDestroyed")
    # which we skip to avoid misleading numbers. explosionParams is a child
    # tag of STriggerableDevicesBehaviorExplosionParams in the new format.
    explosion_block = None
    for m in re.finditer(
        r'<STriggerableDevicesBehaviorExplosionParams\s+name="([^"]*)"[^>]*>(.*?)</STriggerableDevicesBehaviorExplosionParams>',
        xml,
        re.DOTALL,
    ):
        name = m.group(1)
        if name in ("Explosion", "") and explosion_block is None:
            explosion_block = m.group(2)
            break
    if explosion_block is None:
        # Fall back to first ExplosionParams found anywhere.
        m_ep = re.search(r'<explosionParams\s+([^>]+)', xml)
        if m_ep:
            explosion_block = m.group(0)

    if explosion_block:
        m_ep = re.search(r'<explosionParams\s+([^>]+?)(?:/>|>)', explosion_block)
        if m_ep:
            ea = m_ep.group(1)
            for k, field in (("minRadius", "minRadiusM"),
                             ("maxRadius", "maxRadiusM"),
                             ("soundRadius", "soundRadiusM")):
                mm = re.search(rf'{k}="([^"]+)"', ea)
                if mm: out[field] = safe_float(mm.group(1))

        # Damage (first DamageInfo within the primary explosion block).
        m_di = re.search(r'<DamageInfo\s+([^>]+)', explosion_block)
        if m_di:
            a = m_di.group(1)
            dmg = {}
            for k, short in (("DamagePhysical", "physical"),
                             ("DamageEnergy", "energy"),
                             ("DamageDistortion", "distortion"),
                             ("DamageThermal", "thermal"),
                             ("DamageBiochemical", "biochemical"),
                             ("DamageStun", "stun")):
                mm = re.search(rf'{k}="([^"]+)"', a)
                if mm:
                    v = safe_float(mm.group(1))
                    if v > 0: dmg[short] = v
            if dmg:
                out["damage"] = dmg
                out["alphaDamage"] = round(sum(dmg.values()), 2)

    # Fuse / arm / detonation timers (new format keeps the same tag shape).
    timers = []
    for m in re.finditer(
        r'<STriggerableDevicesTriggerTimerParams\s+name="([^"]*)"[^>]*duration="([^"]+)"',
        xml,
    ):
        timers.append((m.group(1).strip(), safe_float(m.group(2))))
    fuse = None
    for name, dur in timers:
        nlow = name.lower()
        if ("explosion" in nlow and "pre" not in nlow) or name == "":
            fuse = dur; break
    if fuse is None and timers:
        fuse = timers[0][1]
    if fuse and fuse > 0:
        out["fuseSec"] = round(fuse, 2)

    # Fall back to loc Desc lines when XML doesn't publish an explosion
    # block (older mine variants). Keeps grenade's "Area of Effect" +
    # "Damage Type" available for display.
    if desc:
        m_aoe = re.search(r"Area\s+of\s+Effect:\s*(\d+(?:\.\d+)?)\s*m", desc, re.I)
        if m_aoe and "maxRadiusM" not in out:
            out["areaOfEffectM"] = safe_float(m_aoe.group(1))
        m_dt = re.search(r"Damage\s+Type:\s*([A-Za-z]+)", desc, re.I)
        if m_dt and "damage" not in out:
            out["damageType"] = m_dt.group(1)

    return out


def walk(subpath: str, category_fn, loc: dict, out: list):
    """Walk a directory, parse each XML, emit gear records via category_fn."""
    d = FORGE / subpath
    if not d.exists():
        print(f"  skip missing: {subpath}")
        return
    n = 0
    for f in sorted(d.rglob("*.xml.xml")):
        if f.is_dir(): continue
        rec = parse_entity(f, loc)
        if not rec: continue
        stem = rec["className"]
        if is_skip(stem): continue
        if stem in SKIP_EXACT or stem.startswith(SKIP_STEMS):
            continue
        cat = category_fn(rec)
        if not cat: continue
        rec["category"] = cat
        if not rec["name"]:
            rec["name"] = MANUAL_NAMES.get(stem, stem)
        out.append(rec)
        n += 1
    print(f"  {subpath:<40} → {n}")


def extract_gear():
    print("=" * 60); print(f"FPS Gear Extraction ({_MODE})"); print("=" * 60)
    loc = load_localization(GLOBAL_INI)
    print(f"  Loaded {len(loc)} localization entries")

    out: list[dict] = []

    # 1. Consumables
    def consumable_cat(rec):
        return CATEGORY_MAP.get((rec["attachType"], rec["subType"]))
    walk("consumables", consumable_cat, loc, out)

    # 2. FPS deployables (LTP trip mine devices, timed explosives)
    def deployable_cat(rec):
        if rec["attachType"] == "FPS_Deployable":
            spec = parse_throwable_spec(rec["_xml"], rec.get("_desc", ""))
            if spec: rec["throwableSpec"] = spec
            return "Throwable / Deployable"
        return None
    walk("fps_devices", deployable_cat, loc, out)

    # 3. Mines (trip + proximity)
    def mine_cat(rec):
        if rec["attachType"] in ("Grenade", "WeaponPersonal"):
            spec = parse_throwable_spec(rec["_xml"], rec.get("_desc", ""))
            if spec: rec["throwableSpec"] = spec
            return "Throwable / Mine"
        if rec["attachType"] == "Gadget":
            return "Mine / Deployable"
        return None
    walk("weapons/mines", mine_cat, loc, out)

    # 3b. Throwable grenades — AttachDef is (WeaponPersonal, Grenade) for the
    # MK-4 frag; pulled into gear so the Items DB shows it alongside mines.
    # Loadout continues to pick it up from the weapons catalog.
    def grenade_cat(rec):
        if rec["attachType"] == "WeaponPersonal" and rec["subType"] == "Grenade":
            spec = parse_throwable_spec(rec["_xml"], rec.get("_desc", ""))
            if spec: rec["throwableSpec"] = spec
            return "Throwable / Grenade"
        return None
    walk("weapons/throwable", grenade_cat, loc, out)

    # 4. Melee knives
    def knife_cat(rec):
        if rec["attachType"] == "WeaponPersonal" and rec["subType"] == "Knife":
            spec = parse_melee_spec(rec.get("_desc", ""))
            if spec: rec["meleeSpec"] = spec
            return "Melee / Knife"
        return None
    walk("weapons/melee", knife_cat, loc, out)

    # 5. Mining gadgets (handheld laser modifiers — BoreMax, WaveShift, etc.)
    def gadget_cat(rec):
        if rec["attachType"] == "Gadget":
            spec = parse_mining_spec(rec.get("_desc", ""))
            if spec:
                rec["miningSpec"] = spec
            return "Mining Gadget"
        return None
    walk("weapons/devices", gadget_cat, loc, out)

    # 6. Tools from fps_weapons (medgun, tractor, multitool + multitool heads)
    fps_weapons_dir = FORGE / "weapons" / "fps_weapons"
    if fps_weapons_dir.exists():
        n = 0
        for f in sorted(fps_weapons_dir.iterdir()):
            if f.is_dir() or not f.name.endswith(".xml.xml"): continue
            rec = parse_entity(f, loc)
            if not rec: continue
            stem = rec["className"]
            # Whitelist bypass — mission-reward ParaMed variants would
            # otherwise be skipped as skins by `is_skip`, but at least
            # AA Support has a distinct loaded medicine so we keep them.
            if stem not in FPS_WEAPONS_TOOL_STEMS and is_skip(stem):
                continue
            cat = None
            # Multi-tool head overrides take precedence — LifeGuard
            # Attachment moves to Tool / Medical so it appears on the
            # Medical tab with the ParaMed, not buried in Multi-Tool Heads.
            override = MULTITOOL_HEAD_CATEGORY_OVERRIDES.get(stem)
            if override:
                cat, override_name = override
                rec["name"] = override_name
            elif stem in FPS_WEAPONS_TOOL_STEMS:
                cat = FPS_WEAPONS_TOOL_STEMS[stem]
            elif stem.startswith(MULTITOOL_HEAD_PREFIX):
                head = stem[len(MULTITOOL_HEAD_PREFIX):]
                cat = f"Tool / Multi-Tool Head — {head.replace('_', ' ').title()}"
            if not cat: continue
            rec["category"] = cat
            if not rec["name"]: rec["name"] = stem

            # Pull SWeaponActionFireHealingBeamParams only for items that
            # actually use it — the action definition is inherited by every
            # multitool variant but only the healing-head and the ParaMed
            # actually heal.
            xml = f.read_text(errors="replace")
            m_hb = re.search(r'<SWeaponActionFireHealingBeamParams\s+([^>]+?)__type=', xml) \
                   if stem in HEALING_TOOLS else None
            if m_hb:
                attrs = m_hb.group(1)
                def _a(name):
                    mm = re.search(rf'(?<![A-Za-z]){name}="([^"]+)"', attrs)
                    return mm.group(1) if mm else None
                spec = {}
                for k in ("mSCUPerSec", "ammoPerMSCU", "maxDistance",
                         "maxSensorDistance", "wearPerSec",
                         "batteryDrainPerSec", "autoDosageTargetBDLModifier",
                         "healingBreakTime"):
                    v = _a(k)
                    if v is not None:
                        spec[k] = safe_float(v)
                hm = _a("healingMode")
                if hm: spec["healingMode"] = hm

                # Capture the Health-type consumable subtype this tool
                # dispenses by default — this is where variant differences
                # actually live (AA Support uses 18603d6d, others use the
                # standard 2e3fc0d3). Once the DCB extractor maps subtype
                # → HP per microSCU we can compute HP/sec per variant.
                mm = re.search(
                    r'<SHealingBeamConsumableType\s+consumableSubtype="([^"]+)"\s+valueType="Health"',
                    xml,
                )
                if mm:
                    spec["healthSubtype"] = mm.group(1)

                if spec:
                    rec["medGunSpec"] = spec

            n += 1
            out.append(rec)
        print(f"  weapons/fps_weapons (tools)              → {n}")

    # Dedup by className (a few items can be hit via multiple walks)
    seen = set(); unique = []
    for r in out:
        if r["className"] in seen: continue
        seen.add(r["className"]); unique.append(r)
    out = unique

    # Strip internal-only scratch fields before emitting JSON.
    for r in out:
        r.pop("_desc", None)
        r.pop("_xml", None)

    out.sort(key=lambda r: (r["category"], r["manufacturer"], r["name"]))

    # Game version
    version = "unknown"
    try:
        manifest = Path(f"/home/bryan/projects/SC Raw Data/{_MODE.upper()}/build_manifest.id")
        if manifest.exists():
            data = json.loads(manifest.read_text())["Data"]
            vm = re.search(r"(\d+\.\d+\.\d+)", data.get("Branch", ""))
            if vm: version = vm.group(1)
    except Exception:
        pass

    output = {
        "meta": {
            "count": len(out),
            "version": version,
        },
        "items": out,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nWrote {len(out)} gear items → {OUT_FILE}")

    # Summary by category
    print("\nBy category:")
    by_cat = {}
    for r in out:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    for c, n in sorted(by_cat.items()):
        print(f"  {c:<45} {n}")


if __name__ == "__main__":
    extract_gear()

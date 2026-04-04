"""
generate_stdb.py
================
Converts versedb_data.json into STDB-format JSON files for scdb import.

Strategy:
  1. Load current scdb data via exported JSON (baseline from sc-fools pipeline)
  2. Load versedb_data.json (enriched data from our pipeline)
  3. Match ships by displayName, components by className ↔ entityClassName
  4. Merge versedb enrichments onto the scdb baseline
  5. Write 8 JSON files to stdb/ directory
"""

import json
import sys
from pathlib import Path

STDB_DIR = Path(__file__).parent
VERSEDB_DATA = Path(__file__).parent.parent / "app" / "public" / "live" / "versedb_data.json"

# ── Ship ID mapping (versedb className → scdb id) ────────────────────────────
# Built by matching displayName, with manual overrides for mismatches
SHIP_ID_OVERRIDES = {
    # versedb className → scdb id (for cases where displayName doesn't match)
    "aegs_idris_m_pu": None,            # skip: PU-specific variant not in scdb
    "anvl_hornet_f7a_mk1": "ANVL_Hornet_F7A",
    "anvl_hornet_f7a_mk2": None,        # not in scdb yet
    "anvl_hornet_f7cm_mk2_heartseeker": None,  # not in scdb yet
    "ANVL_Hornet_F7A_MK1": None,        # duplicate of anvl_hornet_f7a_mk1
    "ANVL_Pisces": "ANVL_Pisces",       # displayName mismatch: "ANVL Pisces" vs "Anvil C8 Pisces"
    "argo_mpuv_1t": "ARGO_MPUV_1T",
    "ARGO_MPUV_1T": "ARGO_MPUV_1T",    # duplicate
    "cnou_mustang_alpha": "CNOU_Mustang",
    "crus_starfighter_ion": None,       # Ares Ion not in scdb separately
    "drak_cutter_rambler": None,        # not in scdb yet
    "drak_dragonfly_pink": None,        # Star Kitten variant
    "drak_dragonfly_yellow": None,      # Yellowjacket variant
    "GRIN_MXC": "GRIN_MXC",            # displayName mismatch
    "KRIG_L22_alpha_wolf": None,        # not in scdb yet
    "rsi_aurora_gs_se": None,           # not in scdb yet
    "rsi_aurora_mk2": None,             # Aurora Mk II not in scdb yet
    "rsi_zeus_es": None,                # Zeus ES not in scdb yet
    "VNCL_Blade": "VNCL_Blade",         # displayName mismatch
    "crus_spirit_a1": "crus_spirit",    # A1 Spirit maps to base
    "crus_spirit_c1": None,             # C1 Spirit not in scdb yet
    "anvl_carrack_expedition": None,    # Expedition variant not in scdb
}


def load_versedb():
    with open(VERSEDB_DATA) as f:
        return json.load(f)


def build_ship_name_map(scdb_ships):
    """Build displayName → scdb ship dict."""
    return {s["displayName"]: s for s in scdb_ships}


def merge_ship_enrichments(scdb_ship, vdb_ship):
    """Merge versedb enriched fields onto scdb ship baseline."""
    s = dict(scdb_ship)

    # Flight stats
    s["scmSpeed"] = vdb_ship.get("scmSpeed", 0) or 0
    s["navSpeed"] = vdb_ship.get("navSpeed", 0) or 0
    s["boostSpeedFwd"] = vdb_ship.get("boostSpeedFwd", 0) or 0
    s["boostSpeedBwd"] = vdb_ship.get("boostSpeedBwd", 0) or 0
    s["boostRampUp"] = vdb_ship.get("boostRampUp", 0) or 0
    s["boostRampDown"] = vdb_ship.get("boostRampDown", 0) or 0
    s["pitch"] = vdb_ship.get("pitch", 0) or 0
    s["yaw"] = vdb_ship.get("yaw", 0) or 0
    s["roll"] = vdb_ship.get("roll", 0) or 0
    s["pitchBoosted"] = vdb_ship.get("pitchBoosted", 0) or 0
    s["yawBoosted"] = vdb_ship.get("yawBoosted", 0) or 0
    s["rollBoosted"] = vdb_ship.get("rollBoosted", 0) or 0
    s["thrusterPowerBars"] = vdb_ship.get("thrusterPowerBars", 0) or 0

    # Acceleration
    s["accelFwd"] = vdb_ship.get("accelFwd", 0) or 0
    s["accelRetro"] = vdb_ship.get("accelRetro", 0) or 0
    s["accelStrafe"] = vdb_ship.get("accelStrafe", 0) or 0
    s["accelUp"] = vdb_ship.get("accelUp", 0) or 0
    s["accelDown"] = vdb_ship.get("accelDown", 0) or 0
    s["accelAbFwd"] = vdb_ship.get("accelAbFwd", 0) or 0
    s["accelAbRetro"] = vdb_ship.get("accelAbRetro", 0) or 0
    s["accelAbStrafe"] = vdb_ship.get("accelAbStrafe", 0) or 0
    s["accelAbUp"] = vdb_ship.get("accelAbUp", 0) or 0
    s["accelAbDown"] = vdb_ship.get("accelAbDown", 0) or 0
    s["accelTestedDate"] = vdb_ship.get("accelTestedDate", "") or ""

    # HP
    s["totalHp"] = vdb_ship.get("totalHp", 0) or 0
    s["bodyHp"] = vdb_ship.get("bodyHp", 0) or 0

    # Vital parts (JSON string)
    vp = vdb_ship.get("vitalParts")
    if vp and isinstance(vp, dict):
        s["vitalParts"] = json.dumps(vp)
    elif vp and isinstance(vp, str):
        s["vitalParts"] = vp

    # Shop prices (JSON string)
    sp = vdb_ship.get("shopPrices")
    if sp and isinstance(sp, list):
        s["shopPrices"] = json.dumps(sp)
    elif sp and isinstance(sp, str):
        s["shopPrices"] = sp

    # Cargo (use versedb value, respecting the naming resolution)
    cargo = vdb_ship.get("cargoCapacity", 0) or 0
    if cargo:
        s["cargoCapacityScu"] = cargo

    # Ore capacity
    s["oreCapacity"] = vdb_ship.get("oreCapacity", 0) or 0

    # Countermeasures (naming resolution: cmDecoys→cmDecoyCount, cmNoise→cmNoiseCount)
    cm_decoys = vdb_ship.get("cmDecoys", 0) or 0
    cm_noise = vdb_ship.get("cmNoise", 0) or 0
    if cm_decoys:
        s["cmDecoyCount"] = cm_decoys
    if cm_noise:
        s["cmNoiseCount"] = cm_noise

    # Fuel
    hf = vdb_ship.get("hydrogenFuelCapacity", 0) or 0
    qf = vdb_ship.get("quantumFuelCapacity", 0) or 0
    if hf:
        s["hydrogenFuelCapacity"] = hf
    if qf:
        s["quantumFuelCapacity"] = qf

    # Signatures
    s["signalEm"] = vdb_ship.get("signalEM", 0) or 0
    s["signalIr"] = vdb_ship.get("signalIR", 0) or 0
    s["signalCrossSection"] = vdb_ship.get("signalCrossSection", 0) or 0

    # Armor
    s["armorDeflectPhys"] = vdb_ship.get("armorDeflectPhys", 0) or 0
    s["armorDeflectEnrg"] = vdb_ship.get("armorDeflectEnrg", 0) or 0
    s["armorHp"] = vdb_ship.get("armorHp", 0) or 0

    # Hull damage
    s["hullDmgPhys"] = vdb_ship.get("hullDmgPhys", 0) or 0
    s["hullDmgEnrg"] = vdb_ship.get("hullDmgEnrg", 0) or 0
    s["hullDmgDist"] = vdb_ship.get("hullDmgDist", 0) or 0

    return s


def merge_component_enrichments(scdb_comp, vdb_item):
    """Merge versedb enriched fields onto scdb component baseline."""
    c = dict(scdb_comp)

    # Weapon damage fields
    dmg = vdb_item.get("damage")
    if dmg and isinstance(dmg, dict):
        c["damagePhysical"] = dmg.get("physical", 0) or 0
        c["damageEnergy"] = dmg.get("energy", 0) or 0
        c["damageDistortion"] = dmg.get("distortion", 0) or 0
        c["damageThermal"] = dmg.get("thermal", 0) or 0
        c["damageTotal"] = sum([
            dmg.get("physical", 0) or 0,
            dmg.get("energy", 0) or 0,
            dmg.get("distortion", 0) or 0,
            dmg.get("thermal", 0) or 0,
        ])

    c["alphaDamage"] = vdb_item.get("alphaDamage", 0) or 0
    c["dps"] = vdb_item.get("dps", 0) or 0
    c["isBallistic"] = 1 if vdb_item.get("isBallistic") else 0

    # Fire rate
    fr = vdb_item.get("fireRate", 0) or 0
    if fr:
        c["fireRateRpm"] = fr

    # Ammo
    c["ammoCount"] = vdb_item.get("ammoCount", 0) or 0
    c["maxAmmoLoad"] = vdb_item.get("maxAmmoLoad", 0) or 0
    c["maxRegenPerSec"] = vdb_item.get("maxRegenPerSec", 0) or 0
    c["regenCooldown"] = vdb_item.get("regenCooldown", 0) or 0
    c["requestedAmmoLoad"] = vdb_item.get("requestedAmmoLoad", 0) or 0
    c["costPerBullet"] = vdb_item.get("costPerBullet", 0) or 0
    c["maxRestockCount"] = vdb_item.get("maxRestockCount", 0) or 0
    c["heatPerShot"] = vdb_item.get("heatPerShot", 0) or 0

    # Range
    c["maxRange"] = vdb_item.get("maxRange", 0) or 0
    c["optimalRange"] = vdb_item.get("optimalRange", 0) or 0

    # Projectile
    c["ammoSpeed"] = vdb_item.get("projectileSpeed", 0) or 0
    rng = vdb_item.get("range", 0) or 0
    spd = vdb_item.get("projectileSpeed", 0) or 0
    if rng and spd:
        c["ammoLifetime"] = rng / spd if spd > 0 else 0

    # Power
    pd = vdb_item.get("powerDraw", 0) or 0
    if pd:
        c["powerDrawResolved"] = pd

    # Power bands (for shields, coolers, QDs)
    pb = vdb_item.get("powerBands")
    if pb and isinstance(pb, list):
        c["powerBands"] = json.dumps(pb)

    ps = vdb_item.get("powerMin", 0) or 0
    if ps:
        c["powerSegments"] = ps

    mcf = vdb_item.get("minConsumptionFraction", 0) or 0
    if mcf:
        c["minimumConsumptionFraction"] = mcf

    # Shield-specific
    if vdb_item.get("type") == "Shield":
        c["shieldRegenResolved"] = vdb_item.get("regenRate", 0) or 0

    # Cooler-specific
    if vdb_item.get("type") == "Cooler":
        c["coolingRateResolved"] = vdb_item.get("coolingRate", 0) or 0

    # Power plant-specific
    if vdb_item.get("type") == "PowerPlant":
        c["powerGenerationResolved"] = vdb_item.get("powerOutput", 0) or 0

    return c


def build_ship_defaults(vdb_ships, ship_id_map):
    """Build ship_defaults table from versedb defaultLoadout data."""
    defaults = []
    for vdb_ship in vdb_ships:
        scdb_id = ship_id_map.get(vdb_ship["className"])
        if not scdb_id:
            continue
        loadout = vdb_ship.get("defaultLoadout", {})
        if not loadout:
            continue
        for hp_name, comp_class in loadout.items():
            defaults.append({
                "id": f"{scdb_id}::{hp_name}::{comp_class}",
                "shipId": scdb_id,
                "hardpointName": hp_name,
                "componentClassName": comp_class,
            })
    return defaults


def main():
    print("Loading versedb data...")
    vdb = load_versedb()
    print(f"  {len(vdb['ships'])} ships, {len(vdb['items'])} items")

    # Load scdb baseline data (exported JSON files)
    scdb_dir = STDB_DIR / "scdb_baseline"
    if not scdb_dir.exists():
        print(f"\nERROR: Baseline scdb data not found at {scdb_dir}/")
        print("Run the export step first to create baseline JSON files.")
        sys.exit(1)

    print("Loading scdb baseline...")
    tables = {}
    for fname in ["ships", "components", "ship_hardpoints",
                   "hardpoint_compat", "manufacturers",
                   "inventory_containers", "ship_cargo"]:
        fpath = scdb_dir / f"{fname}.json"
        if fpath.exists():
            with open(fpath) as f:
                tables[fname] = json.load(f)
            print(f"  {fname}: {len(tables[fname])} records")
        else:
            tables[fname] = []
            print(f"  {fname}: MISSING")

    # ── Build ship ID mapping ─────────────────────────────────────────────
    scdb_by_name = {s["displayName"]: s for s in tables["ships"]}
    ship_id_map = {}  # versedb className → scdb id

    matched = 0
    for vdb_ship in vdb["ships"]:
        cn = vdb_ship["className"]

        # Check manual override first
        if cn in SHIP_ID_OVERRIDES:
            override = SHIP_ID_OVERRIDES[cn]
            if override:
                ship_id_map[cn] = override
                matched += 1
            continue

        # Match by displayName
        if vdb_ship["name"] in scdb_by_name:
            ship_id_map[cn] = scdb_by_name[vdb_ship["name"]]["id"]
            matched += 1

    print(f"\nShip matching: {matched}/{len(vdb['ships'])} matched")

    # ── Merge ship enrichments ────────────────────────────────────────────
    scdb_ships_by_id = {s["id"]: s for s in tables["ships"]}
    merged_ships = []
    enriched_count = 0

    for scdb_ship in tables["ships"]:
        # Find matching versedb ship
        vdb_match = None
        for vdb_ship in vdb["ships"]:
            if ship_id_map.get(vdb_ship["className"]) == scdb_ship["id"]:
                vdb_match = vdb_ship
                break

        if vdb_match:
            merged_ships.append(merge_ship_enrichments(scdb_ship, vdb_match))
            enriched_count += 1
        else:
            merged_ships.append(dict(scdb_ship))

    print(f"Ships enriched: {enriched_count}/{len(tables['ships'])}")

    # ── Build component matching ──────────────────────────────────────────
    # scdb uses entityClassName (e.g., "BANU_TachyonCannon_S2")
    # versedb uses className (e.g., "banu_tachyoncannon_s2")
    # Match case-insensitively
    scdb_comps_by_cn_lower = {}
    for comp in tables["components"]:
        scdb_comps_by_cn_lower[comp["entityClassName"].lower()] = comp

    merged_components = list(tables["components"])  # start with all scdb components
    comp_enriched = 0

    for vdb_item in vdb["items"]:
        cn_lower = vdb_item["className"].lower()
        if cn_lower in scdb_comps_by_cn_lower:
            scdb_comp = scdb_comps_by_cn_lower[cn_lower]
            # Replace in merged list
            idx = next(i for i, c in enumerate(merged_components)
                       if c["entityClassName"].lower() == cn_lower)
            merged_components[idx] = merge_component_enrichments(scdb_comp, vdb_item)
            comp_enriched += 1

    print(f"Components enriched: {comp_enriched}/{len(vdb['items'])} versedb items matched")

    # ── Build ship_defaults ───────────────────────────────────────────────
    ship_defaults = build_ship_defaults(vdb["ships"], ship_id_map)
    print(f"Ship defaults generated: {len(ship_defaults)} entries")

    # ── Write output ──────────────────────────────────────────────────────
    output = {
        "ships.json": merged_ships,
        "components.json": merged_components,
        "ship_hardpoints.json": tables["ship_hardpoints"],
        "hardpoint_compat.json": tables.get("hardpoint_compat", []),
        "ship_defaults.json": ship_defaults,
        "manufacturers.json": tables["manufacturers"],
        "inventory_containers.json": tables["inventory_containers"],
        "ship_cargo.json": tables["ship_cargo"],
    }

    print(f"\nWriting STDB output to {STDB_DIR}/")
    for fname, data in output.items():
        fpath = STDB_DIR / fname
        with open(fpath, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  {fname}: {len(data)} records")

    # Also write a build_manifest for game version
    manifest = {
        "id": vdb["meta"]["version"],
        "source": "versedb",
        "shipCount": len(merged_ships),
        "componentCount": len(merged_components),
    }
    with open(STDB_DIR / "build_manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone! Game version: {vdb['meta']['version']}")
    print(f"Set SCDB_DATA_DIR={STDB_DIR} and run import_to_scdb")


if __name__ == "__main__":
    main()

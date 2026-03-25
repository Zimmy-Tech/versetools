"""
versedb_missions.py
====================
Extracts mission data from Star Citizen's DataForge mission broker XMLs
and outputs versedb_missions.json.

Run after versedb_extract.py (needs localization from the same data).
"""

import json
import os
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

FORGE_DIR = Path(__file__).parent / "../SC FILES/sc_data_forge_47/libs/foundry/records"
GLOBAL_INI = Path(__file__).parent / "../SC FILES/sc_data_xml_47/Data/Localization/english/global.ini"
OUTPUT_FILE = Path(__file__).parent / "versedb_missions.json"
APP_FILE = Path(__file__).parent / "../../versedb-app/public/versedb_missions.json"

def load_localization(ini_path):
    loc = {}
    if not ini_path.exists():
        print(f"  WARNING: localization file not found at {ini_path}")
        return loc
    with open(ini_path, "r", encoding="utf-8-sig") as f:
        for line in f:
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
    val = loc.get(key.lower(), key)
    if val.startswith("@"):
        return ""  # unresolved
    return val

def infer_system(class_name):
    """Infer star system from className."""
    cn = class_name.lower()
    if 'stanton1' in cn: return 'Hurston'
    if 'stanton2' in cn: return 'Crusader'
    if 'stanton3' in cn: return 'ArcCorp'
    if 'stanton4' in cn: return 'microTech'
    if 'stanton' in cn: return 'Stanton'
    if 'pyro' in cn: return 'Pyro'
    if 'nyx' in cn: return 'Nyx'
    return ''

def infer_activity(class_name, generator=''):
    """Infer activity type (Ship, FPS, Mining, Salvage, etc.)."""
    cn = class_name.lower()
    gen = generator.lower()
    if 'shipcombat' in cn or 'shipambush' in cn or 'killship' in gen or 'escortship' in gen or 'patrol' in gen or 'defendship' in gen:
        return 'Ship'
    if 'bounty' in cn and 'fps' not in cn:
        return 'Ship'
    if 'fps' in cn or 'eliminate' in cn or 'derelict' in cn or 'facilitydelv' in gen or 'killnpc' in gen or 'killanimal' in gen:
        return 'FPS'
    if 'mining' in cn or 'fpsmining' in gen or 'resourcegathering' in gen:
        return 'Mining'
    if 'salvage' in cn or 'salvage' in gen:
        return 'Salvage'
    if 'delivery' in cn or 'courier' in cn or 'hauling' in gen or 'haulcargo' in cn:
        return 'Delivery'
    if 'racing' in cn or 'racing' in gen:
        return 'Racing'
    if 'theft' in cn or 'steal' in cn or 'heist' in cn or 'blockaderunner' in cn:
        return 'Crime'
    if 'towing' in cn:
        return 'Towing'
    return ''

def infer_category(path_str, class_name):
    """Infer mission category from file path and class name."""
    p = path_str.lower()
    if '/cargo/' in p or 'haulcargo' in p:
        return 'Cargo'
    if '/delivery/' in p or 'delivery' in class_name.lower() or 'courier' in class_name.lower():
        return 'Delivery'
    if '/pu_mercenary/' in p or 'bounty' in p or 'assassin' in class_name.lower():
        return 'Bounty'
    if '/theft/' in p or 'steal' in class_name.lower() or 'heist' in class_name.lower():
        return 'Theft'
    if '/towing/' in p:
        return 'Towing'
    if '/investigation/' in p:
        return 'Investigation'
    if '/prisons/' in p:
        return 'Prison'
    if '/pvp/' in p:
        return 'PvP'
    if '/dynamicevents/' in p or '/worldevents/' in p or '/events/' in p:
        return 'Event'
    if '/tutorial/' in p:
        return 'Tutorial'
    if 'infiltrate' in p or 'defend' in p:
        return 'Combat'
    if 'inhabited_derelict' in p or 'derelict' in class_name.lower():
        return 'Derelict'
    if 'combinedmissions' in p:
        return 'Combined'
    if 'shiphijacked' in p:
        return 'Ship Recovery'
    if 'blockaderunner' in p:
        return 'Blockade Runner'
    if '/missiongivers/' in p:
        giver = p.split('/missiongivers/')[-1].split('/')[0]
        return f'Mission Giver ({giver.title()})'
    return 'Other'

def guid_key(g):
    """Normalize GUID for matching (SC uses mixed-endian byte orders)."""
    return "".join(sorted(g.replace("-", "").lower()))

def parse_mission(xml_path, loc, scope_map=None):
    """Parse a single mission broker XML file."""
    try:
        root = ET.parse(xml_path).getroot()
    except Exception:
        return None

    class_name = xml_path.stem.replace(".xml", "")

    # Skip not-for-release and test missions
    if root.get("notForRelease") == "1":
        return None

    title_ref = root.get("title", "")
    desc_ref = root.get("description", "")
    giver_ref = root.get("missionGiver", "")

    title = loc_lookup(loc, title_ref)
    description = loc_lookup(loc, desc_ref)
    giver = loc_lookup(loc, giver_ref)

    # Skip missions with no title
    if not title or title == title_ref:
        return None

    # Reward
    reward_el = root.find(".//missionReward")
    reward = 0
    currency = "UEC"
    if reward_el is not None:
        reward = int(float(reward_el.get("reward", "0")))
        currency = reward_el.get("currencyType", "UEC")

    # Deadline
    deadline_el = root.find(".//missionDeadline")
    lifetime = 0
    if deadline_el is not None:
        lifetime = int(float(root.get("instanceLifeTime", "0")))

    difficulty = int(float(root.get("missionDifficulty", "-1")))
    lawful = root.get("lawfulMission", "0") == "1"
    max_instances = int(float(root.get("maxInstances", "1")))
    max_players = int(float(root.get("maxPlayersPerInstance", "1")))
    can_share = root.get("canBeShared", "0") == "1"
    once_only = root.get("onceOnly", "0") == "1"
    available_in_prison = root.get("availableInPrison", "0") == "1"

    # Respawn
    respawn = int(float(root.get("respawnTime", "0")))
    cooldown = int(float(root.get("abandonedCooldownTime", "0")))

    # Reputation scopes
    rep_scopes = []
    if scope_map:
        txt = ET.tostring(root, encoding='unicode')
        for m in re.finditer(r'reputationScope="([^"]+)"', txt):
            scope_guid = m.group(1)
            scope_name = scope_map.get(guid_key(scope_guid))
            if scope_name and scope_name not in rep_scopes:
                rep_scopes.append(scope_name)

    category = infer_category(str(xml_path), class_name)

    result = {
        "className": class_name,
        "title": title,
        "category": category,
        "reward": reward,
        "currency": currency,
        "lawful": lawful,
        "difficulty": difficulty,
        "maxPlayers": max_players,
        "canShare": can_share,
    }

    if description:
        result["description"] = description
    if giver:
        result["giver"] = giver
    if lifetime > 0:
        result["lifetimeMin"] = lifetime
    if respawn > 0:
        result["respawnMin"] = respawn
    if cooldown > 0:
        result["cooldownMin"] = cooldown
    if once_only:
        result["onceOnly"] = True
    if available_in_prison:
        result["prison"] = True
    if rep_scopes:
        result["repScopes"] = rep_scopes
    system = infer_system(class_name)
    if system:
        result["system"] = system
    activity = infer_activity(class_name)
    if activity:
        result["activity"] = activity

    return result

def main():
    print("=" * 60)
    print("VerseDB Mission Extractor")
    print("=" * 60)

    # Localization
    print("\n[1/3] Loading localization...")
    loc = load_localization(GLOBAL_INI)

    # Mission givers
    print("\n[2/3] Parsing mission givers...")
    giver_dir = FORGE_DIR / "missiongiver"
    givers = {}
    if giver_dir.exists():
        for f in giver_dir.glob("*.xml.xml"):
            try:
                root = ET.parse(f).getroot()
                name_ref = root.get("displayName", "")
                desc_ref = root.get("description", "")
                hq_ref = root.get("headquarters", "")
                name = loc_lookup(loc, name_ref)
                if name and name != name_ref:
                    givers[f.stem.replace(".xml", "")] = {
                        "name": name,
                        "description": loc_lookup(loc, desc_ref),
                        "headquarters": loc_lookup(loc, hq_ref),
                    }
            except Exception:
                pass
    print(f"  Parsed {len(givers)} mission givers")

    # Reputation lookups
    print("\n[3/6] Building reputation maps...")
    scope_dir = FORGE_DIR / "reputation" / "scopes"
    scope_map = {}
    if scope_dir.exists():
        for f in scope_dir.rglob("*.xml.xml"):
            try:
                root = ET.parse(f).getroot()
                ref = root.get("__ref", "")
                name = f.stem.replace(".xml", "").replace("reputationscope_", "")
                if ref:
                    scope_map[guid_key(ref)] = name
            except Exception:
                pass

    standing_map = {}
    standing_display = {}  # standing_key -> localized name
    standings_dir = FORGE_DIR / "reputation" / "standings"
    if standings_dir.exists():
        for f in standings_dir.rglob("*.xml.xml"):
            if f.is_dir():
                continue
            try:
                root = ET.parse(f).getroot()
                ref = root.get("__ref", "")
                name = f.stem.replace(".xml", "").replace("reputationstanding_", "")
                if ref:
                    standing_map[guid_key(ref)] = name
                display_ref = root.get("displayName", "")
                if display_ref:
                    display = loc_lookup(loc, display_ref)
                    if display:
                        standing_display[name] = display
            except Exception:
                pass
    print(f"  Loaded {len(scope_map)} scopes, {len(standing_map)} standings, {len(standing_display)} display names")

    # Blueprint pools
    print("\n[4/7] Building blueprint pool map...")
    bp_pool_dir = FORGE_DIR / "crafting" / "blueprintrewards" / "blueprintmissionpools"
    bp_pool_map = {}  # sorted GUID → pool name
    bp_pool_items = {}  # pool name → [resolved item names]
    if bp_pool_dir.exists():
        # Build craft blueprint GUID → display name
        craft_dir = FORGE_DIR / "crafting" / "blueprints"
        craft_names = {}  # sorted GUID → display name
        if craft_dir.exists():
            for cf in craft_dir.rglob("*.xml.xml"):
                try:
                    ctxt = open(cf, encoding="utf-8").read()
                    cref = re.search(r'__ref="([^"]+)"', ctxt)
                    if cref:
                        raw = cf.stem.replace(".xml", "").replace("bp_craft_", "")
                        # Try localization: item_Name + rawname (no separator) or item_Name_ + rawname
                        display = (loc.get(f"item_name{raw}".lower(), "") or
                                   loc.get(f"item_name_{raw}".lower(), ""))
                        craft_names[guid_key(cref.group(1))] = display or raw
                except Exception:
                    pass

        for f in bp_pool_dir.glob("*.xml.xml"):
            try:
                txt = open(f, encoding="utf-8").read()
                ref_m = re.search(r'__ref="([^"]+)"', txt)
                if ref_m:
                    pool_name = f.stem.replace(".xml", "").replace("bp_missionreward_", "")
                    bp_pool_map[guid_key(ref_m.group(1))] = pool_name
                    # Resolve blueprint items
                    bp_guids = re.findall(r'blueprintRecord="([^"]+)"', txt)
                    items = []
                    for bg in bp_guids:
                        item_name = craft_names.get(guid_key(bg), bg[:8])
                        if item_name and item_name != "null":
                            items.append(item_name)
                    bp_pool_items[pool_name] = items
            except Exception:
                pass
    print(f"  Loaded {len(bp_pool_map)} blueprint pools, {len(craft_names)} craft blueprints")

    # Contracts (from contract generator system)
    print("\n[5/7] Parsing contracts...")
    contract_dir = FORGE_DIR / "contracts" / "contractgenerator"
    contracts = []
    if contract_dir.exists():
        for gf in contract_dir.rglob("*.xml.xml"):
            try:
                root = ET.parse(gf).getroot()
                txt = ET.tostring(root, encoding='unicode')
            except Exception:
                continue

            gen_name = gf.stem.replace(".xml", "")

            # Extract generator-level cooldown (on defaultAvailability element)
            gen_personal_cd = re.search(r'personalCooldownTime="([^"]+)"', txt)
            gen_abandon_cd = re.search(r'abandonedCooldownTime="([^"]+)"', txt)
            gen_cooldown = int(float(gen_personal_cd.group(1))) if gen_personal_cd else 0
            gen_abandon_cooldown = int(float(gen_abandon_cd.group(1))) if gen_abandon_cd else 0

            # Extract generator-level default title from contractParams
            gen_title_m = re.search(r'<contractParams[^>]*>.*?param="Title"\s+value="([^"]+)"', txt, re.S)
            gen_title = loc_lookup(loc, gen_title_m.group(1)) if gen_title_m else ""
            if gen_title and "~mission(" in gen_title:
                gen_title = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', gen_title)

            def parse_contract_element(attrs, body, gen_name, parent_title=""):
                """Parse a Contract, SubContract, or CareerContract element."""
                if 'notForRelease="1"' in attrs:
                    return None

                debug = re.search(r'debugName="([^"]+)"', attrs)
                debug_name = debug.group(1) if debug else gen_name

                title_m = re.search(r'param="Title"\s+value="([^"]+)"', body)
                desc_m = re.search(r'param="Description"\s+value="([^"]+)"', body)
                title = loc_lookup(loc, title_m.group(1)) if title_m else ""
                desc = loc_lookup(loc, desc_m.group(1)) if desc_m else ""

                # Clean template vars or fall back to parent title or debug name
                if not title:
                    title = parent_title or debug_name
                if "~mission(" in title:
                    title = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', title)

                # Reputation prerequisites
                rep_reqs = []
                for rm in re.finditer(r'ContractPrerequisite_Reputation[^/]*/>', body):
                    section = rm.group(0)
                    scope_g = re.search(r'scope="([^"]+)"', section)
                    min_g = re.search(r'minStanding="([^"]+)"', section)
                    max_g = re.search(r'maxStanding="([^"]+)"', section)

                    scope_key = scope_map.get(guid_key(scope_g.group(1)), "?") if scope_g else "?"
                    min_key = standing_map.get(guid_key(min_g.group(1)), "?") if min_g else "?"
                    max_key = standing_map.get(guid_key(max_g.group(1)), "?") if max_g else "?"

                    min_display = standing_display.get(min_key, min_key)
                    max_display = standing_display.get(max_key, max_key)

                    rep_reqs.append({
                        "scope": scope_key,
                        "minRank": min_display,
                        "maxRank": max_display,
                    })

                # Mission flow — detect phases from variable names
                phase_patterns = [
                    ("DefendLocationWrapper_EnemyShips", "Defend Location"),
                    ("DefendEntities_AttackingShips", "Defend Entities"),
                    ("EscortShipToLandingArea_InitialEnemies", "Escort to LZ"),
                    ("EscortShipToLandingArea_EscortReinforcementsWave", "  + Reinforcement Waves"),
                    ("EscortShipFromLandingArea_InitialEnemies", "Escort from LZ"),
                    ("EscortShipFromLandingArea_EscortReinforcementsWave", "  + Reinforcement Waves"),
                    ("EscortShipFromLandingArea_InterdictionShips", "  + Interdiction"),
                    ("SearchAndDestroy_MissionLocation", "Search & Destroy"),
                    ("SearchAndDestroy_Reinforcements", "  + Reinforcements"),
                    ("SupportAttackedShip", "Defend Attacked Ship"),
                    ("KillShip_MissionTargets", "Kill Targets"),
                    ("InvisibleTimer_MissionTargets", "Timed Encounter"),
                    ("WaveShips", "Wave Attack"),
                    ("AmbushTime", "Ambush"),
                    ("TargetSpawnDescriptions", "  + Target Ships"),
                    ("EnableAlliedReinforcements", "  + Allied Support"),
                    ("MissionTargets", "Destroy Targets"),
                    ("BP_SpawnTarget", "Eliminate Target"),
                    ("BP_SpawnDescriptions_Wave1", "FPS Wave 1"),
                    ("BP_SpawnDescriptions_Wave2", "FPS Wave 2"),
                    ("BP_SpawnDescriptions_Wave3", "FPS Wave 3"),
                    ("BP_SpawnDescriptions_PreBossWave", "FPS Boss Wave"),
                    ("NumberOfWaves", "Multi-Wave Defense"),
                    ("DefendingShips", "Defend Cargo"),
                    ("TargetComponents", "Investigation"),
                    ("ExistingEntitiesToFind_BP", "Find & Destroy Targets"),
                    ("ShipsToSpawn_BP", "  + Enemy Ship Spawns"),
                    ("OverrideTurretHosility_BP", "  + Hostile Turrets"),
                    ("EntitySpawnDescriptions_BP", "Eliminate Spawned Enemies"),
                    ("BP_SpawnDescriptions", "FPS Combat"),
                ]
                flow = []
                seen = set()
                for pattern, label in phase_patterns:
                    if pattern in body and label not in seen:
                        flow.append(label)
                        seen.add(label)

                # Cooldown & time limit (may be on attrs or in body)
                combined = attrs + body
                personal_cd = re.search(r'personalCooldownTime="([^"]+)"', combined)
                abandoned_cd = re.search(r'abandonedCooldownTime="([^"]+)"', combined)
                time_limit = re.search(r'timeToComplete="([^"]+)"', combined)

                entry = {
                    "className": debug_name,
                    "title": title,
                    "category": "Contract",
                    "generator": gen_name,
                    "reward": 0,
                    "currency": "UEC",
                    "lawful": True,
                    "difficulty": -1,
                    "maxPlayers": 1,
                    "canShare": False,
                }
                if personal_cd:
                    entry["cooldownMin"] = int(float(personal_cd.group(1)))
                if abandoned_cd:
                    entry["abandonCooldownMin"] = int(float(abandoned_cd.group(1)))
                if time_limit:
                    entry["timeLimitMin"] = int(float(time_limit.group(1)))
                if flow:
                    entry["missionFlow"] = flow
                if desc:
                    entry["description"] = desc
                if rep_reqs:
                    entry["repRequirements"] = rep_reqs
                system = infer_system(debug_name)
                if system:
                    entry["system"] = system
                activity = infer_activity(debug_name, gen_name)
                if activity:
                    entry["activity"] = activity
                # Blueprint pool rewards — resolve to item names
                bp_guids = re.findall(r'blueprintPool="([^"]+)"', body)
                all_items = []
                seen_pools = set()
                for bg in bp_guids:
                    pool_name = bp_pool_map.get(guid_key(bg))
                    if pool_name and pool_name not in seen_pools:
                        seen_pools.add(pool_name)
                        items = bp_pool_items.get(pool_name, [])
                        for item in items:
                            if item not in all_items:
                                all_items.append(item)
                if all_items:
                    entry["blueprintRewards"] = all_items
                return entry

            def _apply_gen_cooldown(entry):
                """Apply generator-level cooldown if entry doesn't have its own."""
                if gen_cooldown and "cooldownMin" not in entry:
                    entry["cooldownMin"] = gen_cooldown
                if gen_abandon_cooldown and "abandonCooldownMin" not in entry:
                    entry["abandonCooldownMin"] = gen_abandon_cooldown

            # Parse top-level Contracts
            for cm in re.finditer(r'<Contract\s([^>]+)>(.*?)</Contract>', txt, re.S):
                entry = parse_contract_element(cm.group(1), cm.group(2), gen_name, gen_title)
                if entry:
                    _apply_gen_cooldown(entry)
                    contracts.append(entry)
                    contract_title = entry["title"]

                    # Parse nested SubContracts
                    for sm in re.finditer(r'<SubContract\s([^>]+)>(.*?)</SubContract>', cm.group(2), re.S):
                        sub = parse_contract_element(sm.group(1), sm.group(2), gen_name, contract_title)
                        if sub and sub["title"] != contract_title:
                            _apply_gen_cooldown(sub)
                            contracts.append(sub)

                    # Parse nested CareerContracts
                    for cc in re.finditer(r'<CareerContract\s([^>]+)>(.*?)</CareerContract>', cm.group(2), re.S):
                        career = parse_contract_element(cc.group(1), cc.group(2), gen_name, contract_title)
                        if career:
                            contracts.append(career)

            # Parse top-level CareerContracts (some files have them outside Contract elements)
            # Only if not already inside a Contract
            top_career = re.finditer(r'<CareerContract\s([^>]+)>(.*?)</CareerContract>', txt, re.S)
            contract_spans = [(m.start(), m.end()) for m in re.finditer(r'<Contract\s.*?</Contract>', txt, re.S)]
            for cc in top_career:
                inside = any(s <= cc.start() and cc.end() <= e for s, e in contract_spans)
                if not inside:
                    career = parse_contract_element(cc.group(1), cc.group(2), gen_name)
                    if career:
                        contracts.append(career)

    # Post-process: fix titles for known contract patterns
    TITLE_OVERRIDES = {
        "adagio_generator": ("Claim #[Claim]: [Ship] Salvage Rights", "Adagio Holdings"),
    }
    fixed_titles = 0
    for c in contracts:
        override = TITLE_OVERRIDES.get(c.get("generator", ""))
        if override and (c["title"].startswith("Adaigo_") or c["title"] == "[Contractor]"):
            c["title"] = override[0]
            c["giver"] = override[1]
            c["activity"] = c.get("activity") or "Salvage"
            fixed_titles += 1

    print(f"  Parsed {len(contracts)} contracts ({sum(1 for c in contracts if c.get('repRequirements'))} with rep requirements, {fixed_titles} titles fixed)")

    # Missions (from mission broker system)
    print("\n[6/7] Parsing missions...")
    mission_dir = FORGE_DIR / "missionbroker" / "pu_missions"
    missions = []
    skipped = 0
    for xml_file in mission_dir.rglob("*.xml.xml"):
        result = parse_mission(xml_file, loc, scope_map)
        if result:
            missions.append(result)
        else:
            skipped += 1

    # Filter out zero-reward internal missions, clean up template vars
    before = len(missions)
    missions = [m for m in missions if m.get("reward", 0) > 0]

    # Clean up template variables in titles/givers for display
    for m in missions:
        if "~mission(" in m.get("title", ""):
            m["title"] = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', m["title"])
        if m.get("giver") and "~mission(" in m["giver"]:
            m["giver"] = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', m["giver"])
        if m.get("description") and "~mission(" in m["description"]:
            m["description"] = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', m["description"])

    # Deduplicate: same title + category + reward = same mission (different locations)
    # Mark duplicates with "multiSystem" flag
    seen = {}
    unique = []
    for m in missions:
        key = (m["title"], m["category"], m["reward"])
        if key not in seen:
            seen[key] = m
            unique.append(m)
        else:
            seen[key]["multiSystem"] = True
            # Merge any rep scopes from the duplicate
            if m.get("repScopes"):
                existing = seen[key].get("repScopes", [])
                for s in m["repScopes"]:
                    if s not in existing:
                        existing.append(s)
                seen[key]["repScopes"] = existing
    missions = unique
    multi = sum(1 for m in missions if m.get("multiSystem"))
    print(f"  Filtered: {before} -> {len(missions)} unique ({multi} available in multiple systems)")

    # Merge contracts into missions list
    all_entries = missions + contracts

    # Sort by category then reward
    all_entries.sort(key=lambda m: (m["category"], -(m.get("reward", 0))))

    # Stats
    categories = {}
    for m in all_entries:
        categories[m["category"]] = categories.get(m["category"], 0) + 1

    output = {
        "meta": {
            "totalMissions": len(missions),
            "totalContracts": len(contracts),
            "totalEntries": len(all_entries),
            "categories": categories,
            "missionGivers": len(givers),
        },
        "missionGivers": givers,
        "reputationRanks": standing_display,
        "missions": all_entries,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size_kb = OUTPUT_FILE.stat().st_size / 1024
    print(f"\n{'=' * 60}")
    print(f"Done!  {OUTPUT_FILE}  ({size_kb:.0f} KB)")
    print(f"  Missions: {len(missions)}  (skipped {skipped})")
    print(f"  Contracts: {len(contracts)}")
    print(f"  Total entries: {len(all_entries)}")
    print(f"  Mission Givers: {len(givers)}")
    print(f"  Categories:")
    for cat, count in sorted(categories.items()):
        print(f"    {cat}: {count}")

    # Copy to app
    if APP_FILE.parent.exists():
        import shutil
        shutil.copy2(OUTPUT_FILE, APP_FILE)
        print(f"\n  Copied to {APP_FILE}")

if __name__ == "__main__":
    main()

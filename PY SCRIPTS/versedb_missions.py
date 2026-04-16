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

import struct
import uuid

_DATA_MODE = os.environ.get("VERSEDB_DATA_MODE", "live")
_DATA_SUFFIX = {"live": "47", "ptu": "48"}.get(_DATA_MODE, "47")
FORGE_DIR = Path(__file__).parent / f"../SC FILES/sc_data_forge_{_DATA_MODE}/libs/foundry/records"
GLOBAL_INI = Path(__file__).parent / f"../SC FILES/sc_data_xml_{_DATA_MODE}/Data/Localization/english/global.ini"
DCB_FILE = Path(__file__).parent / f"../SC FILES/sc_data_{_DATA_SUFFIX}/Data/Game2.dcb"
OUTPUT_FILE = Path(__file__).parent / "versedb_missions.json"
APP_FILE = Path(__file__).parent / "../app/public" / _DATA_MODE / "versedb_missions.json"

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

_NARR_CLS_RE = re.compile(
    r"^(?P<faction>[A-Za-z]+)_(?P<genre>BlackBoxRecovery|RecoverItem)_"
    r"(?P<system>Stanton|Nyx|Pyro)_(?P<rest>.+)$"
)
_NARR_DIFF = {"Intro": "Intro", "VeryEasy": "VE", "Easy": "E", "Medium": "M",
              "Hard": "H", "VeryHard": "VH", "Super": "S"}
_NARR_GENRE = {"BlackBoxRecovery": "blackbox", "RecoverItem": "RecoverItem_Generic"}
_NARR_EM_RE = re.compile(r"</?EM\d+>")
_NARR_MISSION_RE = re.compile(r'~mission\(([^|)]+)(?:\|[^)]+)?\)')

def resolve_procedural_narrative(class_name, loc):
    """For contractor-generator contracts whose title/description stay as
    runtime templates, compose the faction-specific localization key from
    the className and pull the concrete narrative. Returns (title, desc)
    or (None, None). Covers BitZeros/Hockrow/DeadSaints generators."""
    m = _NARR_CLS_RE.match(class_name)
    if not m: return None, None
    fac = m.group("faction"); gen = m.group("genre"); rest = m.group("rest")
    genre = _NARR_GENRE[gen]
    if gen == "BlackBoxRecovery":
        if rest not in _NARR_DIFF: return None, None
        code = _NARR_DIFF[rest]
        t = loc.get(f"{fac}_{genre}_{code}_title_001".lower(), "")
        d = loc.get(f"{fac}_{genre}_{code}_desc_001".lower(), "")
    else:  # RecoverItem — deterministic variant 001 from the 001-003 pool
        t = loc.get(f"{fac}_{genre}_title_001".lower(), "")
        d = loc.get(f"{fac}_{genre}_desc_001".lower(), "")
    def clean(s):
        if not s: return ""
        s = s.replace("\\n", "\n").strip()
        s = _NARR_EM_RE.sub("", s)
        s = _NARR_MISSION_RE.sub(lambda mm: f"[{mm.group(1)}]", s)
        return s
    return (clean(t) or None, clean(d) or None)

def build_contractor_profiles(loc, contracts):
    """Group global.ini {key}_RepUI_* fields into profile dicts, then map
    them to the contractor display-names actually used by the given
    contracts list. Returns dict keyed by contractor name."""
    import collections as _c
    import re as _re
    groups = _c.defaultdict(dict)
    for k, v in loc.items():
        if "_repui_" not in k: continue
        fac, _, field = k.partition("_repui_")
        groups[fac][field] = v
    profiles = {}
    for fac, fields in groups.items():
        name = fields.get("displayname") or fields.get("name") or ""
        if name.startswith("@") or not name:
            continue
        p = {"name": name.replace("\\n", "\n").strip()}
        pairs = [
            ("description", "description"), ("biography", "description"),
            ("area", "area"), ("location", "area"),
            ("focus", "focus"), ("occupation", "focus"),
            ("founded", "founded"),
            ("hq", "hq"), ("headquarters", "hq"), ("headquaters", "hq"),
            ("leadership", "leadership"), ("association", "association"),
        ]
        for src, dst in pairs:
            v = fields.get(src)
            if v and not v.startswith("@") and dst not in p:
                p[dst] = v.replace("\\n", "\n").strip()
        profiles[fac] = p
    # contractor-name → profile
    ALIASES = {"intersec": "intersecdefensesolutions", "blacjacsecurity": "blacjac"}
    norm = lambda s: _re.sub(r"[^a-z0-9]", "", s.lower())
    by_name = {norm(p["name"]): p for p in profiles.values()}
    by_key  = {norm(k): p for k, p in profiles.items()}
    contractors = {c["contractor"] for c in contracts if c.get("contractor")}
    out = {}
    for name in contractors:
        n = norm(name)
        p = by_name.get(n) or by_key.get(ALIASES.get(n, "")) or by_key.get(n)
        if p: out[name] = p
    return dict(sorted(out.items()))

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

def build_entity_guid_map(dcb_path):
    """
    Build a GUID → className map from the DCB entity table.
    Entry layout: GUID(16) + u32×4, where u32[2] (offset +24) is a text offset
    to the entity's forge path.
    """
    if not dcb_path.exists():
        print(f"  WARNING: DCB not found at {dcb_path}")
        return {}
    sys.path.insert(0, str(Path(__file__).parent))
    from versedb_extract import _dcb_parse_header
    with open(dcb_path, 'rb') as f:
        d = f.read()
    h = _dcb_parse_header(d)
    text_start = h['text_start']
    rec_start = h['rec_start']
    n_records = h['n_records']

    def read_text(offset):
        try:
            pos = text_start + offset
            end = d.index(b'\x00', pos, pos + 500)
            s = d[pos:end].decode('utf-8', errors='replace')
            return s if len(s) > 3 and s.isprintable() else None
        except:
            return None

    guid_map = {}
    for i in range(n_records):
        entry_off = rec_start + i * 32
        if entry_off + 32 > len(d):
            break
        # Entry layout: u32(+0) + u32_path(+4) + u32(+8) + GUID(+12) + u32(+28)
        path_off = struct.unpack_from('<I', d, entry_off + 4)[0]
        path = read_text(path_off)
        if not path or 'spaceships/' not in path:
            continue
        guid_bytes = d[entry_off + 12:entry_off + 28]
        try:
            g = str(uuid.UUID(bytes_le=guid_bytes))
        except:
            continue
        cn = path.split('/')[-1].replace('.xml', '')
        guid_map[g] = cn
    return guid_map


def parse_ai_wave_pools(forge_dir, guid_map, loc):
    """
    Parse AI wave collection files to build difficulty-tier → ship list maps.
    Returns dict: wave_name → list of player-facing ship names.
    """
    wave_dir = forge_dir / "aiwavecollection" / "pu" / "mission" / "ai_bounty"
    if not wave_dir.exists():
        return {}

    # AI variant suffix patterns to strip for display
    _AI_SUFFIXES = re.compile(
        r'_pu_ai_\w+|_ai_\w+|_unmanned_\w+|_def$|_scattergun$|_ea_ai_\w+|'
        r'_collector_\w+|_military$|_stealth$|_tier_\d+',
        re.I
    )
    # Filter out event/non-combat ships that shouldn't appear in enemy pools
    _POOL_BLACKLIST = {'rsi_bengal', 'javelin', 'idris', 'reclaimer', 'hull_c', 'hull_d', 'hull_e'}

    # Map className to display name using localization
    def ship_display_name(cn):
        # Strip AI suffixes
        clean = _AI_SUFFIXES.sub('', cn)
        # Try localization
        loc_key = f"vehicle_name{clean.lower()}"
        name = loc.get(loc_key)
        if name:
            return name
        # Fallback: title-case the className
        return clean.replace('_', ' ').title()

    pools = {}
    for f in sorted(wave_dir.glob("*.xml.xml")):
        try:
            root = ET.parse(f).getroot()
        except:
            continue
        wave_name = f.stem.replace(".xml", "")
        ships = set()
        for member in root.findall(".//AIWaveMember"):
            g = member.get("entityClassDefinition", "")
            cn = guid_map.get(g)
            if cn:
                clean = _AI_SUFFIXES.sub('', cn).lower()
                if any(bl in clean for bl in _POOL_BLACKLIST):
                    continue
                display = ship_display_name(cn)
                ships.add(display)
        if ships:
            pools[wave_name] = sorted(ships)
    return pools


def match_enemy_pool(class_name, wave_pools):
    """
    Match a bounty mission to its enemy pool based on className patterns.
    Returns a list of ship names or None.
    """
    cn = class_name.lower()

    # Arlington gang special case
    if "family" in cn:
        return wave_pools.get("bounty_family_goons")

    # Infer difficulty and system from className
    difficulty = ""
    for suffix in ["_super", "_vhard", "_veryhard", "_hard", "_medium", "_easy", "_veasy", "_veryeasy", "_intro"]:
        if suffix in cn:
            difficulty = suffix.strip("_")
            break

    system = ""
    for s in ["stanton1", "stanton2", "stanton3", "stanton4", "pyro1", "pyro2", "pyro3", "pyro4", "pyro5", "nyx"]:
        if s in cn:
            system = s
            break

    # Map difficulty to wave name patterns
    diff_map = {
        "intro": "easy", "veasy": "easy", "veryeasy": "easy", "easy": "easy",
        "medium": "medium", "hard": "hard", "vhard": "hard",
        "veryhard": "hard", "super": "hard",
    }
    wave_diff = diff_map.get(difficulty, "")
    if not wave_diff:
        return None

    # Try system-specific wave first, then generic
    candidates = []
    if system:
        candidates.append(f"bounty_wave_{wave_diff}_{system}")
    candidates.append(f"bounty_wave_{wave_diff}_stanton")

    # For target ships, also check target-specific waves
    if "group" in cn:
        if system:
            candidates.insert(0, f"bounty_wave_{wave_diff}_{system}_target")
        candidates.insert(1, f"bounty_wave_{wave_diff}_stanton_target")

    for candidate in candidates:
        if candidate in wave_pools:
            return wave_pools[candidate]
    return None


def parse_mission(xml_path, loc, scope_map=None, rep_req_rank_map=None, standing_by_guid=None):
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

    # Reputation rank. StarBreaker inlines the rep-requirements struct inside
    # <reputationRequirements>; read its SReputationMissionGiverRequirementParams
    # 'standing' GUID directly and look up the standing name. Legacy unp4k used
    # an attribute ref resolved by a byte-scan map (rep_req_rank_map).
    rep_rank = None
    inline_giver = root.find(".//reputationRequirements//SReputationMissionGiverRequirementParams")
    if inline_giver is not None and standing_by_guid:
        standing_g = (inline_giver.get("standing") or "").strip()
        if standing_g and standing_g != "00000000-0000-0000-0000-000000000000":
            rep_rank = standing_by_guid.get(guid_key(standing_g))
    if rep_rank is None and rep_req_rank_map:
        rep_req_attr = root.get("reputationRequirements", "")
        if rep_req_attr:
            req_m = re.search(r'\[([0-9A-Fa-f]+)\]', rep_req_attr)
            if req_m:
                rep_rank = rep_req_rank_map.get(req_m.group(1).upper())

    category = infer_category(str(xml_path), class_name)

    # Chain: mission's own GUID and required mission GUIDs.
    # StarBreaker uses <Reference value="GUID"/>; unp4k used <Reference>GUID</Reference>.
    mission_ref = root.get("__ref", "")
    req_refs = []
    for ref in root.findall(".//requiredMissions/Reference"):
        g = ref.get("value") or ref.text
        if g: req_refs.append(g)

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

    if mission_ref:
        result["_ref"] = mission_ref
    if req_refs:
        result["_requiredRefs"] = req_refs

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
    if rep_rank:
        # Determine scope from repScopes if available
        scope = rep_scopes[0] if rep_scopes else "hauling"
        result["repRequirements"] = [{"scope": scope, "minRank": rep_rank, "maxRank": rep_rank}]
    system = infer_system(class_name)
    if system:
        result["system"] = system
    activity = infer_activity(class_name)
    if activity:
        result["activity"] = activity

    # Contractor and danger level (inferred from className patterns)
    contractor = _resolve_contractor(class_name, loc)
    if contractor:
        result["contractor"] = contractor
    danger = _infer_danger(class_name)
    if danger:
        result["danger"] = danger

    return result


# ── Contractor resolution from className patterns + localization ──

_CONTRACTOR_PATTERNS = {
    "hursec":              "Hurston Security",
    "crusec":              "Crusader Security",
    "blacjac":             "BlacJac Security",
    "northrock":           "Northrock Service Group",
    "eckhart":             "Eckhart Security",
    "headhunter":          "Headhunters",
    "bountyhuntersguild":  "Bounty Hunters Guild",
    "bhg_":                "Bounty Hunters Guild",
    "mtpro":               "MT Protection Services",
    "thecouncil":          "The Council",
    "xenothreat":          "XenoThreat",
    "roughandready":       "Rough & Ready",
    "hexpenetrator":       "Hex Penetrator",
    "intersec":            "InterSec",
    "pve_family":          "Arlington Gang",
    "vaughn":              "Vaughn",
    "pacheco":             "Tecia Pacheco",
    "ling_":               "Ling Family Hauling",
}

def _resolve_contractor(class_name, loc):
    cn = class_name.lower()
    for pattern, display in _CONTRACTOR_PATTERNS.items():
        if pattern in cn:
            return display
    return None

_DANGER_KEYWORDS = [
    # Order matters — check longer patterns first
    ("_veryhard", "Very High"),
    ("_veryeasy", "Very Low"),
    ("_super", "Extreme"),
    ("_intro", "Low"),
    ("_easy", "Low"),
    ("_medium", "Medium"),
    ("_hard", "High"),
    ("_vhard", "Very High"),
]

def _infer_danger(class_name):
    cn = class_name.lower()
    for suffix, level in _DANGER_KEYWORDS:
        if suffix in cn:
            return level
    return None

# ── Estimated reward calculation from ContractDifficulty ──

# Per-score UEC rate table (reverse-engineered from known payouts).
# Formula: payout ≈ round_250(timeToComplete × Σ(weight_i × V(score_i)))
# Geometric progression ~1.36× per level, anchored at V(4)=3660.
_SCORE_VALUES = {
    1: 1450, 2: 1970, 3: 2645, 4: 3660, 5: 4751, 6: 6665, 7: 9005,
}

def build_contract_difficulty_table(dcb_path):
    """
    Read ContractDifficulty and ContractDifficultyProfile from the DCB.
    Returns a dict: hex_index (e.g. '0838') → {profile_weights, scores, score_values}.
    """
    if not dcb_path.exists():
        return {}
    sys.path.insert(0, str(Path(__file__).parent))
    from versedb_extract import _dcb_parse_header
    with open(dcb_path, 'rb') as f:
        d = f.read()
    h = _dcb_parse_header(d)
    blob_text = h.get('blob_text')
    if not blob_text:
        return {}

    # Read profiles (ContractDifficultyProfile, struct index from name lookup)
    profile_idx = h['struct_by_name'].get('ContractDifficultyProfile')
    difficulty_idx = h['struct_by_name'].get('ContractDifficulty')
    if profile_idx is None or difficulty_idx is None:
        return {}

    # Profile data: rec_size=16, 4 floats (mechSkill, mentalLoad, riskOfLoss, gameKnowledge weights)
    sdp_info = h['struct_data'].get(profile_idx)
    profiles = {}
    if sdp_info:
        for i in range(sdp_info[1]):
            off = sdp_info[0] + i * 16
            profiles[i] = struct.unpack_from('<4f', d, off)

    # Difficulty data: rec_size=36
    # Layout: profile_index(u32) + GUID(16) + 4×score_text_offset(u32)
    sd_info = h['struct_data'].get(difficulty_idx)
    if not sd_info:
        return {}
    data_off, count = sd_info

    table = {}
    for i in range(count):
        off = data_off + i * 36
        pi = struct.unpack_from('<I', d, off)[0]
        if pi >= len(profiles) and pi != 0xFFFFFFFF:
            continue
        weights = profiles.get(pi, (0.25, 0.25, 0.25, 0.25))
        scores = []
        for j in range(4):
            val = struct.unpack_from('<I', d, off + 20 + j * 4)[0]
            try:
                name = blob_text(val)
                score = int(name.rsplit('_', 1)[-1])
            except Exception:
                score = 4  # fallback
            scores.append(score)

        hex_key = f"{i:04X}"
        table[hex_key] = {
            "weights": weights,
            "scores": scores,
        }
    return table


def estimate_reward(difficulty_table, diff_ref, time_to_complete):
    """
    Estimate UEC payout from a ContractDifficulty reference and timeToComplete.
    Legacy unp4k path — StarBreaker callers use estimate_reward_inline below.
    Returns (estimated_reward, True) or (0, False) if can't compute.
    """
    if not diff_ref or not time_to_complete or diff_ref == 'null':
        return 0, False
    # Extract hex index from "ContractDifficulty[XXXX]"
    m = re.match(r'ContractDifficulty\[([0-9A-Fa-f]+)\]', diff_ref)
    if not m:
        return 0, False
    hex_key = m.group(1).upper()
    entry = difficulty_table.get(hex_key)
    if not entry:
        return 0, False

    weights = entry['weights']
    scores = entry['scores']
    try:
        t = float(time_to_complete)
    except (ValueError, TypeError):
        return 0, False
    if t <= 0:
        return 0, False

    weighted_value = sum(w * _SCORE_VALUES.get(s, 3660) for w, s in zip(weights, scores))
    raw = t * weighted_value
    estimated = round(raw / 250) * 250
    return max(estimated, 250), True


def _score_from_label(label):
    """ContractDifficulty attributes look like 'Easy_PvE_only_action_3' —
    the trailing integer after the last underscore is the difficulty score."""
    if not label: return 0
    try: return int(label.rsplit('_', 1)[-1])
    except ValueError: return 0


def estimate_reward_inline(profile_by_guid, profile_guid, score_labels, time_to_complete):
    """StarBreaker path: difficulty profile and per-axis scores come inline
    from the contract XML. profile_by_guid maps profile GUID → 4-tuple of
    weights (mechanicalSkill, mentalLoad, riskOfLoss, gameKnowledge).
    score_labels is a 4-tuple of raw label strings from the ContractDifficulty
    element. Returns (estimated_reward, True) or (0, False)."""
    if not profile_guid or profile_guid == '00000000-0000-0000-0000-000000000000':
        return 0, False
    weights = profile_by_guid.get(guid_key(profile_guid))
    if not weights: return 0, False
    try: t = float(time_to_complete)
    except (ValueError, TypeError): return 0, False
    if t <= 0: return 0, False
    scores = [_score_from_label(s) for s in score_labels]
    weighted_value = sum(w * _SCORE_VALUES.get(s, 3660) for w, s in zip(weights, scores))
    estimated = round(t * weighted_value / 250) * 250
    return max(estimated, 250), True

def main():
    print("=" * 60)
    print("VerseDB Mission Extractor")
    print("=" * 60)

    # Localization
    print("\n[1/4] Loading localization...")
    loc = load_localization(GLOBAL_INI)

    # Entity GUID map + AI wave pools + difficulty table
    print("\n[2/4] Building entity GUID map, enemy pools, and difficulty table...")
    guid_map = build_entity_guid_map(DCB_FILE)
    print(f"  {len(guid_map)} spaceship entity GUIDs mapped")
    wave_pools = parse_ai_wave_pools(FORGE_DIR, guid_map, loc)
    print(f"  {len(wave_pools)} AI wave pools parsed")
    difficulty_table = build_contract_difficulty_table(DCB_FILE)
    print(f"  {len(difficulty_table)} ContractDifficulty entries loaded")

    # Build ContractDifficultyProfile GUID → (4 weights) map from forge XMLs.
    # StarBreaker inlines the profile GUID on each contract's <ContractDifficulty>
    # element so we can resolve reward estimates without byte-scanning DCB.
    profile_by_guid = {}
    profile_dir = FORGE_DIR / "contracts" / "contractdifficultyprofiles"
    if profile_dir.exists():
        for pf in profile_dir.rglob("*.xml.xml"):
            try:
                ptxt = open(pf, encoding="utf-8", errors="replace").read()
                pref = re.search(r'__ref="([^"]+)"', ptxt)
                if not pref: continue
                # Weights are attributes on the profile root element
                wms = re.search(r'mechanicalSkillWeight="([^"]+)"', ptxt)
                wml = re.search(r'mentalLoadWeight="([^"]+)"', ptxt)
                wrl = re.search(r'riskOfLossWeight="([^"]+)"', ptxt)
                wgk = re.search(r'gameKnowledgeWeight="([^"]+)"', ptxt)
                if wms and wml and wrl and wgk:
                    profile_by_guid[guid_key(pref.group(1))] = (
                        float(wms.group(1)), float(wml.group(1)),
                        float(wrl.group(1)), float(wgk.group(1)),
                    )
            except Exception:
                pass
    print(f"  {len(profile_by_guid)} ContractDifficultyProfile XMLs loaded")

    # ── Build standing GUID → display name map (used by both inline and byte-scan paths) ──
    standing_by_guid = {}
    standings_dir = FORGE_DIR / "reputation" / "standings"
    if standings_dir.exists():
        for sf in standings_dir.rglob("*.xml.xml"):
            try:
                stxt = open(sf, encoding="utf-8", errors="replace").read()
                sref = re.search(r'__ref="([^"]+)"', stxt)
                sdisp = re.search(r'displayName="@([^"]+)"', stxt)
                if sref and sdisp:
                    display = loc.get(sdisp.group(1).lower(), sdisp.group(1))
                    standing_by_guid[guid_key(sref.group(1))] = display
            except Exception:
                pass
        print(f"  Standing GUID map: {len(standing_by_guid)} entries")

    # ── DCB binary rank resolution (legacy unp4k format only) ──────────────
    # StarBreaker inlines the struct so parse_mission can read it directly;
    # this block only fires for legacy unp4k output that used [HEX] refs.
    rep_req_rank_map = {}  # hex index string -> rank display name (e.g. "0606" -> "Master")
    if DCB_FILE.exists():
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            from versedb_extract import _dcb_parse_header
            with open(DCB_FILE, 'rb') as f:
                dcb_d = f.read()
            h = _dcb_parse_header(dcb_d)
            _sbn = h["struct_by_name"]
            _sd = h["struct_data"]
            _sdefs = h["struct_defs"]

            req_si = _sbn.get("SReputationMissionRequirementsParams")
            giver_si = _sbn.get("SReputationMissionGiverRequirementParams")

            if req_si is not None and giver_si is not None and req_si in _sd and giver_si in _sd:
                import struct as _st
                req_off, req_cnt = _sd[req_si]
                req_rs = _sdefs[req_si][4]  # 8
                giver_off, giver_cnt = _sd[giver_si]
                giver_rs = _sdefs[giver_si][4]  # 64

                # Calculate strong value array offset
                _p = 4
                _ver = _st.unpack_from("<i", dcb_d, _p)[0]; _p += 4
                if _ver >= 6: _p += 8
                _p += 20
                _counts = [_st.unpack_from("<i", dcb_d, _p + i * 4)[0] for i in range(19)]; _p += 76
                (c_bool, c_i8, c_i16, c_i32, c_i64, c_u8, c_u16, c_u32, c_u64, c_f32,
                 c_f64, c_guid, c_str, c_loc, c_enum, c_strong, c_weak, c_ref, c_enum_opts) = _counts
                va_strong = (h["va_f32"] - c_i8 - c_i16*2 - c_i32*4 - c_i64*8
                             - c_u8 - c_u16*2 - c_u32*4 - c_u64*8 - c_bool
                             + c_bool + c_i8 + c_i16*2 + c_i32*4 + c_i64*8
                             + c_u8 + c_u16*2 + c_u32*4 + c_u64*8
                             + c_f32*4 + c_f64*8 + c_guid*16 + c_str*4 + c_loc*4 + c_enum*4)

                # Resolve each req entry using the pre-built standing_by_guid map
                for ri in range(req_cnt):
                    inst = req_off + ri * req_rs
                    _, strong_idx = _st.unpack_from("<II", dcb_d, inst)
                    if strong_idx >= c_strong:
                        continue
                    s_off = va_strong + strong_idx * 8
                    s_si = _st.unpack_from("<H", dcb_d, s_off)[0]
                    s_ii = _st.unpack_from("<I", dcb_d, s_off + 4)[0]
                    if s_si != giver_si or s_ii >= giver_cnt:
                        continue
                    g_inst = giver_off + s_ii * giver_rs
                    guid_hex = dcb_d[g_inst + 48:g_inst + 64].hex()
                    rank = standing_by_guid.get(guid_key(guid_hex))
                    if rank:
                        rep_req_rank_map[format(ri, "04X")] = rank

                print(f"  DCB rank resolution: {len(rep_req_rank_map)} mission requirement → rank mappings")
            del dcb_d
        except Exception as e:
            print(f"  WARNING: DCB rank resolution failed: {e}")

    # Mission givers
    print("\n[3/8] Parsing mission givers...")
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

    # Reputation reward amounts (success/failure rep values)
    rep_reward_dir = FORGE_DIR / "reputation" / "rewards" / "missionrewards_reputation"
    rep_reward_amounts = {}  # sorted GUID → int amount
    if rep_reward_dir.exists():
        for rf in rep_reward_dir.rglob("*.xml.xml"):
            try:
                rtxt = open(rf, encoding="utf-8").read()
                rref = re.search(r'__ref="([^"]+)"', rtxt)
                ramt = re.search(r'reputationAmount="([^"]+)"', rtxt)
                if rref and ramt:
                    rep_reward_amounts[guid_key(rref.group(1))] = int(ramt.group(1))
            except Exception:
                pass
    print(f"  Loaded {len(rep_reward_amounts)} reputation reward amounts")

    # Blueprint pools
    print("\n[4/7] Building blueprint pool map...")
    bp_pool_dir = FORGE_DIR / "crafting" / "blueprintrewards" / "blueprintmissionpools"
    bp_pool_map = {}  # sorted GUID → pool name
    bp_pool_items = {}  # pool name → [resolved item names]
    if bp_pool_dir.exists():
        # Build scitem displayName lookup: class_name → localized display name
        # Used as fallback when direct loc key lookup fails for blueprints
        scitem_display = {}  # class_name → display name
        scitem_base = FORGE_DIR / "entities" / "scitem"
        if scitem_base.exists():
            for sf in scitem_base.rglob("*.xml.xml"):
                try:
                    stxt = open(sf, encoding="utf-8").read()
                    dm = re.search(r'SCItemPurchasableParams[^>]*displayName="@([^"]+)"', stxt)
                    if dm:
                        loc_key = dm.group(1).lower()
                        resolved = loc.get(loc_key, "")
                        if resolved and resolved != "@LOC_UNINITIALIZED":
                            cls = sf.stem.replace(".xml", "")
                            scitem_display[cls] = resolved
                except Exception:
                    pass
            print(f"  Built scitem display name cache: {len(scitem_display)} items")

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
                                   loc.get(f"item_name_{raw}".lower(), "") or
                                   scitem_display.get(raw, ""))
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

            # Extract handler-level reputationScope as fallback for contracts
            gen_scope_m = re.search(r'ContractGeneratorHandler_Career[^>]*reputationScope="([^"]+)"', txt)
            gen_scope = scope_map.get(guid_key(gen_scope_m.group(1)), "") if gen_scope_m else ""
            # Clean up scope name: "reputationscope_assassination" -> "assassination"
            if gen_scope.startswith("reputationscope_"):
                gen_scope = gen_scope.replace("reputationscope_", "")

            def parse_contract_element(attrs, body, gen_name, parent_title=""):
                """Parse a Contract, SubContract, or CareerContract element."""
                if 'notForRelease="1"' in attrs:
                    return None

                debug = re.search(r'debugName="([^"]+)"', attrs)
                debug_name = debug.group(1) if debug else gen_name

                title_m = re.search(r'param="Title"\s+value="([^"]+)"', body)
                desc_m = re.search(r'param="Description"\s+value="([^"]+)"', body)
                title = loc_lookup(loc, title_m.group(1)) if title_m else ""
                title_loc_key = title_m.group(1).lstrip("@").lower() if title_m else ""
                desc = loc_lookup(loc, desc_m.group(1)) if desc_m else ""

                # Try debug-name-based localization lookup (strip suffixes like -Stanton4)
                if not title:
                    base_name = debug_name.split("-")[0] if "-" in debug_name else debug_name
                    for suffix in ["_title", "_title,p", "_title,P"]:
                        title = loc.get((base_name + suffix).lower(), "")
                        if title:
                            title_loc_key = (base_name + suffix).lower()
                            break
                        if title:
                            break
                if not desc:
                    base_name = debug_name.split("-")[0] if "-" in debug_name else debug_name
                    desc = loc.get((base_name + "_desc").lower(), "")

                # Clean template vars or fall back to parent title or debug name
                if not title:
                    title = parent_title or debug_name
                if "~mission(" in title:
                    title = re.sub(r'~mission\(([^|)]+)(?:\|[^)]+)?\)', r'[\1]', title)

                # Reputation prerequisites — from ContractPrerequisite_Reputation elements
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

                # Also check minStanding/maxStanding on the element itself (CareerContract)
                if not rep_reqs:
                    attr_min = re.search(r'minStanding="([^"]+)"', attrs)
                    attr_max = re.search(r'maxStanding="([^"]+)"', attrs)
                    attr_scope = re.search(r'reputationScope="([^"]+)"', attrs)
                    if attr_min and attr_max:
                        scope_raw = scope_map.get(guid_key(attr_scope.group(1)), "") if attr_scope else ""
                        if scope_raw.startswith("reputationscope_"):
                            scope_raw = scope_raw.replace("reputationscope_", "")
                        scope_key = scope_raw or gen_scope or "?"
                        min_key = standing_map.get(guid_key(attr_min.group(1)), "?")
                        max_key = standing_map.get(guid_key(attr_max.group(1)), "?")
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

                # Reputation results — extract success/failure rep amounts
                # Success: first Boolean=1, Failure: third Boolean=1
                rep_success = 0
                rep_failure = 0
                for cr_m in re.finditer(
                    r'<ContractResult_LegacyReputation>(.*?)</ContractResult_LegacyReputation>',
                    body, re.S
                ):
                    cr_body = cr_m.group(1)
                    booleans = re.findall(r'<Boolean>(\d)</Boolean>', cr_body)
                    reward_m = re.search(r'reward="([^"]+)"', cr_body)
                    if reward_m and len(booleans) >= 3:
                        amt = rep_reward_amounts.get(guid_key(reward_m.group(1)), 0)
                        if booleans[0] == '1':  # success
                            rep_success = amt
                        elif booleans[2] == '1':  # failure
                            rep_failure = amt

                # Extract rep scopes from contractResultReputationAmounts
                result_scopes = set()
                for rs_m in re.finditer(r'reputationScope="([^"]+)"', body):
                    scope_name = scope_map.get(guid_key(rs_m.group(1)), "")
                    if scope_name and scope_name.startswith("reputationscope_"):
                        scope_name = scope_name.replace("reputationscope_", "")
                    if scope_name:
                        result_scopes.add(scope_name)
                # Also include handler-level scope
                if gen_scope:
                    result_scopes.add(gen_scope)

                # Chain: required completion tags (prerequisites). Accept both
                # StarBreaker <Reference value="GUID"/> and legacy <Reference>GUID</Reference>.
                req_tags_block = re.search(
                    r'<requiredCompletedContractTags>(.*?)</requiredCompletedContractTags>',
                    body, re.S
                )
                req_tags = []
                if req_tags_block:
                    inner = req_tags_block.group(1)
                    req_tags = re.findall(r'<Reference\s+value="([^"]+)"\s*/?>', inner)
                    if not req_tags:
                        req_tags = re.findall(r'<Reference>([^<]+)</Reference>', inner)
                # Chain: granted completion tags (on success)
                grant_tags = re.findall(r'ContractResult_CompletionTag[^>]*tag="([^"]+)"', body)
                # onceOnly flag
                once_only = 'onceOnly="1"' in attrs

                # Estimated reward from ContractDifficulty. StarBreaker inlines
                # the profile GUID + per-axis score labels on a <ContractDifficulty>
                # child element; legacy unp4k used a difficulty="ContractDifficulty[HEX]"
                # attribute resolved via difficulty_table.
                combined = attrs + body
                time_m2 = re.search(r'timeToComplete="([^"]+)"', combined)
                ttc = time_m2.group(1) if time_m2 else None
                est_reward, is_estimated = 0, False
                # Inline-first
                inline_cd = re.search(
                    r'<ContractDifficulty\s+difficultyProfile="([^"]+)"\s+'
                    r'mechanicalSkill="([^"]*)"\s+mentalLoad="([^"]*)"\s+'
                    r'riskOfLoss="([^"]*)"\s+gameKnowledge="([^"]*)"',
                    combined
                )
                if inline_cd:
                    est_reward, is_estimated = estimate_reward_inline(
                        profile_by_guid,
                        inline_cd.group(1),
                        (inline_cd.group(2), inline_cd.group(3),
                         inline_cd.group(4), inline_cd.group(5)),
                        ttc,
                    )
                if not is_estimated:
                    # Legacy fallback
                    diff_ref_m = re.search(r'difficulty="(ContractDifficulty\[[^\]]+\])"', combined)
                    diff_ref = diff_ref_m.group(1) if diff_ref_m else None
                    est_reward, is_estimated = estimate_reward(difficulty_table, diff_ref, ttc)

                entry = {
                    "className": debug_name,
                    "title": title,
                    "category": "Contract",
                    "generator": gen_name,
                    "reward": est_reward if is_estimated else 0,
                    "currency": "UEC",
                    "lawful": True,
                    "difficulty": -1,
                    "maxPlayers": 1,
                    "canShare": False,
                }
                if is_estimated:
                    entry["rewardEstimated"] = True
                if req_tags:
                    entry["_reqTags"] = req_tags
                if grant_tags:
                    entry["_grantTags"] = grant_tags
                if once_only:
                    entry["onceOnly"] = True
                # Resolve contractor early so scope display can use it
                contractor = _resolve_contractor(debug_name, loc) or _resolve_contractor(gen_name, loc) or ""
                if contractor:
                    entry["contractor"] = contractor
                if result_scopes:
                    # Map scope names to readable display names
                    SCOPE_DISPLAY = {
                        "factionreputationscope": None,  # handled below with contractor
                        "bounty": "Bounty Hunting",
                        "bounty_bountyhuntersguild": "Bounty Hunting (Guild)",
                        "shipcombat_headhunters": "Ship Combat (Headhunters)",
                        "racing_shiptimetrial": "Racing (Ship)",
                        "handyman_citizensforpyro": "Hired Muscle",
                    }
                    display_scopes = []
                    for s in sorted(result_scopes):
                        if s == "factionreputationscope" and contractor:
                            display_scopes.append(contractor)
                        elif s in SCOPE_DISPLAY and SCOPE_DISPLAY[s]:
                            display_scopes.append(SCOPE_DISPLAY[s])
                        else:
                            display_scopes.append(s.replace("_", " ").title())
                    entry["repScopes"] = display_scopes
                if rep_success:
                    entry["repReward"] = rep_success
                if rep_failure:
                    entry["repPenalty"] = rep_failure
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
                if title_loc_key:
                    entry["_titleLocKey"] = title_loc_key
                if rep_reqs:
                    # Filter out placeholder/unresolved rep requirements
                    rep_reqs = [r for r in rep_reqs if "PLACEHOLDER" not in r.get("minRank", "") and "PLACEHOLDER" not in r.get("maxRank", "")]
                if rep_reqs:
                    entry["repRequirements"] = rep_reqs
                system = infer_system(debug_name)
                if system:
                    entry["system"] = system
                activity = infer_activity(debug_name, gen_name)
                if activity:
                    entry["activity"] = activity
                danger = _infer_danger(debug_name)
                if danger:
                    entry["danger"] = danger
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

            # Build handler-level title map: for each Contract, find the nearest
            # ancestor contractParams Title (handler-level fallback)
            def _handler_title_for(contract_start):
                """Find the nearest contractParams Title before this contract position.
                Returns (resolved_title, loc_key)."""
                pre = txt[:contract_start]
                for m in reversed(list(re.finditer(r'param="Title"\s+value="([^"]+)"', pre))):
                    resolved = loc_lookup(loc, m.group(1))
                    if resolved:
                        return resolved, m.group(1).lstrip("@").lower()
                return "", ""

            def _handler_desc_for(contract_start):
                """Find the nearest contractParams Description before this contract position."""
                pre = txt[:contract_start]
                for m in reversed(list(re.finditer(r'param="Description"\s+value="([^"]+)"', pre))):
                    resolved = loc_lookup(loc, m.group(1))
                    if resolved:
                        return resolved
                return ""

            # Parse top-level Contracts
            for cm in re.finditer(r'<Contract\s([^>]+)>(.*?)</Contract>', txt, re.S):
                # Use handler-level title as fallback, then generator-level
                handler_title, handler_title_key = _handler_title_for(cm.start())
                handler_title = handler_title or gen_title
                entry = parse_contract_element(cm.group(1), cm.group(2), gen_name, handler_title)
                if entry:
                    if handler_title_key and "_titleLocKey" not in entry:
                        entry["_titleLocKey"] = handler_title_key
                    _apply_gen_cooldown(entry)
                    contracts.append(entry)
                    contract_title = entry["title"]
                    contract_title_key = entry.get("_titleLocKey", handler_title_key)

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
                            if contract_title_key and "_titleLocKey" not in career:
                                career["_titleLocKey"] = contract_title_key
                            contracts.append(career)

            # Parse top-level CareerContracts (some files have them outside Contract elements)
            # Only if not already inside a Contract
            top_career = re.finditer(r'<CareerContract\s([^>]+)>(.*?)</CareerContract>', txt, re.S)
            contract_spans = [(m.start(), m.end()) for m in re.finditer(r'<Contract\s.*?</Contract>', txt, re.S)]
            for cc in top_career:
                inside = any(s <= cc.start() and cc.end() <= e for s, e in contract_spans)
                if not inside:
                    handler_t, handler_tk = _handler_title_for(cc.start())
                    career = parse_contract_element(cc.group(1), cc.group(2), gen_name, handler_t or gen_title)
                    if career:
                        if handler_tk and "_titleLocKey" not in career:
                            career["_titleLocKey"] = handler_tk
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

    # Filter out expired/inactive event contracts
    _HIDDEN_GENERATORS = {"2025content", "cleanair", "gobling_generator"}
    before_filter = len(contracts)
    contracts = [c for c in contracts if c.get("generator", "") not in _HIDDEN_GENERATORS]
    hidden = before_filter - len(contracts)

    # Resolve contractors from generator names (prefix matching)
    _GENERATOR_CONTRACTORS = {
        "citizensforprosperity": "Citizens For Prosperity",
        "cfp_":                  "Citizens For Prosperity",
        "redwind":               "Red Wind Linehaul",
        "adagio":                "Adagio Holdings",
        "hockrowagency":         "Hockrow Agency",
        "foxwellenforcement":    "Foxwell Enforcement",
        "shubin":                "Shubin Interstellar",
        "covalex":               "Covalex",
        "rayari":                "Rayari Incorporated",
        "ftl_courier":           "FTL Courier",
        "ftl_":                  "FTL Courier",
        "deadsaints":            "Dead Saints",
        "klescher":              "Klescher Rehabilitation Facilities",
        "lingfamily":            "Ling Family Hauling",
        "bitzeros":              "Bit Zeros",
        "thecollector":          "Wikelo Emporium",
        "highpointwilderness":   "Civilian Defense Force",
        "tarpits":               "Tar Pits",
    }
    gen_resolved = 0
    for c in contracts:
        if c.get("contractor"):
            continue
        gen = c.get("generator", "").lower()
        for prefix, name in _GENERATOR_CONTRACTORS.items():
            if gen.startswith(prefix):
                c["contractor"] = name
                gen_resolved += 1
                break

    # Post-process: resolve "factionreputationscope" to contractor name in rep requirements and scopes
    for c in contracts:
        contractor = c.get("contractor", "")
        for rr in c.get("repRequirements", []):
            if rr["scope"] == "factionreputationscope":
                rr["scope"] = contractor if contractor else "Faction Standing"
        # Also fix repScopes (may be title-cased from earlier processing)
        if "repScopes" in c:
            c["repScopes"] = [
                (contractor if s.lower() == "factionreputationscope" and contractor else
                 "Faction Standing" if s.lower() == "factionreputationscope" else s)
                for s in c["repScopes"]
            ]


    # Supplement: add template-spawned sub-missions that aren't standalone Contract elements.
    # These are multi-mission children whose data lives in localization but not in generator XMLs.
    _existing_classes = {c["className"].lower() for c in contracts}
    MANUAL_CONTRACTS = [
        {
            "className": "Hockrow_FacilityDelve_P3M1",
            "title": loc.get("hockrow_facilitydelve_p3m1_title,p", "Jorrit Dossier: Project Hyperion"),
            "category": "Contract",
            "generator": "hockrowagency_facilitydelve",
            "reward": 1098000,
            "currency": "UEC",
            "lawful": True,
            "difficulty": -1,
            "maxPlayers": 1,
            "canShare": False,
            "rewardEstimated": True,
            "description": loc.get("hockrow_facilitydelve_p3m1_desc,p", loc.get("hockrow_facilitydelve_p3m1_desc", "")),
            "activity": "FPS",
            "contractor": "Hockrow Agency",
            "requiresCompletion": ["Jorrit Dossier: Power Usage Data"],
            "unlocks": ["Jorrit Dossier: Experiment Redux"],
            "isChain": True,
            "blueprintRewards": [
                'Zenith "Darkwave" Laser Sniper Rifle',
                'Fresnel "Molten" Energy LMG',
                'Geist Armor Arms ASD Edition',
                'Geist Armor Core ASD Edition',
                'Geist Armor Legs ASD Edition',
                'Geist Armor Helmet ASD Edition',
                'Zenith Laser Sniper Rifle Battery (22 Cap)',
            ],
        },
        {
            "className": "Hockrow_FacilityDelve_P3Repeat",
            "title": loc.get("hockrow_facilitydelve_p3repeat_title", "Jorrit Dossier: Experiment Redux"),
            "category": "Contract",
            "generator": "hockrowagency_facilitydelve",
            "reward": 1098000,
            "currency": "UEC",
            "lawful": True,
            "difficulty": -1,
            "maxPlayers": 1,
            "canShare": False,
            "rewardEstimated": True,
            "description": loc.get("hockrow_facilitydelve_p3repeat_desc", ""),
            "activity": "FPS",
            "contractor": "Hockrow Agency",
            "requiresCompletion": ["Jorrit Dossier: Project Hyperion"],
            "isChain": True,
        },
    ]
    for mc in MANUAL_CONTRACTS:
        if mc["className"].lower() not in _existing_classes:
            contracts.append(mc)
            print(f"  + Supplemented: {mc['title']}")

    print(f"  Parsed {before_filter} contracts ({sum(1 for c in contracts if c.get('repRequirements'))} with rep requirements, {fixed_titles} titles fixed, {hidden} hidden event, {gen_resolved} contractors resolved)")

    # Missions (from mission broker system)
    print("\n[6/7] Parsing missions...")
    mission_dir = FORGE_DIR / "missionbroker" / "pu_missions"
    missions = []
    skipped = 0
    for xml_file in mission_dir.rglob("*.xml.xml"):
        result = parse_mission(xml_file, loc, scope_map, rep_req_rank_map, standing_by_guid)
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

    # Normalize verbose internal token names to user-friendly equivalents
    _TOKEN_RENAMES = {
        "[DefendLocationWrapperLocation]": "[Location]",
        "[DistractionKillDescription]": "",
    }
    for m in missions + contracts:
        title = m.get("title", "")
        for old, new in _TOKEN_RENAMES.items():
            if old in title:
                title = title.replace(old, new).strip()
        m["title"] = title

    # Match enemy pools to bounty missions
    pool_count = 0
    for m in missions:
        cn = m.get("className", "")
        if "bounty" in cn.lower():
            pool = match_enemy_pool(cn, wave_pools)
            if pool:
                m["enemyPool"] = pool
                pool_count += 1
    print(f"  Matched enemy pools to {pool_count} bounty missions")

    # Substitute known template variables into titles (missions AND contracts)
    for m in missions + contracts:
        title = m.get("title", "")
        if "[Contractor]" in title and m.get("contractor"):
            title = title.replace("[Contractor]", m["contractor"])
        if "[Danger]" in title and m.get("danger"):
            title = title.replace("[Danger]", m["danger"])

        # Derive CargoGradeToken from className for cargo haul missions
        # Maps to localization: HaulCargo_CargoGrade_ExtraSmall, _Small, _Supply(=Medium), _Bulk(=Large)
        if "[CargoGradeToken]" in title:
            cn_l = m.get("className", "").lower()
            if "bulkgrade" in cn_l or "_bulk_" in cn_l or "_latebulk_" in cn_l:
                cargo_grade = "Large"
            elif "supplygrade" in cn_l or "_supply_" in cn_l:
                cargo_grade = "Medium"
            elif "smallgrade" in cn_l or "_small_" in cn_l:
                cargo_grade = "Small"
            elif "_large_" in cn_l:
                cargo_grade = "Large"
            elif "_medium_" in cn_l:
                cargo_grade = "Medium"
            else:
                cargo_grade = "Extra Small"
            title = title.replace("[CargoGradeToken]", cargo_grade)

        # Derive ReputationRank from repRequirements minRank
        if "[ReputationRank]" in title:
            reqs = m.get("repRequirements", [])
            rank = reqs[0].get("minRank", "") if reqs else ""
            if rank:
                title = title.replace("[ReputationRank]", rank)

        # Resolve [Title] / [title] from className-based localization lookup
        if "[Title]" in title or "[title]" in title:
            cn_l = m.get("className", "").lower()
            base = re.sub(r'_stanton\d?.*$', '', cn_l)
            for suffix in ["_title", "_title,p", "_title_01"]:
                resolved = loc.get(cn_l + suffix, "") or loc.get(base + suffix, "")
                if resolved and "~mission(" not in resolved:
                    title = resolved
                    break

        m["title"] = title

    # ── Contractor sign-off substitution in descriptions ─────────────
    # Replace ~mission(Contractor|SignOff) with the first sign-off text
    # from localization for each known contractor.
    _SIGNOFF_MAP = {}
    for lk, lv in loc.items():
        if "_signoff_001" in lk:
            prefix = lk.replace("_signoff_001", "")
            _SIGNOFF_MAP[prefix] = lv
    signoff_fixed = 0
    for m in missions + contracts:
        desc = m.get("description", "")
        if "~mission(Contractor|SignOff)" in desc or "[Contractor|SignOff]" in desc:
            contractor = m.get("contractor", "").lower().replace(" ", "")
            # Match contractor name to signoff key prefix
            signoff = None
            for prefix, text in _SIGNOFF_MAP.items():
                if contractor and prefix in contractor or contractor in prefix:
                    signoff = text
                    break
            if signoff:
                desc = desc.replace("~mission(Contractor|SignOff)", signoff)
                desc = desc.replace("[Contractor|SignOff]", signoff)
                m["description"] = desc
                signoff_fixed += 1
    if signoff_fixed:
        print(f"  Resolved {signoff_fixed} contractor sign-offs in descriptions")

    # ── Description fallback ────────────────────────────────────────────
    # Contracts whose description is just a template token (e.g. [Contractor],
    # ~mission(Contractor|SignOff)) get matched to their narrative text in
    # localization via the title key pattern: {prefix}_title → {prefix}_desc_01.
    # Runs AFTER ~mission() cleanup and template substitution so all titles/descs
    # are in their final [...] form.
    _DESC_TITLE_PREFIXES = {}
    for lk in loc:
        if lk.endswith("_desc_01") or lk.endswith("_desc,p"):
            base = lk.rsplit("_desc", 1)[0]
            title_key = base + "_title"
            if title_key in loc:
                _DESC_TITLE_PREFIXES[title_key] = lk
    for lk in loc:
        if lk.endswith("_desc_01"):
            base = lk.rsplit("_desc", 1)[0]
            for tsuf in ["_title_01", "_title_02"]:
                tk = base + tsuf
                if tk in loc:
                    _DESC_TITLE_PREFIXES[tk] = lk
    _TITLE_TEXT_TO_DESC = {}
    for title_key, desc_key in _DESC_TITLE_PREFIXES.items():
        title_text = loc.get(title_key, "")
        if title_text:
            _TITLE_TEXT_TO_DESC[title_text.lower()] = desc_key

    desc_fixed = 0
    for c in missions + contracts:
        desc = c.get("description", "")
        if desc and len(desc) < 120 and re.match(r'^\s*[\[\~]', desc):
            desc = ""
            c.pop("description", None)
        if not desc:
            title_loc_key = c.get("_titleLocKey", "")
            if title_loc_key:
                dk = _DESC_TITLE_PREFIXES.get(title_loc_key.lower())
                if dk:
                    c["description"] = loc.get(dk, "")
                    if c["description"]:
                        desc_fixed += 1
                        continue
            raw_title = c.get("title", "")
            for pattern_title, dk in _TITLE_TEXT_TO_DESC.items():
                replaced = re.sub(r'~mission\([^)]+\)', 'PLACEHOLDER', pattern_title)
                norm_pattern = re.escape(replaced).replace('PLACEHOLDER', '.*')
                if re.match(norm_pattern, raw_title.lower()):
                    c["description"] = loc.get(dk, "")
                    if c["description"]:
                        desc_fixed += 1
                        break
    if desc_fixed:
        print(f"  Fixed {desc_fixed} missing descriptions from localization fallback")

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

    # Merge contracts into missions: if a contract title matches a mission title,
    # merge blueprint rewards and any missing fields into the mission, then drop the contract.
    mission_by_title = {}
    for m in missions:
        mission_by_title.setdefault(m["title"], []).append(m)

    merged_bp = 0
    merged_contracts = set()
    for i, c in enumerate(contracts):
        title = c.get("title", "")
        if title in mission_by_title:
            # Merge blueprint rewards into all matching missions
            bp = c.get("blueprintRewards", [])
            flow = c.get("missionFlow", [])
            for m in mission_by_title[title]:
                if bp and not m.get("blueprintRewards"):
                    m["blueprintRewards"] = bp
                    merged_bp += 1
                if flow and not m.get("missionFlow"):
                    m["missionFlow"] = flow
                if c.get("repRequirements") and not m.get("repRequirements"):
                    m["repRequirements"] = c["repRequirements"]
                # Match rep values by className similarity (boss vs specific, etc.)
                # If classNames share a keyword pattern, prefer that match
                c_cls = c.get("className", "").lower()
                m_cls = m.get("className", "").lower()
                cls_match = any(kw in c_cls and kw in m_cls
                                for kw in ["boss", "specific", "elite", "standard", "hard", "easy"])
                if c.get("repReward"):
                    if cls_match or not m.get("repReward"):
                        m["repReward"] = c["repReward"]
                if c.get("repPenalty"):
                    if cls_match or not m.get("repPenalty"):
                        m["repPenalty"] = c["repPenalty"]
            merged_contracts.add(i)

    # Keep contracts that didn't merge into a mission
    remaining_contracts = [c for i, c in enumerate(contracts) if i not in merged_contracts]
    all_entries = missions + remaining_contracts
    print(f"  Merged {merged_bp} blueprint rewards from contracts into missions")
    print(f"  Dropped {len(merged_contracts)} duplicate contracts, kept {len(remaining_contracts)}")

    # Second-pass dedup on combined list (catches contract duplicates with same title+category+reward)
    before_dedup2 = len(all_entries)
    seen2 = {}
    unique2 = []
    for m in all_entries:
        key = (m["title"], m["category"], m["reward"])
        if key not in seen2:
            seen2[key] = m
            unique2.append(m)
        else:
            seen2[key]["multiSystem"] = True
            # Merge rep scopes and blueprint rewards from duplicate
            for field in ("repScopes", "blueprintRewards"):
                if m.get(field):
                    existing = seen2[key].get(field, [])
                    for s in m[field]:
                        if s not in existing:
                            existing.append(s)
                    seen2[key][field] = existing
    all_entries = unique2
    if before_dedup2 != len(all_entries):
        print(f"  Second-pass dedup: {before_dedup2} -> {len(all_entries)}")

    # ── Chain resolution ────────────────────────────────────
    print("\n  Resolving contract chains...")

    # 1. Mission broker chains: __ref GUID → title, and requiredMissions refs
    mission_ref_map = {}  # __ref GUID → title
    ref_required_by = {}  # __ref GUID → [titles of missions that require it]
    for m in all_entries:
        ref = m.get("_ref")
        if ref:
            mission_ref_map[ref] = m["title"]
    for m in all_entries:
        for ref in m.get("_requiredRefs", []):
            ref_required_by.setdefault(ref, []).append(m["title"])

    # 2. Contract tag chains: tag GUID → granting contract title, tag GUID → [requiring titles]
    tag_granted_by = {}   # tag GUID → title of contract that grants it
    tag_required_by = {}  # tag GUID → [titles of contracts that require it]
    for c in all_entries:
        for tag in c.get("_grantTags", []):
            tag_granted_by[tag] = c["title"]
    for c in all_entries:
        for tag in c.get("_reqTags", []):
            tag_required_by.setdefault(tag, []).append(c["title"])

    # 3. Resolve into requiresCompletion / unlocks
    chain_count = 0
    for m in all_entries:
        requires = []
        unlocks = []

        # Mission broker: requiredMissions refs → titles
        for ref in m.get("_requiredRefs", []):
            title = mission_ref_map.get(ref)
            if title and title not in requires:
                requires.append(title)

        # Mission broker: this mission's __ref is required by others
        ref = m.get("_ref")
        if ref and ref in ref_required_by:
            for t in ref_required_by[ref]:
                if t not in unlocks and t != m["title"]:
                    unlocks.append(t)

        # Contract tags: required tags → granting contract titles
        for tag in m.get("_reqTags", []):
            title = tag_granted_by.get(tag)
            if title and title not in requires and title != m["title"]:
                requires.append(title)

        # Contract tags: granted tags → requiring contract titles
        for tag in m.get("_grantTags", []):
            if tag in tag_required_by:
                for t in tag_required_by[tag]:
                    if t not in unlocks and t != m["title"]:
                        unlocks.append(t)

        if requires:
            m["requiresCompletion"] = requires
        if unlocks:
            m["unlocks"] = unlocks
        if requires or unlocks:
            m["isChain"] = True
            chain_count += 1

    # Clean up internal fields
    for m in all_entries:
        m.pop("_ref", None)
        m.pop("_requiredRefs", None)
        m.pop("_reqTags", None)
        m.pop("_grantTags", None)

    print(f"  {chain_count} missions/contracts have chain links")
    print(f"  {len(mission_ref_map)} mission refs mapped, {len(tag_granted_by)} completion tags mapped")

    # Flag boss contracts
    for m in all_entries:
        if "boss" in m.get("className", "").lower():
            m["boss"] = True

    # Sort by category then reward
    all_entries.sort(key=lambda m: (m["category"], -(m.get("reward", 0))))

    # Clean up placeholder titles and rep requirements across ALL entries
    _CLASSNAME_TITLE_MAP = {
        "bounty": "Bounty", "assassination": "Assassination", "eliminateall": "Eliminate All",
        "eliminatespecific": "Eliminate Target", "delivery": "Delivery", "deploy": "Deploy Probe",
        "commarrayrepair": "Comm Array Repair", "commarrayhack": "Comm Array Hack",
        "recovery": "Recovery", "cave_recovery": "Cave Recovery", "derelict": "Derelict Exploration",
        "missingperson": "Missing Person", "destroy_items": "Destroy Items",
        "destroynarcotics": "Destroy Narcotics", "dataheist": "Data Heist",
        "retakelocation": "Retake Location", "scavenge": "Scavenge",
        "destroy_satellite": "Destroy Satellite", "syncedassassination": "Synced Assassination",
        "stealstash": "Steal Stash", "recoverstash": "Recover Stash",
        "timesensitive": "Time-Sensitive Delivery", "drugproduction": "Drug Production",
        "surfacerelay": "Surface Relay",
    }
    placeholder_fixed = 0
    for m in all_entries:
        title = m.get("title", "")
        if title.startswith("[Contractor]"):
            cn = m.get("className", "").lower().replace("pu_", "")
            new_title = None
            for pattern, label in _CLASSNAME_TITLE_MAP.items():
                if pattern in cn:
                    new_title = label
                    break
            if new_title:
                m["title"] = new_title
            else:
                m["title"] = cn.replace("_", " ").title()
            placeholder_fixed += 1
        # Strip PLACEHOLDER rep requirements
        if m.get("repRequirements"):
            m["repRequirements"] = [r for r in m["repRequirements"]
                                    if "PLACEHOLDER" not in r.get("minRank", "")
                                    and "PLACEHOLDER" not in r.get("maxRank", "")]
            if not m["repRequirements"]:
                del m["repRequirements"]
    if placeholder_fixed:
        print(f"  Fixed {placeholder_fixed} placeholder titles")

    # ── Reputation ladders ───────────────────────────────────
    print("\n[7/8] Extracting reputation ladders...")
    scope_dir = FORGE_DIR / "reputation" / "scopes"
    standing_base = FORGE_DIR / "reputation" / "standings"
    rep_ladders = {}

    # Build standing GUID -> info from ALL standing files (recursive)
    all_standings = {}
    if standing_base.exists():
        for sf in standing_base.rglob("*.xml.xml"):
            try:
                stxt = open(sf, encoding="utf-8").read()
                sref = re.search(r'__ref="([^"]+)"', stxt)
                sdisplay = re.search(r'displayName="@([^"]+)"', stxt)
                smin = re.search(r'minReputation="([^"]+)"', stxt)
                sgated = re.search(r'gated="([^"]+)"', stxt)
                sperk = re.search(r'perkDescription="@([^"]+)"', stxt)
                sdrift = re.search(r'driftReputation="([^"]+)"', stxt)
                sdrift_hrs = re.search(r'driftTimeHours="([^"]+)"', stxt)
                if sref:
                    gk = guid_key(sref.group(1))
                    display = loc_lookup(loc, "@" + sdisplay.group(1)) if sdisplay else sf.stem
                    info = {
                        "name": display,
                        "minRep": int(smin.group(1)) if smin else 0,
                        "gated": sgated.group(1) == "1" if sgated else False,
                    }
                    # Perk description (e.g. "+5% bonus")
                    if sperk:
                        perk = loc_lookup(loc, "@" + sperk.group(1))
                        if perk and perk not in ("", " "):
                            info["perk"] = perk
                    # Drift/decay (rep auto-decays toward this rank)
                    drift_amt = int(sdrift.group(1)) if sdrift else 0
                    drift_hrs = int(float(sdrift_hrs.group(1))) if sdrift_hrs else 0
                    if drift_amt and drift_hrs:
                        info["driftPerHour"] = drift_amt
                    all_standings[gk] = info
            except Exception:
                pass

    # Parse each scope's standing map
    if scope_dir.exists():
        for sf in scope_dir.glob("*.xml.xml"):
            try:
                stxt = open(sf, encoding="utf-8").read()
                scope_name_m = re.search(r'scopeName="([^"]+)"', stxt)
                display_m = re.search(r'displayName="@([^"]+)"', stxt)
                ceiling_m = re.search(r'reputationCeiling="([^"]+)"', stxt)
                if not scope_name_m:
                    continue
                scope_name = scope_name_m.group(1)
                display = loc_lookup(loc, "@" + display_m.group(1)) if display_m else scope_name
                # Fix unresolved localization tokens
                DISPLAY_FALLBACKS = {
                    "RepScope_ShipCombat_Name": "Ship Combat",
                    "RepScope_ShipCombat_HeadHunters_Name": "Ship Combat (Headhunters)",
                    "RepScope_ShipCombat_RoughAndReady_Name": "Ship Combat (Rough & Ready)",
                    "RepScope_ShipCombat_XenoThreat_Name": "Ship Combat (XenoThreat)",
                    "RepScope_FPSCombat_Name": "FPS Combat",
                    "RepScope_Worker_Name": "Worker",
                    "RepScope_Racing_HeadHunters_Name": "Racing (Headhunters)",
                    "Racing_Hover_DisplayName": "Racing (Hover)",
                    "Racing_Wheeled_DisplayName": "Racing (Wheeled)",
                }
                if display in DISPLAY_FALLBACKS:
                    display = DISPLAY_FALLBACKS[display]
                ceiling = int(ceiling_m.group(1)) if ceiling_m else 0

                # Extract standing references in order. StarBreaker uses
                # <Reference value="GUID"/>; unp4k used <Reference>GUID</Reference>.
                # Accept both attribute and text forms.
                refs = re.findall(r'<Reference\s+value="([^"]+)"\s*/?>', stxt)
                if not refs:
                    refs = re.findall(r'<Reference>([^<]+)</Reference>', stxt)
                ranks = []
                for r in refs:
                    gk = guid_key(r)
                    info = all_standings.get(gk)
                    if info:
                        ranks.append(info)
                ranks = [r for r in ranks if "PLACEHOLDER" not in r["name"]]
                ranks.sort(key=lambda x: x["minRep"])

                if ranks:
                    rep_ladders[scope_name.lower()] = {
                        "name": scope_name,
                        "displayName": display,
                        "ceiling": ceiling,
                        "ranks": ranks,
                    }
            except Exception:
                pass
    print(f"  Extracted {len(rep_ladders)} reputation ladders ({sum(len(l['ranks']) for l in rep_ladders.values())} total ranks)")

    # ── Factions ─────────────────────────────────────────────
    print("\n[8/8] Extracting factions...")
    factions_dir = FORGE_DIR / "factions"
    factions = {}
    faction_guid_to_key = {}  # __ref GUID → faction key (for resolving allies/enemies)

    # Also load factionreputation records for display names & logos
    faction_rep_info = {}  # __ref GUID → {displayName, logo}
    faction_rep_dir = factions_dir / "factionreputation"
    if faction_rep_dir.exists():
        for ff in faction_rep_dir.glob("*.xml.xml"):
            try:
                ftxt = open(ff, encoding="utf-8").read()
                fref = re.search(r'__ref="([^"]+)"', ftxt)
                fdisplay = re.search(r'displayName="@([^"]+)"', ftxt)
                flogo = re.search(r'logo="([^"]*)"', ftxt)
                if fref:
                    info = {}
                    if fdisplay:
                        info["displayName"] = loc_lookup(loc, "@" + fdisplay.group(1))
                    if flogo and flogo.group(1):
                        info["logo"] = flogo.group(1)
                    faction_rep_info[guid_key(fref.group(1))] = info
            except Exception:
                pass

    # First pass: build GUID → key map for all factions
    if factions_dir.exists():
        for ff in factions_dir.glob("faction_*.xml.xml"):
            try:
                ftxt = open(ff, encoding="utf-8").read()
                fref = re.search(r'__ref="([^"]+)"', ftxt)
                fname = re.search(r' name="@([^"]+)"', ftxt)
                if fref and fname:
                    display = loc_lookup(loc, "@" + fname.group(1))
                    key = ff.stem.replace(".xml", "").replace("faction_", "")
                    faction_guid_to_key[guid_key(fref.group(1))] = key
            except Exception:
                pass

    # Second pass: extract full faction info
    if factions_dir.exists():
        for ff in factions_dir.glob("faction_*.xml.xml"):
            try:
                root = ET.parse(ff).getroot()
                ref = root.get("__ref", "")
                name_loc = root.get("name", "")
                desc_loc = root.get("description", "")
                faction_type = root.get("factionType", "")
                default_reaction = root.get("defaultReaction", "Neutral")
                able_arrest = root.get("ableToArrest", "0") == "1"
                polices_trespass = root.get("policesLawfulTrespass", "0") == "1"
                polices_crime = root.get("policesCriminality", "0") == "1"
                no_legal_rights = root.get("noLegalRights", "0") == "1"
                rep_ref = root.get("factionReputationRef", "")

                display_name = loc_lookup(loc, name_loc) if name_loc.startswith("@") else name_loc
                description = loc_lookup(loc, desc_loc) if desc_loc.startswith("@") else ""
                key = ff.stem.replace(".xml", "").replace("faction_", "")

                # Skip template/generic/internal factions
                if "template" in key or "generic" in key or "friendlytoall" in key or "hostiletoall" in key:
                    continue
                if "hostiletoxt" in key or key == "creature_hostile_kopion":
                    continue
                # Skip creature factions
                if faction_type == "Creature":
                    continue

                # Fix unresolved localization (<=...=> or raw loc keys)
                _FACTION_NAME_OVERRIDES = {
                    "unlawful_shatteredblade": "Shattered Blade",
                    "curelife": "Alliance Aid",
                }
                if not display_name or "<=" in display_name or "RepUI_Name" in display_name:
                    if key in _FACTION_NAME_OVERRIDES:
                        display_name = _FACTION_NAME_OVERRIDES[key]
                    else:
                        clean = key.split("_", 1)[-1] if "_" in key else key
                        display_name = clean.replace("_", " ").title()
                if not description or "<=" in description:
                    description = ""

                entry = {
                    "name": display_name or key.replace("_", " ").title(),
                    "type": faction_type,
                    "defaultReaction": default_reaction,
                }
                if description:
                    entry["description"] = description
                if able_arrest or polices_trespass or polices_crime:
                    entry["lawEnforcement"] = True
                if no_legal_rights:
                    entry["outlaw"] = True

                # Resolve factionReputation for display name override + logo
                if rep_ref and rep_ref != "null":
                    rep_info = faction_rep_info.get(guid_key(rep_ref))
                    if rep_info:
                        if rep_info.get("displayName"):
                            entry["name"] = rep_info["displayName"]

                # Allies and enemies (resolve to faction keys)
                # Filter out internal/generic factions that aren't meaningful to players
                _SKIP_RELATIONS = {"creature_hostile_generic", "creature_hostile_generic_vlk_asd_align",
                                   "creature_hostile_kopion", "creature_hostile_vanduul",
                                   "special_friendlytoall", "special_hostiletoall"}
                allies = []
                for a_ref in root.findall(".//alliedFactions/Reference"):
                    if a_ref.text:
                        ally_key = faction_guid_to_key.get(guid_key(a_ref.text))
                        if ally_key and ally_key not in _SKIP_RELATIONS:
                            allies.append(ally_key)
                enemies = []
                for e_ref in root.findall(".//enemyFactions/Reference"):
                    if e_ref.text:
                        enemy_key = faction_guid_to_key.get(guid_key(e_ref.text))
                        if enemy_key and enemy_key not in _SKIP_RELATIONS:
                            enemies.append(enemy_key)
                if allies:
                    entry["allies"] = allies
                if enemies:
                    entry["enemies"] = enemies

                factions[key] = entry
            except Exception:
                pass

    # All factions use the shared factionreputation ladder
    for entry in factions.values():
        entry["repLadder"] = "factionreputation"

    print(f"  Extracted {len(factions)} factions")

    # ── Scope-to-ladder mapping ──────────────────────────────
    # Maps repScope display names to their reputationLadders key
    # so the frontend can always find the right ladder for a contract.
    scope_to_ladder = {}
    # Activity scopes → ladder keys (from scope file names vs ladder keys)
    _SCOPE_LADDER_MAP = {
        "bounty": "bountyhunter",
        "bounty_bountyhuntersguild": "bountyhunter_bountyhuntersguild",
        "Bounty Hunting": "bountyhunter",
        "Bounty Hunting (Guild)": "bountyhunter_bountyhuntersguild",
        "Racing (Ship)": "racingship",
        "Faction Standing": "factionreputation",
        "Wikelo": "wikelo",
        "InterSec": "factionreputation",
        "FPS Combat": "fps_combat",
        "Ship Combat": "shipcombat",
        "Ship Combat (Headhunters)": "shipcombat_headhunters",
        "Ship Combat (Rough & Ready)": "shipcombat_roughandready",
        "Ship Combat (XenoThreat)": "shipcombat_xenothreat",
    }
    for display, lk in _SCOPE_LADDER_MAP.items():
        if lk in rep_ladders:
            scope_to_ladder[display] = lk

    # Faction org names → factionreputation ladder
    for fk, fv in factions.items():
        scope_to_ladder[fv["name"]] = "factionreputation"

    # Also map factionreputation display names (some orgs only exist as rep records)
    for gk, info in faction_rep_info.items():
        dn = info.get("displayName", "")
        if dn and dn not in scope_to_ladder:
            scope_to_ladder[dn] = "factionreputation"

    # Ladders that match their own display name
    for lk, lv in rep_ladders.items():
        scope_to_ladder[lv["displayName"]] = lk
        scope_to_ladder[lk] = lk

    # ── Reputation reward tiers ──────────────────────────────
    # Build sorted tier list from already-loaded rep_reward_amounts
    rep_tiers = sorted(
        [{"amount": v} for v in set(rep_reward_amounts.values()) if v != 0],
        key=lambda t: t["amount"]
    )
    print(f"  {len(rep_tiers)} reputation reward tiers")

    # Stats
    categories = {}
    for m in all_entries:
        categories[m["category"]] = categories.get(m["category"], 0) + 1

    # ── Resolve procedurally-generated contract narratives ──────────
    # Generator contracts (BitZeros / Hockrow / DeadSaints BlackBoxRecovery +
    # RecoverItem families) ship with unresolved runtime templates like
    # "~mission(Contractor|RecoverSpaceDescription)". Compose the
    # faction-specific localization key from the className and pull the
    # concrete narrative text.
    narr_fixed = 0
    for entry in all_entries:
        t, d = resolve_procedural_narrative(entry.get("className", ""), loc)
        desc = entry.get("description", "") or ""
        title = entry.get("title", "") or ""
        needs_desc = (desc.startswith("~mission(") or desc.startswith("[Contractor")
                      or not desc)
        needs_title = (title == entry.get("contractor", "") or
                       title.startswith("~mission(") or not title)
        if t and needs_title: entry["title"] = t
        if d and needs_desc:  entry["description"] = d
        if (t and needs_title) or (d and needs_desc): narr_fixed += 1
    if narr_fixed:
        print(f"  Resolved narrative for {narr_fixed} procedural contracts")

    # ── Contractor profiles from RepUI localization ────────────────
    # Each in-game faction/NPC has a narrative card in global.ini as
    # {key}_RepUI_Description/Area/Focus/Founded/HQ/Leadership (or the
    # Biography/Location/Occupation/Association variants for individuals).
    # We keep a top-level map keyed by the contractor display-name exactly
    # as it appears on contracts, so the UI can do a direct lookup.
    contractor_profiles = build_contractor_profiles(loc, all_entries)

    output = {
        "meta": {
            "totalContracts": len(all_entries),
            "categories": categories,
            "missionGivers": len(givers),
            "factions": len(factions),
            "contractorProfiles": len(contractor_profiles),
        },
        "missionGivers": givers,
        "factions": factions,
        "contractorProfiles": contractor_profiles,
        "reputationRanks": standing_display,
        "reputationLadders": rep_ladders,
        "reputationTiers": rep_tiers,
        "scopeToLadder": scope_to_ladder,
        "contracts": all_entries,
    }

    # Strip internal keys before writing
    for entry in all_entries:
        entry.pop("_titleLocKey", None)

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

    # Copy to app (mode-aware subfolder)
    import shutil
    APP_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OUTPUT_FILE, APP_FILE)
    print(f"\n  Copied to {APP_FILE}")

if __name__ == "__main__":
    main()

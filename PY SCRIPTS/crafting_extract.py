#!/usr/bin/env python3
"""
Extract crafting recipe data via StarBreaker's `dcb query` JSON output.

The previous DCB-binary parser broke on 4.8 PTU's schema (KeyError:
'CraftingBlueprint' — CIG renamed the struct). StarBreaker's record
query is schema-version-independent and resolves resource GUIDs to
ResourceType names automatically.

Outputs: versedb_crafting.json with all crafting blueprints, recipes,
and ingredients, in the same schema the existing app already consumes.

Requires `starbreaker` on PATH or at ~/tools/starbreaker.
"""

import json, re, os, sys, subprocess, shutil
from pathlib import Path
from collections import Counter

_SC = Path(__file__).resolve().parent.parent / "SC FILES"
_DATA_MODE = os.environ.get("VERSEDB_DATA_MODE", "live")
DCB_FILE   = _SC / f"sc_data_{_DATA_MODE}" / "Data" / "Game2.dcb"
LOC_FILE   = _SC / f"sc_data_xml_{_DATA_MODE}" / "Data" / "Localization" / "english" / "global.ini"
FORGE_DIR  = _SC / f"sc_data_forge_{_DATA_MODE}" / "libs" / "foundry" / "records"

# Resolve common harvestable mineral entityClass names to player-visible
# resource names. Applied when ingredients carry an entityClass instead
# of a ResourceType reference (some FPS recipes use mineral entities
# directly rather than the abstract ResourceType layer).
_RESOURCE_RENAME_PAIRS = [
    ("Harvestable_Mineral_1H_Aphorite", "Aphorite"),
    ("Harvestable_Mineral_1H_Beradom",  "Beradon"),
    ("Harvestable_Mineral_1H_Carinite", "Carinite"),
    ("Harvestable_Mineral_1H_Dolivine", "Dolivine"),
    ("Harvestable_Mineral_1H_Hadanite", "Hadanite"),
    ("Harvestable_Mineral_1H_Janalite", "Janalite"),
    ("Harvestable_Mineral_1H_Sadaryx",  "Sadaryx"),
    ("Harvestable_Ore_1H_SaldyniumOre", "Saldynium Ore"),
]
# Case-insensitive lookup — starbreaker returns entity classes
# lowercased from file paths, while the legacy binary parser returned
# the original-case className. Index by lowered key so both hit.
RESOURCE_RENAMES = {k: v for k, v in _RESOURCE_RENAME_PAIRS}
RESOURCE_RENAMES.update({k.lower(): v for k, v in _RESOURCE_RENAME_PAIRS})


# ─── starbreaker tool resolution ─────────────────────────────────

def _starbreaker_bin():
    home_bin = Path.home() / "tools" / "starbreaker"
    if home_bin.exists():
        return str(home_bin)
    if shutil.which("starbreaker"):
        return "starbreaker"
    raise RuntimeError("starbreaker not found in ~/tools/ or on PATH")


def _query_records(record_type):
    """Run starbreaker dcb query <type> against the current-mode DCB and
    return the raw JSON text (multi-record, brace-balanced concat)."""
    sb = _starbreaker_bin()
    if not DCB_FILE.exists():
        raise RuntimeError(f"DCB not found: {DCB_FILE}")
    proc = subprocess.run(
        [sb, "dcb", "query", "--dcb", str(DCB_FILE), record_type],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"starbreaker query {record_type} failed (rc={proc.returncode}): "
            f"{proc.stderr[:400]}"
        )
    return proc.stdout


def _split_concatenated_json(text):
    """starbreaker outputs multiple top-level JSON objects concatenated
    with newlines in between. Brace-balance to split — handles strings
    and escapes correctly so brace chars inside strings don't confuse us."""
    records, depth, in_str, esc, start = [], 0, False, False, 0
    for i, c in enumerate(text):
        if esc:
            esc = False
            continue
        if c == '\\':
            esc = True
            continue
        if c == '"':
            in_str = not in_str
        if in_str:
            continue
        if c == '{':
            if depth == 0:
                start = i
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                records.append(text[start:i + 1])
    return records


# ─── localization + display name fallbacks ───────────────────────

def _load_localization():
    """Build a localization map. Some entries use the `<key>,P=<value>`
    plural/gender-marked format; index them under both the marked and
    unmarked key so a bare-key lookup hits without callers needing to
    know about the `,P` suffix."""
    loc = {}
    if LOC_FILE.exists():
        with open(LOC_FILE, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if "=" not in line:
                    continue
                k, v = line.strip().split("=", 1)
                kl = k.lower()
                loc[kl] = v
                # Strip ,p / ,n / ,a / etc. suffix and also index under
                # the bare key — only if the bare slot isn't already set
                # by an earlier non-suffixed entry.
                if "," in kl:
                    bare = kl.split(",", 1)[0]
                    loc.setdefault(bare, v)
    return loc


def _build_scitem_display_cache(loc):
    """Walk forge XMLs once and pull the SCItemPurchasableParams display
    name keys, resolved through `loc`. Used as a fallback when entity
    className doesn't have an `item_name_<class>` localization entry."""
    cache = {}
    base = FORGE_DIR / "entities" / "scitem"
    if not base.exists():
        return cache
    for sf in base.rglob("*.xml.xml"):
        try:
            stxt = open(sf, encoding="utf-8").read()
        except Exception:
            continue
        m = re.search(r'SCItemPurchasableParams[^>]*displayName="@([^"]+)"', stxt)
        if not m:
            continue
        loc_key = m.group(1).lower()
        resolved = loc.get(loc_key, "")
        if resolved and resolved != "@LOC_UNINITIALIZED":
            cls = sf.stem.replace(".xml", "")
            cache[cls] = resolved
    return cache


def _make_resolve_item_name(loc, scitem_display):
    def resolve_item_name(class_name):
        cn = (class_name or "").lower()
        for prefix in ("item_name", "item_name_"):
            key = prefix + cn
            if key in loc:
                return loc[key]
        # Try progressively shorter className suffixes for variant fallback
        parts = cn.split("_")
        for trim in range(1, min(4, len(parts))):
            shorter = "_".join(parts[:-trim])
            for prefix in ("item_name", "item_name_"):
                key = prefix + shorter
                if key in loc:
                    return loc[key]
        if class_name in scitem_display:
            return scitem_display[class_name]
        return class_name
    return resolve_item_name


def _build_property_name_map(loc):
    """Query CraftingGameplayPropertyDef and map short name (e.g.
    GPP_Weapon_Recoil_Smoothness) → (display, unit) using localization."""
    out = {}
    try:
        text = _query_records("CraftingGameplayPropertyDef")
    except RuntimeError as e:
        print(f"  WARNING: property-def query failed: {e}")
        return out
    for rec in _split_concatenated_json(text):
        try:
            o = json.loads(rec)
        except Exception:
            continue
        rn = o.get("_RecordName_", "")
        if not rn.startswith("CraftingGameplayPropertyDef."):
            continue
        short = rn.split(".", 1)[1]
        v = o.get("_RecordValue_", {}) or {}
        prop_loc_key = (v.get("propertyName") or "").lstrip("@").lower()
        unit_loc_key = (v.get("unitFormat") or "").lstrip("@").lower()
        display = loc.get(prop_loc_key, short) if prop_loc_key else short
        unit = loc.get(unit_loc_key, "") if unit_loc_key else ""
        if unit == "@LOC_EMPTY":
            unit = ""
        out[short] = (display, unit)
    return out


# ─── path → category mapping ─────────────────────────────────────

def _entity_class_from_path(file_path):
    """Pull the bare entity className from a starbreaker file:// URI.
    Example: 'file://.../scitem/ships/cooler/cool_amrs_s2.json'
              → 'cool_amrs_s2' """
    if not file_path:
        return ""
    base = file_path.rsplit("/", 1)[-1]
    if base.endswith(".json"):
        base = base[:-5]
    return base


def _map_category(starbreaker_cat, entity_path):
    """Map BlueprintCategoryRecord.<X> + entityClass path → the existing
    schema's category names. FPS categories pass through unchanged.
    VehicleComponent*/VehicleWeapons* (new in 4.8) get split into the
    legacy Ship* buckets by inspecting the entity path."""
    if starbreaker_cat in ("FPSWeapons", "FPSArmours", "MissionItem"):
        return starbreaker_cat
    p = (entity_path or "").lower()
    if starbreaker_cat.startswith("VehicleWeapons"):
        return "ShipWeapon"
    if starbreaker_cat.startswith("VehicleComponent"):
        if "/scitem/ships/cooler/"          in p: return "ShipCooler"
        if "/scitem/ships/powerplant/"      in p: return "ShipPowerPlant"
        if "/scitem/ships/quantumdrive/"    in p: return "ShipQuantumDrive"
        if "/scitem/ships/radar/"           in p: return "ShipRadar"
        if "/scitem/ships/shieldgenerator/" in p: return "ShipShield"
        if "/scitem/ships/weapons/" in p:
            # In VehicleComponent* the weapons folder holds non-gun
            # items: mining lasers and any salvage tools that drift in.
            if "mining" in p:    return "ShipMiningLaser"
            if "salvage" in p:   return "ShipSalvage"
            if "tractor" in p:   return "ShipTractorBeam"
            return "ShipMiningLaser"
        if "/scitem/ships/utility/" in p:
            if "salvage" in p:   return "ShipSalvage"
            return "ShipTractorBeam"
    return starbreaker_cat  # fall through unmapped (logged at end)


# ─── subtype + cost extraction (unchanged from previous parser) ──

def _infer_subtype(class_name, category):
    cn = (class_name or "").lower()
    if category == "FPSWeapons":
        for wtype in ("sniper", "pistol", "rifle", "smg", "shotgun", "lmg"):
            if f"_{wtype}_" in cn or cn.endswith(f"_{wtype}"):
                return wtype.upper() if wtype in ("smg", "lmg") else wtype.capitalize()
        return "Other"
    if category == "FPSArmours":
        if "_helmet_"    in cn or cn.endswith("_helmet"):    return "Helmet"
        if "_arms_"      in cn or cn.endswith("_arms"):      return "Arms"
        if "_legs_"      in cn or cn.endswith("_legs"):      return "Legs"
        if "_core_"      in cn or cn.endswith("_core") or "_backpack_" in cn:
            return "Core"
        if "_undersuit_" in cn:                              return "Undersuit"
        return "Other"
    return ""


def _extract_quality_modifiers(context_list):
    """Read gameplayPropertyModifiers out of a Select node's context.
    Property names are stored as the raw record short name; resolved to
    display + unit by the caller after we have the full prop_name_map."""
    mods = []
    if not isinstance(context_list, list):
        return mods
    for ctx in context_list:
        if not isinstance(ctx, dict):
            continue
        gpm = ctx.get("gameplayPropertyModifiers")
        if not isinstance(gpm, dict):
            continue
        gpm_list = gpm.get("gameplayPropertyModifiers", [])
        if not isinstance(gpm_list, list):
            continue
        for mod in gpm_list:
            if not isinstance(mod, dict):
                continue
            prop_ref = mod.get("gameplayPropertyRecord")
            # gameplayPropertyRecord shows up in three shapes depending
            # on whether starbreaker fully resolved the reference:
            #   - dict with _RecordName_:  fully resolved record object
            #   - file:// path string:     unresolved external ref
            #   - bare short-name string:  legacy binary-parser output
            # Boil down to the short name (e.g. GPP_Weapon_Recoil_Kick)
            # for downstream prop_name_map lookup.
            if isinstance(prop_ref, dict):
                rn = prop_ref.get("_RecordName_", "")
                prop_short = rn.rsplit(".", 1)[-1] if rn else ""
            elif isinstance(prop_ref, str) and prop_ref.startswith("file://"):
                base = prop_ref.rsplit("/", 1)[-1]
                if base.endswith(".json"):
                    base = base[:-5]
                prop_short = base
            else:
                prop_short = prop_ref or ""
            if not prop_short:
                continue
            for vr in mod.get("valueRanges", []) or []:
                if not isinstance(vr, dict):
                    continue
                sq = vr.get("startQuality", 0)
                eq = vr.get("endQuality", 0)
                ms = vr.get("modifierAtStart", 1.0)
                me = vr.get("modifierAtEnd", 1.0)
                if sq == eq == 0 and ms == me == 1.0:
                    continue  # no-op modifier
                mods.append({
                    "property": prop_short,
                    "startQuality": sq,
                    "endQuality": eq,
                    "modifierAtStart": round(ms, 4),
                    "modifierAtEnd": round(me, 4),
                })
    return mods


def _resource_name_from_ref(ref):
    """starbreaker resource refs are full record objects; the human-
    readable name lives at `_RecordName_` like 'ResourceType.Aluminum'."""
    if isinstance(ref, dict):
        rn = ref.get("_RecordName_", "")
        return rn.rsplit(".", 1)[-1] if rn else ""
    return ref or ""


def _resolve_item_class_display(class_name, loc, scitem_display):
    """Map a CraftingCost_Item entityClass (e.g.
    'harvestable_mineral_1h_glacosite', 'Pressurized_Ice') to a
    user-visible name. Resolution order:
      1. RESOURCE_RENAMES override (case-insensitive)
      2. loc[items_commodities_<core>] — strip any harvestable_ prefix
      3. loc[item_name<class>] / loc[item_name_<class>]
      4. SCItemPurchasableParams display cache
      5. Fall through to the raw class name with underscores swapped
         for spaces (still readable, just unstyled)."""
    if not class_name:
        return class_name
    cn = class_name.lower()
    if cn in RESOURCE_RENAMES:
        return RESOURCE_RENAMES[cn]
    if class_name in RESOURCE_RENAMES:
        return RESOURCE_RENAMES[class_name]

    # Strip 'harvestable_(mineral|ore)_<size>_' prefix to get the
    # mineral/ore core name. Sizes seen so far: 1H. Be permissive on
    # size in case CIG adds 2H, etc.
    core = cn
    m = re.match(r"^harvestable_(?:mineral|ore)_[^_]+_(.+)$", cn)
    if m:
        core = m.group(1)
    elif cn.startswith("harvestable_"):
        core = cn.split("_", 1)[1]

    key = f"items_commodities_{core}"
    if key in loc:
        return loc[key]

    for prefix in ("item_name", "item_name_"):
        if (prefix + cn) in loc:
            return loc[prefix + cn]

    if class_name in scitem_display:
        return scitem_display[class_name]

    return class_name.replace("_", " ")


def _extract_costs(node, out_list, loc, scitem_display, parent_context=None):
    """Recursively flatten a CraftingCost_Select tree into a flat
    ingredients list. Handles the three node shapes the schema uses:
    Select (container), Resource (concrete), Item (concrete entity).

    `loc` and `scitem_display` are forwarded into Item-cost resolution
    so we can localize harvestable-mineral ingredient names without
    needing a hardcoded RESOURCE_RENAMES entry per CIG addition."""
    if not isinstance(node, dict):
        return

    # CraftingCost_Resource — concrete ingredient line
    if "resource" in node and "quantity" in node:
        resource = _resource_name_from_ref(node["resource"])
        qty_data = node.get("quantity") or {}
        qty = qty_data.get("standardCargoUnits", 0) if isinstance(qty_data, dict) else 0
        if resource:
            # ResourceType.<X> short names usually come back human-readable
            # ("Iron", "Aluminum"), but a few carry underscores (e.g.
            # ResourceType.Pressurized_Ice). Run them through the same
            # localization resolver as item-class refs so multi-word names
            # render properly without per-name hardcoding.
            display = _resolve_item_class_display(resource, loc, scitem_display)
            entry = {
                "type": "resource",
                "resource": display,
                "quantity": round(qty or 0, 4),
                "minQuality": node.get("minQuality", 0),
            }
            if parent_context:
                entry["qualityModifiers"] = parent_context
            out_list.append(entry)
        return

    # CraftingCost_Item — entity-class ingredient
    if "entityClass" in node and "quantity" in node:
        ec = node.get("entityClass")
        if isinstance(ec, str):
            ec = _entity_class_from_path(ec) if ec.startswith("file://") else ec
        elif isinstance(ec, dict):
            ec = _entity_class_from_path(ec.get("path", "")) or _resource_name_from_ref(ec)
        qty = node.get("quantity")
        if isinstance(qty, dict):
            qty = qty.get("standardCargoUnits", 0)
        if ec:
            display = _resolve_item_class_display(ec, loc, scitem_display)
            entry = {
                "type": "item",
                "resource": display,
                "quantity": qty or 0,
            }
            if parent_context:
                entry["qualityModifiers"] = parent_context
            out_list.append(entry)
        return

    # CraftingCost_Select — container, may carry quality modifiers in its context
    if "options" in node:
        context = node.get("context") or []
        quality_mods = _extract_quality_modifiers(context)
        for opt in node.get("options") or []:
            _extract_costs(opt, out_list, loc, scitem_display,
                           quality_mods if quality_mods else parent_context)


# ─── main ────────────────────────────────────────────────────────

def parse_dcb():
    """Public entry point — name kept for back-compat with versedb_extract.py."""
    return parse_starbreaker()


def parse_starbreaker():
    print(f"Querying starbreaker for CraftingBlueprintRecord ({_DATA_MODE} DCB)...")
    raw = _query_records("CraftingBlueprintRecord")
    records = _split_concatenated_json(raw)
    print(f"  Parsed {len(records)} records from starbreaker")

    print("Loading localization + display caches...")
    loc = _load_localization()
    print(f"  {len(loc)} localization entries")
    scitem_display = _build_scitem_display_cache(loc)
    print(f"  Built scitem display name cache: {len(scitem_display)} items")
    resolve_item_name = _make_resolve_item_name(loc, scitem_display)

    print("Querying CraftingGameplayPropertyDef for property name resolution...")
    prop_name_map = _build_property_name_map(loc)
    print(f"  Mapped {len(prop_name_map)} gameplay properties")

    recipes_out = []
    unmapped_categories = Counter()
    skipped_no_entity = 0

    for rec_text in records:
        try:
            rec = json.loads(rec_text)
        except Exception:
            continue
        rn = rec.get("_RecordName_", "")
        if not rn.startswith("CraftingBlueprintRecord.BP_CRAFT_"):
            continue  # skip Global*, helper records

        bp = (rec.get("_RecordValue_") or {}).get("blueprint") or {}
        if not isinstance(bp, dict):
            continue

        psd = bp.get("processSpecificData") or {}
        entity_path = psd.get("entityClass") if isinstance(psd, dict) else None
        entity_class = _entity_class_from_path(entity_path)
        if not entity_class:
            skipped_no_entity += 1
            continue

        cat_ref = bp.get("category") or {}
        cat_full = cat_ref.get("_RecordName_", "") if isinstance(cat_ref, dict) else ""
        cat_short = cat_full.replace("BlueprintCategoryRecord.", "")
        category = _map_category(cat_short, entity_path)
        if category.startswith("Vehicle"):  # didn't map, keep but flag
            unmapped_categories[cat_short] += 1

        item_name = resolve_item_name(entity_class)

        for ti, tier in enumerate(bp.get("tiers") or []):
            if not isinstance(tier, dict):
                continue
            recipe = tier.get("recipe")
            if not isinstance(recipe, dict):
                continue
            costs = recipe.get("costs")
            if not isinstance(costs, dict):
                continue

            ct = costs.get("craftTime") or {}
            craft_seconds = (
                (ct.get("days", 0) or 0) * 86400 +
                (ct.get("hours", 0) or 0) * 3600 +
                (ct.get("minutes", 0) or 0) * 60 +
                (ct.get("seconds", 0) or 0)
            )

            ingredients = []
            mc = costs.get("mandatoryCost")
            if isinstance(mc, dict):
                for opt in mc.get("options") or []:
                    _extract_costs(opt, ingredients, loc, scitem_display)

            optional_ingredients = []
            for oc in costs.get("optionalCosts") or []:
                if isinstance(oc, dict):
                    _extract_costs(oc, optional_ingredients, loc, scitem_display)

            # Research data (optional, not all recipes have it)
            research_data = None
            research = tier.get("research")
            if isinstance(research, dict):
                rc = research.get("researchCosts")
                if isinstance(rc, dict):
                    rct = rc.get("craftTime") or {}
                    research_seconds = (
                        (rct.get("days", 0) or 0) * 86400 +
                        (rct.get("hours", 0) or 0) * 3600 +
                        (rct.get("minutes", 0) or 0) * 60 +
                        (rct.get("seconds", 0) or 0)
                    )
                    research_ingredients = []
                    rmc = rc.get("mandatoryCost")
                    if isinstance(rmc, dict):
                        for ro in rmc.get("options") or []:
                            _extract_costs(ro, research_ingredients, loc, scitem_display)
                    if research_seconds > 0 or research_ingredients:
                        research_data = {
                            "timeSeconds": round(research_seconds),
                            "ingredients": research_ingredients,
                        }

            entry = {
                "className": entity_class,
                "itemName": item_name,
                "category": category,
                "subtype": _infer_subtype(entity_class, category),
                "tier": ti,
                "craftTimeSeconds": round(craft_seconds),
                "ingredients": ingredients,
            }
            if optional_ingredients:
                entry["optionalIngredients"] = optional_ingredients
            if research_data:
                entry["research"] = research_data
            recipes_out.append(entry)

    print(f"  Extracted {len(recipes_out)} recipes ({skipped_no_entity} skipped: no entityClass)")
    if unmapped_categories:
        print(f"  Unmapped categories (kept as-is): {dict(unmapped_categories)}")

    # Resolve property short names → display + unit on every quality
    # modifier. starbreaker hands back path basenames in lowercase
    # (gpp_weapon_recoil_kick) while the property-def records are
    # CamelCase (GPP_Weapon_Recoil_Kick), so build a case-insensitive
    # index and look up via that.
    prop_name_map_ci = {k.lower(): v for k, v in prop_name_map.items()}
    mod_resolved = mod_unresolved = 0
    for r in recipes_out:
        for ing in r.get("ingredients", []) + r.get("optionalIngredients", []):
            for m in ing.get("qualityModifiers", []):
                short = m.get("property", "")
                display, unit = prop_name_map_ci.get(short.lower(), (short, ""))
                m["property"] = display
                m["unit"] = unit
                if display == short:
                    mod_unresolved += 1
                else:
                    mod_resolved += 1
    print(f"  Quality modifiers resolved: {mod_resolved} (unresolved: {mod_unresolved})")

    # Dedupe by className AND itemName (skin/colorway variants share names)
    seen_cls, seen_name, unique = set(), set(), []
    for r in recipes_out:
        if r["className"] in seen_cls or r["itemName"] in seen_name:
            continue
        seen_cls.add(r["className"])
        seen_name.add(r["itemName"])
        unique.append(r)
    print(f"  Unique recipes: {len(unique)}")

    # Sample print for sanity
    print("\nSample recipes:")
    for r in unique[:8]:
        ing_str = ", ".join(f"{i['resource']}×{i['quantity']}" for i in r.get("ingredients", []))
        print(f"  {r['itemName']} ({r['category']}/{r['subtype'] or '-'}) - {r['craftTimeSeconds']}s - {ing_str}")

    output = {
        "meta": {"totalRecipes": len(unique), "categories": {}},
        "recipes": unique,
    }
    for r in unique:
        cat = r.get("category", "Unknown")
        output["meta"]["categories"][cat] = output["meta"]["categories"].get(cat, 0) + 1

    out_path = Path(__file__).parent / "versedb_crafting.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved to {out_path}")

    app_path = Path(__file__).parent / "../app/public" / _DATA_MODE / "versedb_crafting.json"
    app_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out_path, app_path)
    print(f"Copied to {app_path}")

    return output


if __name__ == "__main__":
    parse_dcb()

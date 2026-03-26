#!/usr/bin/env python3
"""
Extract crafting recipe data from Game2.dcb (DCB v6).
Outputs: versedb_crafting.json with all crafting blueprints, recipes, and ingredients.
"""

import struct, json, sys, re
from pathlib import Path

import os
_SC = Path(__file__).resolve().parent.parent / "SC FILES"
_DATA_MODE = os.environ.get("VERSEDB_DATA_MODE", "live")
DCB_FILE = _SC / f"sc_data_{_DATA_MODE}" / "Data" / "Game2.dcb"
LOC_FILE = _SC / f"sc_data_xml_{_DATA_MODE}" / "Data" / "Localization" / "english" / "global.ini"

# Clean up entity class names to display names
RESOURCE_RENAMES = {
    "Harvestable_Mineral_1H_Aphorite": "Aphorite",
    "Harvestable_Mineral_1H_Beradom": "Beradon",
    "Harvestable_Mineral_1H_Carinite": "Carinite",
    "Harvestable_Mineral_1H_Dolivine": "Dolivine",
    "Harvestable_Mineral_1H_Hadanite": "Hadanite",
    "Harvestable_Mineral_1H_Janalite": "Janalite",
    "Harvestable_Mineral_1H_Sadaryx": "Sadaryx",
    "Harvestable_Ore_1H_SaldyniumOre": "Saldynium Ore",
}

DTYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 2, 8: 4, 9: 8,
    10: 4, 11: 4, 12: 16, 13: 4, 14: 4, 15: 4,
    16: 8, 272: 8, 784: 20,
}


def parse_dcb():
    with open(DCB_FILE, "rb") as f:
        d = f.read()

    def u32(p): return struct.unpack_from("<I", d, p)[0]
    def i32(p): return struct.unpack_from("<i", d, p)[0]
    def u16(p): return struct.unpack_from("<H", d, p)[0]
    def f32(p): return struct.unpack_from("<f", d, p)[0]

    pos = 4; version = i32(pos); pos += 4
    if version >= 6: pos += 8
    n_structs = i32(pos); pos += 4
    n_props   = i32(pos); pos += 4
    n_enums   = i32(pos); pos += 4
    n_mappings= i32(pos); pos += 4
    n_records = i32(pos); pos += 4
    counts = [i32(pos + i*4) for i in range(19)]; pos += 76
    (c_bool,c_i8,c_i16,c_i32,c_i64,c_u8,c_u16,c_u32,c_u64,c_f32,
     c_f64,c_guid,c_str,c_loc,c_enum,c_strong,c_weak,c_ref,c_enum_opts) = counts
    text_len = u32(pos); pos += 4
    blob_len = u32(pos); pos += 4

    struct_defs = []
    for _ in range(n_structs):
        struct_defs.append((u32(pos), u32(pos+4), u16(pos+8), u16(pos+10), u32(pos+12)))
        pos += 16
    prop_defs = []
    for _ in range(n_props):
        prop_defs.append((u32(pos), u16(pos+4), u16(pos+6), u16(pos+8), u16(pos+10)))
        pos += 12
    pos += n_enums * 8
    mappings = []
    for _ in range(n_mappings):
        mappings.append((u32(pos), u32(pos+4))); pos += 8
    rec_start = pos
    pos += n_records * 32
    # Value arrays
    for c, s in zip(counts, [1,1,2,4,8,1,2,4,8,4,8,16,4,4,4,8,8,20,4]):
        pos += c * s
    text_start = pos
    blob_start = text_start + text_len
    data_start = blob_start + blob_len
    # Strong pointer array
    va_strong = text_start - c_enum_opts*4 - c_ref*20 - c_weak*8 - c_strong*8
    # Recalculate properly
    p = rec_start + n_records*32
    p += c_bool + c_i8 + c_i16*2 + c_i32*4 + c_i64*8
    p += c_u8 + c_u16*2 + c_u32*4 + c_u64*8
    p += c_f32*4 + c_f64*8 + c_guid*16
    p += c_str*4 + c_loc*4 + c_enum*4
    va_strong = p
    p += c_strong*8 + c_weak*8 + c_ref*20 + c_enum_opts*4
    assert p == text_start

    def blob(off):
        p = blob_start + off; return d[p:d.index(b'\x00', p)].decode('utf-8', 'replace')
    def text(off):
        p = text_start + off; return d[p:d.index(b'\x00', p)].decode('utf-8', 'replace')
    def read_strong_ptr(idx):
        if idx >= c_strong: return None, None
        off = va_strong + idx * 8
        return u32(off), u32(off + 4)

    struct_by_name, struct_names = {}, {}
    for i, (name_off, par, ac, fa, rs) in enumerate(struct_defs):
        try:
            n = blob(name_off); struct_by_name[n] = i; struct_names[i] = n
        except: pass

    struct_data = {}
    off = data_start
    for cnt, si in mappings:
        if si < len(struct_defs):
            struct_data[si] = (off, cnt); off += struct_defs[si][4] * cnt

    prop_names = {}
    for i, (pn_off, _, _, _, _) in enumerate(prop_defs):
        try: prop_names[i] = blob(pn_off)
        except: prop_names[i] = f"prop_{i}"

    def get_props(si, visited=None):
        if visited is None: visited = set()
        if si in visited or si >= len(struct_defs): return []
        visited.add(si)
        sdef = struct_defs[si]
        parent_si, attr_count, first_attr = sdef[1], sdef[2], sdef[3]
        parent_props = []
        if parent_si != 0xFFFFFFFF and parent_si != si:
            parent_props = get_props(parent_si, visited)
        own = [(pi, prop_defs[pi]) for pi in range(first_attr, first_attr + attr_count) if pi < len(prop_defs)]
        parent_names = {prop_names.get(pi): (pi, pd) for pi, pd in parent_props}
        for pi, pd in own:
            pn = prop_names.get(pi)
            if pn in parent_names: del parent_names[pn]
        return list(parent_names.values()) + own

    # ── Build GUID → record name map ──
    print("Building GUID → record name map...")
    guid_to_name = {}
    for i in range(n_records):
        roff = rec_start + i * 32
        guid = d[roff + 12 : roff + 28]
        try:
            name = blob(u32(roff))  # e.g. "EntityClassDefinition.volt_sniper_energy_01"
            guid_to_name[guid] = name
        except:
            pass
    print(f"  {len(guid_to_name)} records mapped")

    # ── Load localization for item display names ──
    loc = {}
    if LOC_FILE.exists():
        with open(LOC_FILE, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    loc[k.lower()] = v
    print(f"  {len(loc)} localization entries loaded")

    def resolve_loc(key_raw):
        """Resolve a @LOC key or raw key to display text."""
        key = key_raw.lstrip("@").lower()
        # Try exact, then with ,p suffix stripped (localization uses key,P= format)
        if key in loc:
            return loc[key]
        if key + ",p" in loc:
            return loc[key + ",p"]
        return key_raw

    def resolve_item_name(class_name):
        """Resolve an entity class name to a display name via localization."""
        cn = class_name.lower()
        for prefix in ["item_name", "item_name_"]:
            key = prefix + cn
            if key in loc:
                return loc[key]
        parts = cn.split("_")
        for trim in range(1, min(4, len(parts))):
            shorter = "_".join(parts[:-trim])
            for prefix in ["item_name", "item_name_"]:
                key = prefix + shorter
                if key in loc:
                    return loc[key]
        return class_name

    # ── Generic struct reader ──
    def read_struct(si, instance_idx, depth=0):
        if depth > 14 or si >= len(struct_defs) or si not in struct_data:
            return None
        rec_size = struct_defs[si][4]
        base_off, total_cnt = struct_data[si]
        if instance_idx >= total_cnt: return None
        inst_off = base_off + instance_idx * rec_size
        result = {}
        byte_pos = 0

        for pi, (pn_off, sref, dtype, conv, pad) in get_props(si):
            pname = prop_names.get(pi, f"prop_{pi}")
            size = DTYPE_SIZE.get(dtype, 4)
            if byte_pos + size > rec_size: break

            if conv == 1 and dtype in (272, 16):
                arr_count = u32(inst_off + byte_pos)
                arr_first = u32(inst_off + byte_pos + 4)
                items = []
                if 0 < arr_count < 5000:
                    for ai in range(arr_count):
                        sp_si, sp_ii = read_strong_ptr(arr_first + ai)
                        if sp_si is not None and sp_si < len(struct_defs):
                            item = read_struct(sp_si, sp_ii, depth + 1)
                            if item: items.append(item)
                result[pname] = items
                byte_pos += 8

            elif dtype == 272:
                child_si = u32(inst_off + byte_pos)
                child_ii = u32(inst_off + byte_pos + 4)
                if child_si == 0xFFFFFFFF:
                    result[pname] = None
                else:
                    result[pname] = read_struct(child_si, child_ii, depth + 1)
                byte_pos += 8

            elif dtype == 784:
                rec_guid = d[inst_off + byte_pos + 4 : inst_off + byte_pos + 20]
                rec_name = guid_to_name.get(rec_guid)
                if rec_name:
                    # Extract the short name after the dot
                    result[pname] = rec_name.split(".", 1)[-1] if "." in rec_name else rec_name
                else:
                    result[pname] = None
                byte_pos += 20

            elif dtype == 16:
                child_si = u32(inst_off + byte_pos)
                child_ii = u32(inst_off + byte_pos + 4)
                if child_si == 0xFFFFFFFF or child_si >= len(struct_defs):
                    result[pname] = None
                else:
                    result[pname] = read_struct(child_si, child_ii, depth + 1)
                byte_pos += 8

            elif dtype == 1:
                result[pname] = bool(d[inst_off + byte_pos]); byte_pos += 1
            elif dtype in (2, 6):
                result[pname] = d[inst_off + byte_pos]; byte_pos += 1
            elif dtype in (3, 7):
                result[pname] = u16(inst_off + byte_pos); byte_pos += 2
            elif dtype == 4:
                result[pname] = i32(inst_off + byte_pos); byte_pos += 4
            elif dtype in (8, 15):
                result[pname] = u32(inst_off + byte_pos); byte_pos += 4
            elif dtype == 11:
                result[pname] = round(f32(inst_off + byte_pos), 6); byte_pos += 4
            elif dtype == 10:
                try: result[pname] = text(u32(inst_off + byte_pos))
                except: result[pname] = None
                byte_pos += 4
            elif dtype == 13:
                try: result[pname] = text(u32(inst_off + byte_pos))
                except: result[pname] = None
                byte_pos += 4
            elif dtype == 12:
                result[pname] = d[inst_off+byte_pos:inst_off+byte_pos+16].hex(); byte_pos += 16
            elif dtype in (5, 9):
                result[pname] = struct.unpack_from("<Q", d, inst_off + byte_pos)[0]; byte_pos += 8
            else:
                result[pname] = u32(inst_off + byte_pos); byte_pos += size
        return result

    # ── Build property name map from CraftingGameplayPropertyDef ──
    # These are referenced by record GUID. Build: record_short_name → display name
    gpd_si = struct_by_name.get("CraftingGameplayPropertyDef")
    prop_display_names = {}  # short record name → localized display name
    prop_units = {}          # short record name → unit format string
    if gpd_si and gpd_si in struct_data:
        gpd_off, gpd_cnt = struct_data[gpd_si]
        gpd_rs = struct_defs[gpd_si][4]
        for i in range(gpd_cnt):
            base = gpd_off + i * gpd_rs
            try:
                pn_raw = text(u32(base))      # e.g. "@StatName_GPP_Weapon_Damage"
                uf_raw = text(u32(base + 4))  # e.g. "@StatUnits_Percent"
                # Now find which record points to this struct instance
                # We match by scanning guid_to_name for CraftingGameplayPropertyDef records
                pn_display = resolve_loc(pn_raw)
                uf_display = resolve_loc(uf_raw)
                # Store by index — we'll match later via record name
                prop_display_names[i] = pn_display
                prop_units[i] = uf_display
            except:
                pass
        print(f"  {len(prop_display_names)} gameplay property defs loaded")

    # Build record name → property index map
    # Record names like "CraftingGameplayPropertyDef.GPP_Weapon_Damage"
    gpd_record_to_idx = {}
    for rec_name, idx in []:  # placeholder — need to match records to struct instances
        pass
    # Actually: CraftingGameplayPropertyDef records have struct_index == gpd_si.
    # Their instance index maps 1:1 with struct_data. Let me find them by scanning records.
    if gpd_si is not None:
        for i in range(n_records):
            roff = rec_start + i * 32
            r_si_val = u32(roff + 8)
            if r_si_val == gpd_si:
                try:
                    rname = blob(u32(roff)).split(".", 1)[-1]
                    guid = d[roff + 12 : roff + 28]
                    # Match this record to a struct instance index
                    # Records for this struct should map to sequential instances
                    gpd_record_to_idx[rname] = len(gpd_record_to_idx)
                except:
                    pass

    def resolve_property_name(raw_name):
        """Resolve a CraftingGameplayPropertyDef record short name to display name + unit."""
        if not raw_name:
            return raw_name, ""
        idx = gpd_record_to_idx.get(raw_name)
        if idx is not None:
            return prop_display_names.get(idx, raw_name), prop_units.get(idx, "")
        return raw_name, ""

    # ══════════════════════════════════════════════════════════════
    # Extract all crafting blueprints
    # ══════════════════════════════════════════════════════════════
    bp_si = struct_by_name["CraftingBlueprint"]
    bp_cnt = struct_data[bp_si][1]
    print(f"\nReading {bp_cnt} CraftingBlueprint instances...")

    recipes_out = []
    errors = 0

    for i in range(bp_cnt):
        bp = read_struct(bp_si, i)
        if not bp:
            errors += 1
            continue

        entity_class = None
        psd = bp.get("processSpecificData")
        if psd and isinstance(psd, dict):
            entity_class = psd.get("entityClass")

        if not entity_class:
            continue

        item_name = resolve_item_name(entity_class)
        category = bp.get("category", "Unknown")

        tiers = bp.get("tiers", [])
        for ti, tier in enumerate(tiers):
            if not isinstance(tier, dict):
                continue
            recipe = tier.get("recipe")
            if not isinstance(recipe, dict):
                continue

            costs = recipe.get("costs")
            if not isinstance(costs, dict):
                continue

            # Extract craft time
            ct = costs.get("craftTime", {}) or {}
            craft_seconds = (ct.get("days", 0) or 0) * 86400 + \
                          (ct.get("hours", 0) or 0) * 3600 + \
                          (ct.get("minutes", 0) or 0) * 60 + \
                          (ct.get("seconds", 0) or 0)

            # Extract mandatory cost
            mc = costs.get("mandatoryCost")
            ingredients = []
            if isinstance(mc, dict):
                # CraftingCost_Select: has count + options
                sel_count = mc.get("count", 0)
                options = mc.get("options", [])
                for opt in options:
                    if not isinstance(opt, dict):
                        continue
                    # Each option can be CraftingCost_Select (nested) or CraftingCost_Resource
                    _extract_costs(opt, ingredients)

            # Extract optional costs
            opt_costs = costs.get("optionalCosts", [])
            optional_ingredients = []
            if isinstance(opt_costs, list):
                for oc in opt_costs:
                    if isinstance(oc, dict):
                        _extract_costs(oc, optional_ingredients)

            # Research
            research = tier.get("research")
            research_data = None
            if isinstance(research, dict):
                rc = research.get("researchCosts")
                if isinstance(rc, dict):
                    rct = rc.get("craftTime", {}) or {}
                    research_seconds = (rct.get("days", 0) or 0) * 86400 + \
                                     (rct.get("hours", 0) or 0) * 3600 + \
                                     (rct.get("minutes", 0) or 0) * 60 + \
                                     (rct.get("seconds", 0) or 0)
                    research_ingredients = []
                    rmc = rc.get("mandatoryCost")
                    if isinstance(rmc, dict):
                        r_options = rmc.get("options", [])
                        for ro in r_options:
                            if isinstance(ro, dict):
                                _extract_costs(ro, research_ingredients)
                    if research_seconds > 0 or research_ingredients:
                        research_data = {
                            "timeSeconds": round(research_seconds),
                            "ingredients": research_ingredients,
                        }

            subtype = _infer_subtype(entity_class, category)
            entry = {
                "className": entity_class,
                "itemName": item_name,
                "category": category,
                "subtype": subtype,
                "tier": ti,
                "craftTimeSeconds": round(craft_seconds),
                "ingredients": ingredients,
            }
            if optional_ingredients:
                entry["optionalIngredients"] = optional_ingredients
            if research_data:
                entry["research"] = research_data

            recipes_out.append(entry)

    print(f"  Extracted {len(recipes_out)} recipes ({errors} errors)")

    # Post-process: resolve property names in quality modifiers
    mod_resolved = 0
    for r in recipes_out:
        for ing in r.get("ingredients", []) + r.get("optionalIngredients", []):
            qm = ing.get("qualityModifiers", [])
            for m in qm:
                raw = m.get("property", "")
                display, unit = resolve_property_name(raw)
                m["property"] = display
                m["unit"] = unit
                mod_resolved += 1
    print(f"  Quality modifiers resolved: {mod_resolved}")

    # Deduplicate by className
    seen = {}
    unique = []
    for r in recipes_out:
        key = r["className"]
        if key not in seen:
            seen[key] = True
            unique.append(r)
    print(f"  Unique recipes: {len(unique)}")

    # Print sample recipes
    print(f"\n{'='*80}")
    print("SAMPLE RECIPES:")
    for r in unique[:20]:
        ing_str = ", ".join(f"{i['resource']}×{i['quantity']}" for i in r.get('ingredients', []))
        research_str = ""
        if r.get("research"):
            rt = r["research"]["timeSeconds"]
            ri = ", ".join(f"{i['resource']}×{i['quantity']}" for i in r["research"].get("ingredients", []))
            research_str = f"  [Research: {rt}s, {ri}]"
        print(f"  {r['itemName']} ({r['category']}) - {r['craftTimeSeconds']}s - {ing_str}{research_str}")

    # Save output
    output = {
        "meta": {
            "totalRecipes": len(unique),
            "categories": {},
        },
        "recipes": unique,
    }
    for r in unique:
        cat = r.get("category", "Unknown")
        output["meta"]["categories"][cat] = output["meta"]["categories"].get(cat, 0) + 1

    out_path = Path(__file__).parent / "versedb_crafting.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved to {out_path}")

    # Auto-copy to Angular app (mode-aware subfolder)
    import shutil, os
    _data_mode = os.environ.get("VERSEDB_DATA_MODE", "live")
    app_path = Path(__file__).parent / "../../versedb-app/public" / _data_mode / "versedb_crafting.json"
    app_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out_path, app_path)
    print(f"Copied to {app_path}")

    return output


def _infer_subtype(class_name, category):
    """Infer item subtype from className patterns."""
    cn = class_name.lower()
    if category == "FPSWeapons":
        for wtype in ("sniper", "pistol", "rifle", "smg", "shotgun", "lmg"):
            if f"_{wtype}_" in cn or f"_{wtype}" == cn[-len(wtype)-1:]:
                return wtype.upper() if wtype in ("smg", "lmg") else wtype.capitalize()
        return "Other"
    elif category == "FPSArmours":
        if "_helmet_" in cn or cn.endswith("_helmet"):
            return "Helmet"
        elif "_arms_" in cn or cn.endswith("_arms"):
            return "Arms"
        elif "_legs_" in cn or cn.endswith("_legs"):
            return "Legs"
        elif "_core_" in cn or cn.endswith("_core") or "_backpack_" in cn:
            return "Core"
        elif "_undersuit_" in cn:
            return "Undersuit"
        return "Other"
    return ""


def _extract_quality_modifiers(context_list, resolve_loc_fn):
    """Extract quality modifiers from a context array."""
    modifiers = []
    if not isinstance(context_list, list):
        return modifiers
    for ctx in context_list:
        if not isinstance(ctx, dict):
            continue
        gpm = ctx.get("gameplayPropertyModifiers")
        if not isinstance(gpm, dict):
            continue
        gpm_list = gpm.get("gameplayPropertyModifiers", [])
        if not isinstance(gpm_list, list):
            continue
        for mod_common in gpm_list:
            if not isinstance(mod_common, dict):
                continue
            prop_name_raw = mod_common.get("gameplayPropertyRecord")
            value_ranges = mod_common.get("valueRanges", [])
            if not prop_name_raw or not isinstance(value_ranges, list):
                continue
            # Resolve property name (it's a record ref short name like a loc key)
            # The CraftingGameplayPropertyDef has propertyName (locale) and unitFormat (locale)
            # But through record ref we just get the record name. We need the actual struct data.
            # For now, store the raw name — we'll resolve it below.
            for vr in value_ranges:
                if not isinstance(vr, dict):
                    continue
                sq = vr.get("startQuality", 0)
                eq = vr.get("endQuality", 0)
                ms = vr.get("modifierAtStart", 1.0)
                me = vr.get("modifierAtEnd", 1.0)
                if sq == eq == 0 and ms == me == 1.0:
                    continue
                modifiers.append({
                    "property": prop_name_raw,
                    "startQuality": sq,
                    "endQuality": eq,
                    "modifierAtStart": round(ms, 4),
                    "modifierAtEnd": round(me, 4),
                })
    return modifiers


def _extract_costs(node, out_list, parent_context=None):
    """Recursively extract cost entries from CraftingCost_Select / CraftingCost_Resource / CraftingCost_Item."""
    if not isinstance(node, dict):
        return

    # CraftingCost_Resource: has 'resource' and 'quantity'
    if "resource" in node and "quantity" in node:
        resource = node["resource"]
        qty_data = node.get("quantity", {}) or {}
        if isinstance(qty_data, dict):
            qty = qty_data.get("standardCargoUnits", 0) or 0
        else:
            qty = 0
        if resource:
            display = RESOURCE_RENAMES.get(resource, resource)
            entry = {
                "type": "resource",
                "resource": display,
                "quantity": round(qty, 4),
                "minQuality": node.get("minQuality", 0),
            }
            if parent_context:
                entry["qualityModifiers"] = parent_context
            out_list.append(entry)
        return

    # CraftingCost_Item: has 'entityClass' and 'quantity'
    if "entityClass" in node and "quantity" in node:
        ec = node["entityClass"]
        qty = node.get("quantity", 0)
        if ec:
            display = RESOURCE_RENAMES.get(ec, ec)
            entry = {
                "type": "item",
                "resource": display,
                "quantity": qty,
            }
            if parent_context:
                entry["qualityModifiers"] = parent_context
            out_list.append(entry)
        return

    # CraftingCost_Select: has 'options' array
    if "options" in node:
        # Extract quality modifiers from this Select's context
        context = node.get("context", [])
        quality_mods = _extract_quality_modifiers(context, None)

        options = node.get("options", [])
        if isinstance(options, list):
            for opt in options:
                _extract_costs(opt, out_list, quality_mods if quality_mods else parent_context)


if __name__ == "__main__":
    parse_dcb()

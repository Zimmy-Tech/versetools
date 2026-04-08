"""
versedb_baseline_diff.py
========================
Diff engine for VerseDB baseline system.

Compares a fresh scrape result against the saved baseline and classifies
changes as auto-accept (value updates) or needs-review (structural changes).

Usage:
    from versedb_baseline_diff import run_baseline_update
    output = run_baseline_update(scrape_ships, scrape_items, scrape_meta,
                                 mining_locations, mining_elements)
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BASELINE_FILE = Path(__file__).parent / "versedb_baseline.json"

# ── Fields that auto-accept changes (stat values, balance tweaks) ────────────
# Everything NOT in STRUCTURAL_SHIP_FIELDS is a stat field and auto-accepts.
STRUCTURAL_SHIP_FIELDS = {"hardpoints"}

# Hardpoint fields that are structural (changes need review)
STRUCTURAL_HP_FIELDS = {"minSize", "maxSize", "type", "subtypes", "allTypes", "flags", "portTags"}

# Hardpoint fields that auto-accept
VALUE_HP_FIELDS = {"label"}


def load_baseline():
    """Load the baseline file, or return None if it doesn't exist."""
    if not BASELINE_FILE.exists():
        return None
    with open(BASELINE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_baseline(baseline):
    """Write the baseline back to disk."""
    with open(BASELINE_FILE, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2, ensure_ascii=False)


# ── Diff logic ───────────────────────────────────────────────────────────────

def _diff_hardpoints(baseline_hps, scrape_hps):
    """Compare hardpoint lists between baseline and scrape.

    Returns:
        auto_changes: list of value-level hardpoint changes (auto-accept)
        review_changes: list of structural hardpoint changes (need approval)
    """
    base_by_id = {hp["id"].lower(): hp for hp in baseline_hps}
    scrape_by_id = {hp["id"].lower(): hp for hp in scrape_hps}

    auto_changes = []
    review_changes = []

    # Hardpoints removed in scrape
    for hp_id in sorted(set(base_by_id) - set(scrape_by_id)):
        hp = base_by_id[hp_id]
        review_changes.append({
            "action": "hardpoint_removed",
            "hardpoint": hp["id"],
            "label": hp.get("label", hp["id"]),
            "detail": f"Size {hp.get('minSize','?')}-{hp.get('maxSize','?')} {hp.get('type','')}",
        })

    # Hardpoints added in scrape
    for hp_id in sorted(set(scrape_by_id) - set(base_by_id)):
        hp = scrape_by_id[hp_id]
        review_changes.append({
            "action": "hardpoint_added",
            "hardpoint": hp["id"],
            "label": hp.get("label", hp["id"]),
            "detail": f"Size {hp.get('minSize','?')}-{hp.get('maxSize','?')} {hp.get('type','')}",
            "data": hp,
        })

    # Hardpoints in both — check for changes
    for hp_id in sorted(set(base_by_id) & set(scrape_by_id)):
        base_hp = base_by_id[hp_id]
        scrape_hp = scrape_by_id[hp_id]

        for field in STRUCTURAL_HP_FIELDS:
            base_val = base_hp.get(field)
            scrape_val = scrape_hp.get(field)
            if base_val != scrape_val:
                review_changes.append({
                    "action": "hardpoint_changed",
                    "hardpoint": base_hp["id"],
                    "label": base_hp.get("label", base_hp["id"]),
                    "field": field,
                    "old": base_val,
                    "new": scrape_val,
                })

        for field in VALUE_HP_FIELDS:
            base_val = base_hp.get(field)
            scrape_val = scrape_hp.get(field)
            if base_val != scrape_val:
                auto_changes.append({
                    "action": "hardpoint_value_changed",
                    "hardpoint": base_hp["id"],
                    "field": field,
                    "old": base_val,
                    "new": scrape_val,
                })

    return auto_changes, review_changes


def diff_ships(baseline_ships, scrape_ships):
    """Compare all ships between baseline and scrape.

    Returns:
        auto_applied: list of auto-accepted changes
        review_needed: list of changes requiring approval
        coverage: dict with coverage stats
    """
    base_by_cls = {s["className"]: s for s in baseline_ships}
    scrape_by_cls = {s["className"]: s for s in scrape_ships}

    auto_applied = []
    review_needed = []

    # Ships missing from scrape — NEVER remove, always auto-reject
    # Ships can disappear due to forge export gaps, not actual CIG removals
    missing = sorted(set(base_by_cls) - set(scrape_by_cls))
    for cls in missing:
        ship = base_by_cls[cls]
        print(f"  [AUTO-KEPT] Ship preserved from baseline: {ship.get('name', cls)} ({cls})")
        # Carry forward the baseline ship into the scrape so enrichment can find it
        scrape_by_cls[cls] = ship

    # New ships in scrape
    added = sorted(set(scrape_by_cls) - set(base_by_cls))
    for cls in added:
        ship = scrape_by_cls[cls]
        review_needed.append({
            "type": "ship_added",
            "className": cls,
            "name": ship.get("name", cls),
            "manufacturer": ship.get("manufacturer", ""),
            "size": ship.get("size", ""),
            "role": ship.get("role", ""),
            "hardpointCount": len(ship.get("hardpoints", [])),
            "data": ship,
        })

    # Ships in both — diff fields
    for cls in sorted(set(base_by_cls) & set(scrape_by_cls)):
        base_ship = base_by_cls[cls]
        scrape_ship = scrape_by_cls[cls]
        ship_name = base_ship.get("name", cls)

        # Diff non-structural fields (auto-accept)
        stat_changes = []
        all_keys = set(base_ship.keys()) | set(scrape_ship.keys())
        skip_keys = {"_baseline", "_stale", "_staleDate", "hardpoints", "className"}

        for key in sorted(all_keys - skip_keys):
            base_val = base_ship.get(key)
            scrape_val = scrape_ship.get(key)
            if base_val != scrape_val:
                stat_changes.append({
                    "field": key,
                    "old": base_val,
                    "new": scrape_val,
                })

        if stat_changes:
            auto_applied.append({
                "type": "ship_stats_updated",
                "className": cls,
                "name": ship_name,
                "changes": stat_changes,
            })

        # Diff hardpoints (may need review)
        base_hps = base_ship.get("hardpoints", [])
        scrape_hps = scrape_ship.get("hardpoints", [])
        hp_auto, hp_review = _diff_hardpoints(base_hps, scrape_hps)

        if hp_auto:
            auto_applied.append({
                "type": "ship_hardpoint_values",
                "className": cls,
                "name": ship_name,
                "changes": hp_auto,
            })

        for change in hp_review:
            change["className"] = cls
            change["name"] = ship_name
            change["type"] = change.pop("action")
            review_needed.append(change)

    coverage = {
        "baseline_count": len(base_by_cls),
        "scrape_count": len(scrape_by_cls),
        "matched": len(set(base_by_cls) & set(scrape_by_cls)),
        "missing_from_scrape": missing,
        "new_in_scrape": added,
    }

    return auto_applied, review_needed, coverage


def diff_items(baseline_items, scrape_items, baseline_ships=None):
    """Compare items. Items auto-accept all changes; only flag add/remove.
    Items referenced by any ship's loadout are never removed."""
    base_by_cls = {i["className"]: i for i in baseline_items}
    scrape_by_cls = {i["className"]: i for i in scrape_items}

    auto_applied = []
    review_needed = []

    # Build set of items referenced by any ship's loadout
    loadout_items = set()
    if baseline_ships:
        for ship in baseline_ships:
            for item_cls in (ship.get("defaultLoadout") or {}).values():
                if item_cls:
                    loadout_items.add(item_cls.lower())

    # Items missing from scrape
    missing = sorted(set(base_by_cls) - set(scrape_by_cls))
    for cls in missing:
        item = base_by_cls[cls]
        # Auto-keep items referenced by ship loadouts
        if cls.lower() in loadout_items:
            print(f"  [AUTO-KEPT] Item preserved (referenced by ship loadout): {item.get('name', cls)} ({cls})")
            continue
        review_needed.append({
            "type": "item_missing",
            "className": cls,
            "name": item.get("name", cls),
            "itemType": item.get("type", ""),
        })

    # New items
    added = sorted(set(scrape_by_cls) - set(base_by_cls))
    for cls in added:
        item = scrape_by_cls[cls]
        auto_applied.append({
            "type": "item_added",
            "className": cls,
            "name": item.get("name", cls),
            "itemType": item.get("type", ""),
            "data": item,
        })

    # Items in both — auto-accept all stat changes
    updated_count = 0
    for cls in sorted(set(base_by_cls) & set(scrape_by_cls)):
        base_item = base_by_cls[cls]
        scrape_item = scrape_by_cls[cls]
        skip_keys = {"_baseline", "_stale", "_staleDate", "className"}
        changed = False
        for key in set(base_item.keys()) | set(scrape_item.keys()):
            if key in skip_keys:
                continue
            if base_item.get(key) != scrape_item.get(key):
                changed = True
                break
        if changed:
            updated_count += 1

    if updated_count:
        auto_applied.append({
            "type": "items_updated",
            "count": updated_count,
        })

    return auto_applied, review_needed


# ── Report formatting ────────────────────────────────────────────────────────

def _format_value(v):
    """Format a value for display, truncating long structures."""
    if v is None:
        return "None"
    if isinstance(v, (list, dict)):
        s = json.dumps(v, ensure_ascii=False)
        return s if len(s) <= 60 else s[:57] + "..."
    return str(v)


def print_report(ship_auto, ship_review, ship_coverage,
                 item_auto, item_review, version):
    """Print the update report to the console."""
    w = 64
    print(f"\n{'=' * w}")
    print(f"  VerseDB Baseline Update Report")
    print(f"  Scrape version: {version}")
    print(f"{'=' * w}")

    # Coverage
    cov = ship_coverage
    print(f"\n  COVERAGE")
    print(f"  {'Baseline ships:':<22} {cov['baseline_count']}")
    print(f"  {'Matched in scrape:':<22} {cov['matched']}")
    if cov['missing_from_scrape']:
        print(f"  {'Not in scrape:':<22} {len(cov['missing_from_scrape'])}")

    # Auto-applied summary
    ship_stat_count = sum(len(a.get("changes", [])) for a in ship_auto
                          if a["type"] == "ship_stats_updated")
    hp_value_count = sum(len(a.get("changes", [])) for a in ship_auto
                         if a["type"] == "ship_hardpoint_values")
    ships_touched = len([a for a in ship_auto if a["type"] == "ship_stats_updated"])
    items_added = sum(1 for a in item_auto if a["type"] == "item_added")
    items_updated = sum(a.get("count", 0) for a in item_auto if a["type"] == "items_updated")

    print(f"\n  AUTO-APPLIED")
    if ship_stat_count:
        print(f"    {ship_stat_count} stat changes across {ships_touched} ships")
        # Show per-ship details
        for entry in ship_auto:
            if entry["type"] != "ship_stats_updated":
                continue
            changes = entry["changes"]
            summaries = []
            for c in changes[:4]:
                summaries.append(f"{c['field']} {_format_value(c['old'])}→{_format_value(c['new'])}")
            extra = f" (+{len(changes)-4} more)" if len(changes) > 4 else ""
            print(f"      {entry['name']}: {', '.join(summaries)}{extra}")
    if hp_value_count:
        print(f"    {hp_value_count} hardpoint label changes")
    if items_added:
        print(f"    {items_added} new items added")
    if items_updated:
        print(f"    {items_updated} items with stat changes")
    if not (ship_stat_count or hp_value_count or items_added or items_updated):
        print(f"    No changes")

    # Review needed
    total_review = len(ship_review) + len(item_review)
    if total_review:
        print(f"\n  REVIEW REQUIRED ({total_review} items)")
    else:
        print(f"\n  REVIEW REQUIRED: None")

    return total_review


def _describe_review_item(idx, item):
    """Print a single review item description."""
    t = item["type"]
    if t == "ship_missing":
        print(f"\n  [{idx}] SHIP MISSING FROM SCRAPE")
        print(f"      {item['name']} ({item['className']})")
        print(f"      Last updated: {item['lastUpdated']}")
        print(f"      → Reject = keep in baseline (likely scrape issue)")
        print(f"      → Accept = remove from baseline (CIG removed it)")
    elif t == "ship_added":
        print(f"\n  [{idx}] NEW SHIP")
        print(f"      {item['name']} ({item['className']})")
        print(f"      {item.get('manufacturer','')} | {item.get('size','')} | {item.get('role','')}")
        print(f"      Hardpoints: {item.get('hardpointCount', 0)}")
        print(f"      → Accept = add to baseline")
    elif t == "hardpoint_removed":
        print(f"\n  [{idx}] HARDPOINT REMOVED — {item['name']}")
        print(f"      {item['hardpoint']} ({item.get('label', '')})")
        print(f"      Was: {item.get('detail', '')}")
        print(f"      → Reject = keep hardpoint (likely scrape issue)")
        print(f"      → Accept = remove hardpoint (CIG removed it)")
    elif t == "hardpoint_added":
        print(f"\n  [{idx}] HARDPOINT ADDED — {item['name']}")
        print(f"      {item['hardpoint']} ({item.get('label', '')})")
        print(f"      {item.get('detail', '')}")
        print(f"      → Accept = add to baseline")
    elif t == "hardpoint_changed":
        print(f"\n  [{idx}] HARDPOINT CHANGED — {item['name']}")
        print(f"      {item['hardpoint']} ({item.get('label', '')})")
        print(f"      {item['field']}: {_format_value(item['old'])} → {_format_value(item['new'])}")
        print(f"      → Accept = update baseline")
    elif t == "item_missing":
        print(f"\n  [{idx}] ITEM MISSING FROM SCRAPE")
        print(f"      {item['name']} ({item['className']}) [{item.get('itemType','')}]")
        print(f"      → Reject = keep in baseline")
        print(f"      → Accept = remove from baseline")


def prompt_review(review_items):
    """Interactive y/n prompts for each review item.

    Returns list of (index, accepted: bool) tuples.
    """
    decisions = []
    if not review_items:
        return decisions

    print(f"\n{'─' * 64}")

    for i, item in enumerate(review_items):
        _describe_review_item(i + 1, item)

        while True:
            try:
                answer = input(f"      Accept? (y/n/q to quit): ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print("\n  Aborted. No changes applied.")
                sys.exit(1)
            if answer == "q":
                print("  Remaining items rejected (baseline preserved).")
                # Reject all remaining
                for j in range(i, len(review_items)):
                    decisions.append((j, False))
                return decisions
            if answer in ("y", "yes"):
                decisions.append((i, True))
                break
            if answer in ("n", "no"):
                decisions.append((i, False))
                break
            print("      Please enter y, n, or q")

    return decisions


# ── Apply changes ────────────────────────────────────────────────────────────

def apply_to_baseline(baseline, scrape_ships, scrape_items,
                      ship_auto, ship_review, ship_review_decisions,
                      item_auto, item_review, item_review_decisions,
                      version, mining_locations=None, mining_elements=None):
    """Apply accepted changes to the baseline and return it.

    Does NOT modify scrape data. Mutates baseline in-place.
    """
    base_ships_by_cls = {s["className"]: s for s in baseline["ships"]}
    scrape_ships_by_cls = {s["className"]: s for s in scrape_ships}
    base_items_by_cls = {i["className"]: i for i in baseline["items"]}
    scrape_items_by_cls = {i["className"]: i for i in scrape_items}

    now_version = version

    # 1. Auto-apply ship stat changes
    for entry in ship_auto:
        if entry["type"] == "ship_stats_updated":
            cls = entry["className"]
            if cls in base_ships_by_cls and cls in scrape_ships_by_cls:
                scrape = scrape_ships_by_cls[cls]
                base = base_ships_by_cls[cls]
                for change in entry["changes"]:
                    base[change["field"]] = change["new"]
                base["_baseline"]["lastUpdated"] = now_version
                base["_baseline"]["lastChecked"] = now_version

        elif entry["type"] == "ship_hardpoint_values":
            cls = entry["className"]
            if cls in base_ships_by_cls:
                base = base_ships_by_cls[cls]
                base_hp_by_id = {hp["id"].lower(): hp for hp in base.get("hardpoints", [])}
                for change in entry["changes"]:
                    hp = base_hp_by_id.get(change["hardpoint"].lower())
                    if hp:
                        hp[change["field"]] = change["new"]

    # Mark ships that matched scrape but had no changes as "checked"
    for cls in scrape_ships_by_cls:
        if cls in base_ships_by_cls:
            base_ships_by_cls[cls]["_baseline"]["lastChecked"] = now_version

    # 2. Apply reviewed ship changes
    ship_decisions = {i: accepted for i, accepted in ship_review_decisions}
    for i, item in enumerate(ship_review):
        accepted = ship_decisions.get(i, False)
        if not accepted:
            continue

        t = item["type"]
        if t == "ship_added":
            new_ship = item["data"].copy()
            new_ship["_baseline"] = {
                "lastUpdated": now_version,
                "lastChecked": now_version,
            }
            baseline["ships"].append(new_ship)
            base_ships_by_cls[new_ship["className"]] = new_ship

        elif t == "ship_missing":
            # Accepted removal — remove from baseline
            baseline["ships"] = [s for s in baseline["ships"]
                                 if s["className"] != item["className"]]

        elif t == "hardpoint_removed":
            cls = item["className"]
            if cls in base_ships_by_cls:
                ship = base_ships_by_cls[cls]
                ship["hardpoints"] = [
                    hp for hp in ship.get("hardpoints", [])
                    if hp["id"].lower() != item["hardpoint"].lower()
                ]
                ship["_baseline"]["lastUpdated"] = now_version

        elif t == "hardpoint_added":
            cls = item["className"]
            if cls in base_ships_by_cls:
                ship = base_ships_by_cls[cls]
                ship["hardpoints"].append(item["data"])
                ship["_baseline"]["lastUpdated"] = now_version

        elif t == "hardpoint_changed":
            cls = item["className"]
            if cls in base_ships_by_cls:
                ship = base_ships_by_cls[cls]
                for hp in ship.get("hardpoints", []):
                    if hp["id"].lower() == item["hardpoint"].lower():
                        hp[item["field"]] = item["new"]
                        break
                ship["_baseline"]["lastUpdated"] = now_version

    # 3. Auto-apply item changes
    for entry in item_auto:
        if entry["type"] == "item_added":
            new_item = entry["data"].copy()
            new_item["_baseline"] = {
                "lastUpdated": now_version,
                "lastChecked": now_version,
            }
            baseline["items"].append(new_item)

        elif entry["type"] == "items_updated":
            # Bulk update all items that changed
            for cls in scrape_items_by_cls:
                if cls in base_items_by_cls:
                    base_item = base_items_by_cls[cls]
                    scrape_item = scrape_items_by_cls[cls]
                    skip_keys = {"_baseline", "_stale", "_staleDate", "className"}
                    for key in set(base_item.keys()) | set(scrape_item.keys()):
                        if key in skip_keys:
                            continue
                        scrape_val = scrape_item.get(key)
                        if base_item.get(key) != scrape_val:
                            if scrape_val is not None:
                                base_item[key] = scrape_val
                            elif key in base_item:
                                del base_item[key]
                    base_item["_baseline"]["lastUpdated"] = now_version
                    base_item["_baseline"]["lastChecked"] = now_version

    # Mark items that matched scrape as checked
    for cls in scrape_items_by_cls:
        if cls in base_items_by_cls:
            base_items_by_cls[cls]["_baseline"]["lastChecked"] = now_version

    # 4. Apply reviewed item changes
    item_decisions = {i: accepted for i, accepted in item_review_decisions}
    for i, item in enumerate(item_review):
        accepted = item_decisions.get(i, False)
        if not accepted:
            continue
        if item["type"] == "item_missing":
            baseline["items"] = [it for it in baseline["items"]
                                 if it["className"] != item["className"]]

    # 5. Update mining data (always auto-accept)
    if mining_locations is not None:
        baseline["miningLocations"] = mining_locations
    if mining_elements is not None:
        baseline["miningElements"] = mining_elements

    # 6. Update baseline meta
    baseline["meta"]["lastUpdated"] = now_version
    baseline["meta"]["shipCount"] = len(baseline["ships"])
    baseline["meta"]["itemCount"] = len(baseline["items"])

    return baseline


def generate_output(baseline):
    """Generate the app-facing output from the baseline.

    Strips _baseline metadata and shopPrices (now sourced from the
    standalone shop_prices table; the API's exportFullDb reattaches
    them at serve time, so embedding is redundant + diff-noisy).
    """
    STRIPPED = {"_baseline", "_stale", "_staleDate", "shopPrices"}
    def strip_baseline(entity):
        return {k: v for k, v in entity.items() if k not in STRIPPED}

    ships = [strip_baseline(s) for s in baseline["ships"]]
    items = [strip_baseline(i) for i in baseline["items"]]

    return ships, items


# ── Main entry point ─────────────────────────────────────────────────────────

def run_baseline_update(scrape_ships, scrape_items, version,
                        mining_locations=None, mining_elements=None,
                        non_interactive=False):
    """Run the full baseline diff, report, and merge flow.

    Args:
        scrape_ships: list of ship dicts from fresh extraction
        scrape_items: list of item dicts from fresh extraction
        version: game version string (e.g., "4.8.0-live.12345")
        mining_locations: list of mining location dicts (auto-accepted)
        mining_elements: list of mining element dicts (auto-accepted)
        non_interactive: if True, reject all review items (for testing)

    Returns:
        (ship_list, item_list) ready for output JSON — baseline metadata stripped
    """
    baseline = load_baseline()
    if baseline is None:
        print("\n  No baseline found — creating initial baseline from scrape.")
        baseline = {
            "meta": {
                "createdFrom": version,
                "lastUpdated": version,
                "shipCount": len(scrape_ships),
                "itemCount": len(scrape_items),
            },
            "ships": scrape_ships,
            "items": scrape_items,
            "miningLocations": mining_locations or [],
            "miningElements": mining_elements or [],
        }
        for s in baseline["ships"]:
            s["_baseline"] = {"lastUpdated": version, "lastChecked": version}
        for i in baseline["items"]:
            i["_baseline"] = {"lastUpdated": version, "lastChecked": version}
        save_baseline(baseline)
        return generate_output(baseline)

    # Diff
    ship_auto, ship_review, ship_coverage = diff_ships(
        baseline["ships"], scrape_ships)
    item_auto, item_review = diff_items(
        baseline["items"], scrape_items, baseline_ships=baseline["ships"])

    # Report
    total_review = print_report(ship_auto, ship_review, ship_coverage,
                                item_auto, item_review, version)

    # Prompt for review items
    all_review = ship_review + item_review
    if non_interactive:
        review_decisions = [(i, False) for i in range(len(all_review))]
    else:
        review_decisions = prompt_review(all_review) if all_review else []

    # Split decisions back into ship/item
    n_ship_review = len(ship_review)
    ship_decisions = [(i, a) for i, a in review_decisions if i < n_ship_review]
    item_decisions = [(i - n_ship_review, a) for i, a in review_decisions
                      if i >= n_ship_review]

    # Apply
    baseline = apply_to_baseline(
        baseline, scrape_ships, scrape_items,
        ship_auto, ship_review, ship_decisions,
        item_auto, item_review, item_decisions,
        version, mining_locations, mining_elements,
    )

    # Save
    save_baseline(baseline)

    # Summary
    accepted = sum(1 for _, a in review_decisions if a)
    rejected = sum(1 for _, a in review_decisions if not a)
    if total_review:
        print(f"\n  Applied: {accepted} accepted, {rejected} rejected")

    print(f"  Baseline saved: {len(baseline['ships'])} ships, {len(baseline['items'])} items")

    return generate_output(baseline)

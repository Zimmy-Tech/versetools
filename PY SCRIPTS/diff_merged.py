"""
diff_merged.py — changelog generator (per-version, unified)

Diffs the current `app/public/<target>/versedb_merged.json` against its
previous snapshot (`versedb_merged_prev.json`) and prepends a new entry
to the **single** unified `app/public/versedb_changelog.json`. Entries
are tagged with `channel: 'live' | 'ptu'` so one page shows both
streams interleaved.

Design notes:
- **Per-version trigger**: an entry is only written when the meta.version
  string actually changes (e.g. CIG ships a new build). Re-extractions
  inside the same patch (curation tweaks, extractor fixes) roll the
  prev snapshot forward silently. This kills the noise users complained
  about — within-patch churn no longer surfaces.
- The changelog file is hand-editable static JSON. This script only
  prepends new entries; existing entries are preserved byte-identical
  across runs. Safe to edit wording, merge duplicates, reorder, or
  delete noise between runs.
- Dedup key is (channel, fromVersion, toVersion, contentHash). Same
  trio + identical content delta → skip.
- Field diffs include `pct` (percent change for numeric fields) when
  meaningful — suppressed when the baseline is a sentinel (0/1/10) or
  the magnitude is absurd (>500%, usually a unit swap).
- Each change entry carries both `name` (display) and `className`
  (internal id) so users can search either one.
- FPS + missions stay coarse (className-only "changed" markers); the
  dedicated DB pages show current values.

Usage:
    python3 diff_merged.py --target live    # default
    python3 diff_merged.py --target ptu
    python3 diff_merged.py --dry-run        # print entry, don't write
    python3 diff_merged.py --force          # emit even if version unchanged
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PUB = REPO_ROOT / "app" / "public"

# Tracked fields per entity type. Whitelisted to keep the user-facing
# changelog tight; the DB pages always show full current values.
TRACKED_FIELDS: dict[str, list[str]] = {
    "ship": [
        "mass", "scmSpeed", "navSpeed", "boostSpeedFwd",
        "pitch", "roll", "yaw", "totalHp", "bodyHp", "armorHp",
        "cargoCapacity", "oreCapacity", "weaponPowerPoolSize",
        "thrusterPowerBars", "hydrogenFuelCapacity", "quantumFuelCapacity",
        "crew", "armorDeflectPhys", "armorDeflectEnrg",
        "durabilityPhys", "durabilityEnrg", "durabilityDist",
        "hullDmgPhys", "hullDmgEnrg", "hullDmgDist",
        "qdSpoolDelay", "flightSpoolDelay",
    ],
    "WeaponGun": [
        "dps", "alphaDamage", "fireRate", "projectileSpeed", "maxRange",
        "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
        "maxRegenPerSec", "powerDraw",
    ],
    "WeaponTachyon": [
        "dps", "alphaDamage", "fireRate", "projectileSpeed", "maxRange",
        "maxHeat", "heatPerShot", "overheatCooldown", "ammoCount",
        "maxRegenPerSec", "powerDraw",
    ],
    "WeaponMining": [
        "dps", "alphaDamage", "fireRate", "miningMinPower",
        "miningMaxPower", "miningInstability", "miningOptimalRange",
        "miningMaxRange", "powerDraw",
    ],
    "TractorBeam": [
        "dps", "alphaDamage", "fireRate", "powerDraw",
        "maxRange", "optimalRange",
    ],
    "Shield": [
        "hp", "regenRate", "damagedRegenDelay", "downedRegenDelay",
        "absPhysMax", "absPhysMin", "absEnrgMax", "absEnrgMin",
        "absDistMax", "absDistMin", "powerDraw", "emMax",
    ],
    "PowerPlant": [
        "powerOutput", "componentHp", "emMax", "distortionMax",
        "selfRepairRatio", "selfRepairTime",
    ],
    "Cooler": [
        "coolingRate", "componentHp", "emMax", "powerDraw",
    ],
    "QuantumDrive": [
        "speed", "fuelRate", "calDelay", "cooldownTime",
        "interdictionTime", "powerDraw", "emMax", "hp",
    ],
    "Radar": [
        "aimMin", "aimMax", "aimBuffer", "componentHp", "emMax",
        "csSensitivity", "emSensitivity", "irSensitivity",
        "rsSensitivity", "powerDraw",
    ],
    "MissileLauncher": ["missileSize", "capacity"],
    "BombLauncher": ["missileSize", "capacity"],
    "Missile": [
        "alphaDamage", "projectileSpeed", "lockTime",
        "lockRangeMax", "lockAngle", "explosionMaxRadius",
    ],
    "Bomb": [
        "alphaDamage", "projectileSpeed", "armTime", "igniteTime",
        "explosionMaxRadius", "explosionMinRadius",
    ],
    "EMP": [
        "chargeTime", "cooldownTime", "distortionDamage", "empRadius",
    ],
    "JumpDrive": [
        "alignmentRate", "distortionMax", "fuelEfficiency", "hp",
        "tuningRate",
    ],
    "LifeSupportGenerator": [
        "powerDraw", "powerMax", "distortionMax", "emMax",
    ],
    "MiningModifier": [
        "miningPowerMult", "miningInstability", "miningOvercharge",
        "charges",
    ],
    "FlightController": [
        "scmSpeed", "navSpeed", "boostSpeedFwd", "boostSpeedBwd",
        "pitch", "roll", "yaw", "pitchBoosted", "rollBoosted",
        "yawBoosted", "qdSpoolDelay", "thrusterPowerBars",
    ],
    "Module": ["cargoBonus"],
    "QuantumInterdictionGenerator": [
        "powerDraw", "powerMax", "basePowerDrawFraction",
    ],
    # FPS armor — surfaces real CIG balance changes (DR nerfs, temp/rad
    # tweaks) which were previously buried in coarse "this entity
    # changed" entries. gForceResistance is included now that it's
    # established; the mass-null-flip suppressor (see _suppress_…
    # below) handles the one-time wave when a field is first added.
    "fps_armor": [
        "damageReduction", "weight",
        "tempMin", "tempMax", "radiationProtection",
        "carryingCapacity", "gForceResistance",
    ],
}

# Maps item `type` → display category. Keys also drive the section
# headers in the UI (sorted via CATEGORY_ORDER in the component).
ITEM_TYPE_TO_CATEGORY: dict[str, str] = {
    "WeaponGun": "weapon",
    "WeaponTachyon": "weapon",
    "WeaponMining": "mining_laser",
    "TractorBeam": "tractor",
    "Shield": "shield",
    "PowerPlant": "powerplant",
    "Cooler": "cooler",
    "QuantumDrive": "quantumdrive",
    "Radar": "radar",
    "Missile": "missile",
    "MissileLauncher": "missilelauncher",
    "BombLauncher": "missilelauncher",
    "Bomb": "missile",
    "EMP": "emp",
    "JumpDrive": "jumpdrive",
    "LifeSupportGenerator": "life_support",
    "MiningModifier": "mining_modifier",
    "FlightController": "flight_controller",
    "Module": "module",
    "QuantumInterdictionGenerator": "qig",
    "SalvageHead": "salvage",
    "SalvageModifier": "salvage_modifier",
    "Turret": "turret",
    "TurretBase": "turret",
    "WeaponMount": "weapon_mount",
    "ToolArm": "tool",
}


def _item_category(item: dict) -> str:
    t = item.get("type", "")
    return ITEM_TYPE_TO_CATEGORY.get(t, t.lower() or "item")


def _fps_category(fps_item: dict) -> str:
    kind = fps_item.get("_kind", "")
    return f"fps_{kind}" if kind else "fps_item"


def _calc_pct(old, new) -> float | None:
    """Return the % change from old → new, or None if not meaningful.

    Suppressed when the baseline is too small to make a percent
    meaningful (likely a sentinel / placeholder seed value), and when
    the magnitude is absurd (>500%, usually a unit/format change).
    """
    if not isinstance(old, (int, float)) or not isinstance(new, (int, float)):
        return None
    if old == 0 or abs(old) < 2:
        # 0 → N is undefined; 1 → 100 reads as +9900% which is noise.
        return None
    pct = (new - old) / old * 100.0
    if abs(pct) > 500:
        return None
    return round(pct, 1)


def _deep_diff(old: dict, new: dict, fields: list[str]) -> list[dict]:
    out = []
    for f in fields:
        ov, nv = old.get(f), new.get(f)
        if ov is None and nv is None:
            continue
        if ov != nv:
            entry = {"field": f, "old": ov, "new": nv}
            pct = _calc_pct(ov, nv)
            if pct is not None:
                entry["pct"] = pct
            out.append(entry)
    return out


def _diff_ship_item_stream(
    prev_list: list[dict],
    new_list: list[dict],
    *,
    is_ship: bool,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Field-level diff for ships/items. Tracked-field whitelist keeps
    noise out. Returns (changes, added, removed)."""
    prev_map = {e["className"]: e for e in prev_list if e.get("className")}
    new_map = {e["className"]: e for e in new_list if e.get("className")}
    changes, added, removed = [], [], []
    for key in sorted(set(prev_map) | set(new_map)):
        p, n = prev_map.get(key), new_map.get(key)
        if not p and n:
            cat = "ship" if is_ship else _item_category(n)
            added.append({"category": cat, "className": key, "name": n.get("name", key)})
            continue
        if p and not n:
            cat = "ship" if is_ship else _item_category(p)
            removed.append({"category": cat, "className": key, "name": p.get("name", key)})
            continue
        etype = "ship" if is_ship else n.get("type", "")
        fields = TRACKED_FIELDS.get(etype, [])
        if not fields:
            continue
        field_diffs = _deep_diff(p, n, fields)
        if field_diffs:
            cat = "ship" if is_ship else _item_category(n)
            changes.append({
                "category": cat,
                "className": key,
                "name": n.get("name", key),
                "fields": field_diffs,
            })
    return changes, added, removed


def _diff_typed_fps_stream(
    prev_list: list[dict],
    new_list: list[dict],
    *,
    fields: list[str],
    category: str,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Field-level diff for an FPS stream against a whitelist. Same
    output shape as `_diff_ship_item_stream` so the existing changelog
    UI can render the `fields` array unchanged."""
    prev_map = {e["className"]: e for e in prev_list if e.get("className")}
    new_map = {e["className"]: e for e in new_list if e.get("className")}
    changes, added, removed = [], [], []
    for key in sorted(set(prev_map) | set(new_map)):
        p, n = prev_map.get(key), new_map.get(key)
        if not p and n:
            added.append({"category": category, "className": key, "name": n.get("name", key)})
            continue
        if p and not n:
            removed.append({"category": category, "className": key, "name": p.get("name", key)})
            continue
        field_diffs = _deep_diff(p, n, fields)
        if field_diffs:
            changes.append({
                "category": category,
                "className": key,
                "name": n.get("name", key),
                "fields": field_diffs,
            })
    return changes, added, removed


def _suppress_mass_null_flips(
    changes: list[dict],
    *,
    threshold_pct: int = 50,
    min_entities: int = 20,
) -> tuple[list[dict], list[dict]]:
    """Detect and suppress mass `null → value` waves caused by extractor
    capability additions (e.g. a new field newly populated across most
    entries). Returns (filtered_changes, metadata_entries).

    A field qualifies if: (a) >= `threshold_pct`% of changed entries
    flipped that field null→non-null, and (b) the absolute count is
    >= `min_entities` (so we don't suppress legit small-batch changes).

    Only the noisy field is stripped from each entry — entries with
    other real changes survive with their remaining `fields` intact.
    Entries whose `fields` empties out after stripping are dropped, and
    a single `metadata` entry per suppressed field is appended."""
    if not changes:
        return changes, []
    null_flip_count: dict[tuple[str, str], int] = {}
    total_changed_per_field: dict[tuple[str, str], int] = {}
    for entry in changes:
        cat = entry.get("category", "")
        for fd in entry.get("fields", []):
            key = (cat, fd["field"])
            total_changed_per_field[key] = total_changed_per_field.get(key, 0) + 1
            if fd.get("old") is None and fd.get("new") is not None:
                null_flip_count[key] = null_flip_count.get(key, 0) + 1
    suppressed: set[tuple[str, str]] = set()
    metadata: list[dict] = []
    for key, flips in null_flip_count.items():
        total = total_changed_per_field.get(key, 0)
        if total >= min_entities and flips * 100 >= total * threshold_pct:
            suppressed.add(key)
            cat, field = key
            metadata.append({
                "category": "metadata",
                "className": f"{cat}.{field}",
                "name": f"{field} — newly tracked on {cat} ({flips} entries)",
            })
    if not suppressed:
        return changes, []
    filtered: list[dict] = []
    for entry in changes:
        cat = entry.get("category", "")
        kept = [
            fd for fd in entry.get("fields", [])
            if (cat, fd["field"]) not in suppressed
            or not (fd.get("old") is None and fd.get("new") is not None)
        ]
        if kept:
            new_entry = dict(entry)
            new_entry["fields"] = kept
            filtered.append(new_entry)
    return filtered, metadata


def _diff_shallow_stream(
    prev_list: list[dict],
    new_list: list[dict],
    *,
    category_fn,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Coarse className diff for FPS + missions — entity-level only."""
    prev_map = {e["className"]: e for e in prev_list if e.get("className")}
    new_map = {e["className"]: e for e in new_list if e.get("className")}
    changes, added, removed = [], [], []
    for key in sorted(set(prev_map) | set(new_map)):
        p, n = prev_map.get(key), new_map.get(key)
        if not p and n:
            added.append({"category": category_fn(n), "className": key, "name": n.get("name", n.get("title", key))})
            continue
        if p and not n:
            removed.append({"category": category_fn(p), "className": key, "name": p.get("name", p.get("title", key))})
            continue
        if json.dumps(p, sort_keys=True) != json.dumps(n, sort_keys=True):
            changes.append({"category": category_fn(n), "className": key, "name": n.get("name", n.get("title", key))})
    return changes, added, removed


def _content_hash(entry: dict) -> str:
    key_fields = {k: entry[k] for k in ("changes", "added", "removed") if k in entry}
    return hashlib.sha256(json.dumps(key_fields, sort_keys=True).encode()).hexdigest()[:12]


def build_entry(prev_merged: dict, new_merged: dict, channel: str) -> dict:
    """Compute the complete changelog entry from two merged snapshots."""
    changes, added, removed = [], [], []

    c, a, r = _diff_ship_item_stream(
        prev_merged.get("ships", []), new_merged.get("ships", []), is_ship=True,
    )
    changes += c; added += a; removed += r

    c, a, r = _diff_ship_item_stream(
        prev_merged.get("items", []), new_merged.get("items", []), is_ship=False,
    )
    changes += c; added += a; removed += r

    c, a, r = _diff_shallow_stream(
        prev_merged.get("fpsItems", []), new_merged.get("fpsItems", []),
        category_fn=_fps_category,
    )
    changes += c; added += a; removed += r

    c, a, r = _diff_shallow_stream(
        prev_merged.get("fpsGear", []), new_merged.get("fpsGear", []),
        category_fn=lambda _: "fps_gear",
    )
    changes += c; added += a; removed += r

    c, a, r = _diff_typed_fps_stream(
        prev_merged.get("fpsArmor", []), new_merged.get("fpsArmor", []),
        fields=TRACKED_FIELDS["fps_armor"],
        category="fps_armor",
    )
    changes += c; added += a; removed += r

    c, a, r = _diff_shallow_stream(
        prev_merged.get("missions", []), new_merged.get("missions", []),
        category_fn=lambda _: "mission",
    )
    changes += c; added += a; removed += r

    prev_refs = prev_merged.get("missionRefs") or {}
    new_refs = new_merged.get("missionRefs") or {}
    if json.dumps(prev_refs, sort_keys=True) != json.dumps(new_refs, sort_keys=True):
        changes.append({
            "category": "mission_refs",
            "className": "missionRefs",
            "name": "Mission reference data",
        })

    # Mass null→value suppressor: when an extractor capability is added
    # (e.g. a new field newly populated across most entries), strip
    # those noisy field-level transitions and emit one summary
    # `metadata` entry per affected stream/field instead.
    changes, metadata_entries = _suppress_mass_null_flips(changes)
    changes += metadata_entries

    prev_version = (prev_merged.get("meta") or {}).get("version", "unknown")
    new_version = (new_merged.get("meta") or {}).get("version", "unknown")

    return {
        "channel": channel,
        "fromVersion": prev_version,
        "toVersion": new_version,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "changes": changes,
        "added": added,
        "removed": removed,
    }


def main():
    parser = argparse.ArgumentParser(description="Diff merged.json against its previous snapshot and update versedb_changelog.json")
    parser.add_argument("--target", choices=["live", "ptu"], default="live")
    parser.add_argument("--dry-run", action="store_true", help="Print the entry without writing it")
    parser.add_argument("--force", action="store_true", help="Emit an entry even if meta.version matches the prev snapshot (use to backfill demo entries or stitch together a release notes pass)")
    args = parser.parse_args()

    pub = APP_PUB / args.target
    merged_path = pub / "versedb_merged.json"
    prev_path = pub / "versedb_merged_prev.json"
    # SINGLE shared changelog file lives at the public root, not per-mode.
    changelog_path = APP_PUB / "versedb_changelog.json"

    if not merged_path.exists():
        print(f"[diff_merged] {merged_path} not found — run merge_build_payload.py first", file=sys.stderr)
        sys.exit(1)

    if not prev_path.exists():
        # First run on a fresh checkout: snapshot and exit quietly.
        shutil.copy2(merged_path, prev_path)
        print(f"[diff_merged] baseline snapshot saved -> {prev_path.name} (no changelog entry on first run)")
        return

    with open(prev_path, encoding="utf-8") as f:
        prev_merged = json.load(f)
    with open(merged_path, encoding="utf-8") as f:
        new_merged = json.load(f)

    prev_version = (prev_merged.get("meta") or {}).get("version", "unknown")
    new_version = (new_merged.get("meta") or {}).get("version", "unknown")

    # Per-version gate: same version string = same CIG patch+build.
    # Skip silently and DO NOT roll prev forward — we want the next
    # real version bump to diff against the freshest extract of the
    # current patch (so within-patch extractor improvements don't
    # leak into the next entry).
    if prev_version == new_version and not args.force:
        # But still roll prev forward — within-patch extractor
        # improvements should NOT pollute the next real diff. By
        # taking the latest extract as the baseline for the next
        # version bump, only CIG-side changes show up there.
        shutil.copy2(merged_path, prev_path)
        print(f"[diff_merged] version unchanged ({new_version}) — rolled prev forward, no entry written")
        return

    entry = build_entry(prev_merged, new_merged, channel=args.target)

    if not entry["changes"] and not entry["added"] and not entry["removed"]:
        print(f"[diff_merged] no deltas between {entry['fromVersion']} and {entry['toVersion']} — no entry written")
        if not args.dry_run:
            shutil.copy2(merged_path, prev_path)
        return

    print(f"[diff_merged] [{args.target}] {entry['fromVersion']} -> {entry['toVersion']}")
    print(f"  changes: {len(entry['changes'])}, added: {len(entry['added'])}, removed: {len(entry['removed'])}")

    if args.dry_run:
        print(json.dumps(entry, indent=2)[:2000])
        return

    changelog = {"meta": {"generatedAt": "", "entries": 0}, "changelog": []}
    if changelog_path.exists():
        try:
            with open(changelog_path, encoding="utf-8") as f:
                changelog = json.load(f)
        except Exception as e:
            print(f"[diff_merged] warning: couldn't parse existing changelog ({e}); starting fresh")

    new_hash = _content_hash(entry)
    for existing in changelog["changelog"]:
        if (existing.get("channel") == entry["channel"]
                and existing.get("fromVersion") == entry["fromVersion"]
                and existing.get("toVersion") == entry["toVersion"]
                and _content_hash(existing) == new_hash):
            print(f"[diff_merged] identical entry already present — skipping")
            shutil.copy2(merged_path, prev_path)
            return

    changelog["changelog"].insert(0, entry)
    changelog["meta"]["generatedAt"] = datetime.now(timezone.utc).isoformat()
    changelog["meta"]["entries"] = len(changelog["changelog"])

    with open(changelog_path, "w", encoding="utf-8") as f:
        json.dump(changelog, f, indent=2, ensure_ascii=False)
    print(f"[diff_merged] wrote entry to {changelog_path.name}")

    shutil.copy2(merged_path, prev_path)


if __name__ == "__main__":
    main()

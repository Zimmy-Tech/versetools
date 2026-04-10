---
name: variant-exclusions
description: Reference for ship variant hardpoint filtering — HP_EXCLUSIONS dict, shared vehicle XMLs, which variants need filtering. Use when a ship shows hardpoints it shouldn't have, or when adding new variant-specific exclusions.
allowed-tools: Read, Grep, Glob, Bash
---

# Ship Variant Hardpoint Exclusions

Many Star Citizen ships share a single vehicle XML across variants. The extraction pipeline reads all hardpoints from the shared XML, then uses `HP_EXCLUSIONS` to remove hardpoints that don't belong on specific variants.

## How It Works

### The Problem

Variants like the Hercules C2/M2/A2 share `CRUS_Starlifter.xml`. The A2 (gunship) has turrets and bomb racks that don't exist on the C2 (cargo) or M2 (military transport). Without filtering, all three variants show all hardpoints.

### The Solution

In `PY SCRIPTS/versedb_extract.py`, search for `HP_EXCLUSIONS`:

```python
HP_EXCLUSIONS = {
    "crus_starlifter_c2": {
        "hardpoint_bridge_remote_turret",
        "hardpoint_forward_left_remote_turret",
        "hardpoint_forward_right_remote_turret",
        # ... etc
    },
    # ... more ships
}
```

The exclusion runs during extraction (before baseline), so excluded hardpoints never reach the baseline diff.

### Application Code

```python
for ship_cls, excluded_ids in HP_EXCLUSIONS.items():
    if ship_cls in ships:
        ships[ship_cls]["hardpoints"] = [
            hp for hp in ships[ship_cls].get("hardpoints", [])
            if hp["id"].lower() not in {x.lower() for x in excluded_ids}
        ]
```

**Note**: Matching is case-insensitive on hardpoint IDs but the ship className key must match exactly (usually lowercase).

## Ships That Need Exclusions

### Currently Filtered

| Base Ship | Variants | What's Excluded |
|-----------|----------|----------------|
| CRUS Starlifter | C2, M2 (not A2) | A2-only turrets (bridge, 4 remote, nose on C2), bomb racks, 3rd shield |
| ORIG 300 series | 300i, 325a, 350r (not 315p) | Tractor beam turret |
| Esperia Talon | Talon / Shrike | Talon: blankingplate racks; Shrike: missile racks |
| CNOU Mustang | Alpha, Beta, Gamma, Omega (not Delta) | Rocket wing hardpoints |
| Aegis Sabre | Peregrine, Firebird | Variant-specific weapon/missile slots |
| RSI Zeus | ES, CL, MR | Variant-specific turrets, EMP, quantum dampener |
| Aegis Retaliator | Base, Bomber | Torpedo storage variants |
| Aegis Idris | M, P | Camera turrets, tail turrets |

### Hercules Correct Loadouts

| Variant | Pilot Weapons | Crew Weapons | Shields |
|---------|--------------|--------------|---------|
| **A2** (gunship) | 2x S5 + nose turret | 4 remote turrets + bridge + rear turret | 3 (L, R, C) |
| **M2** (military) | 2x S5 + nose turret | rear turret | 2 (L, R) |
| **C2** (cargo) | 2x S5 | rear turret | 2 (L, R) |

## Adding New Exclusions

1. Identify the shared vehicle XML and which hardpoints are variant-specific
2. Add entries to `HP_EXCLUSIONS` in `versedb_extract.py`
3. Add integrity checks to `INTEGRITY_CHECKS` (same file) to prevent regression
4. Re-run the extractor and **accept** the removals in baseline review
5. The baseline must be updated — answering "n" will put the hardpoints back

## Integrity Checks

Every exclusion should have a corresponding integrity check. Search for `INTEGRITY_CHECKS` in the extractor. If a check fails, the extractor refuses to write output.

Example:
```python
("C2 has exactly 2 shields",
 lambda: _ship_hp_count("crus_starlifter_c2", "shield_generator") == 2),
```

## Known Fragile Data

### Aurora Mk II DM Module Shield

The Aurora Mk II's combat module (DM) has a shield sub-port that only appears when the module is equipped. This is NOT a ship-level hardpoint — it's a sub-port on the module item (`rsi_aurora_mk2_module_missile`).

- `Shield` must be in `WEAPON_SUBPORT_TYPES` (search in extractor) for the sub-port to be extracted
- The ship itself should have exactly 2 shields (left + right)
- The 3rd shield lives on the DM module's `subPorts` array
- An integrity check enforces both conditions

Previous attempts to fix this by injecting a ship-level hardpoint into the baseline were fragile and got lost on every re-extraction.

# Weapon Fire Rate: 30 Hz Server Tick Quantization

## Why Aren't Gatlings Affected?

There are two completely different firing systems in the game's DCB:

**Sequence weapons (repeaters & cannons)** use `SWeaponActionSequenceParams` — each shot is a discrete event (`SWeaponActionFireSingleParams`). The server processes "fire barrel 1", then on the next tick checks "time for barrel 2?", and so on. Each shot is an individual action that has to land on a server tick.

**Gatlings** use `SWeaponActionFireRapidParams` — a single continuous action. The weapon enters a "firing state" with a spin-up, then spawns projectiles at the specified rate using an accumulator. Instead of checking "is it time for the next shot?" each tick, it calculates "how many shots should have fired since the last tick" and spawns them. A continuous timer tracks fractional shots between ticks.

Think of it like:
- **Repeater**: "Tick... can I fire? Yes. *bang*. Tick... can I fire? Not yet. Tick... can I fire? Yes. *bang*." — each shot waits for a tick.
- **Gatling**: "I'm spinning and firing. Between this tick and last tick, 1.6 shots worth of time passed, so spawn 1 projectile and carry the 0.6 remainder forward." — no per-shot tick alignment needed.

**Cannons** use the same sequence system as repeaters, but they fire slowly enough (100-150 RPM = 400-600ms between shots) that the 33ms tick boundary never rounds them up. A cannon would need to fire above 900 RPM to be affected, and none do.

## The Formula

```
ticks = ceil(1800 / listed_RPM)
real_RPM = 1800 / ticks
```

Only applies to weapons using `SWeaponActionSequenceParams` with 2+ sequence entries (repeaters). Gatlings (`SWeaponActionFireRapidParams`) and single-entry cannons are unaffected.

## The Dead Zone

Any sequence weapon with a listed RPM of 601-899 gets rounded to 3 ticks = 600 RPM. An 825 RPM weapon fires at the same real rate as a 750 RPM weapon — but with lower per-shot damage because CIG balanced it for 825.

| Listed RPM | Ticks | Real RPM | Loss | Notes |
|-----------|-------|----------|------|-------|
| 300 | 6 | 300 | 0% | Sweet spot |
| 350 | 6 | 300 | 14% | |
| 360 | 5 | 360 | 0% | Sweet spot |
| 450 | 4 | 450 | 0% | Sweet spot |
| 500 | 4 | 450 | 10% | |
| 600 | 3 | 600 | 0% | Sweet spot |
| 750 | 3 | 600 | 20% | |
| 825 | 3 | 600 | 27% | |
| 899 | 3 | 600 | 33% | Worst case |
| 900 | 2 | 900 | 0% | Sweet spot |

The sweet spots are exactly on tick boundaries: 1800, 900, 600, 450, 360, 300. Weapons at those exact RPMs lose nothing. The worst offenders are weapons just below the next boundary.

The Sawbuck (825 RPM) is particularly bad — it's designed to fire 37% faster than the Panther (750 RPM) but in practice they fire at the same 600 RPM. You pay the DPS tax of lower alpha damage for speed you never actually get.

## Validation Data

Tested by timing ammo consumption across 9 weapons:

| Weapon | Type | Entries | Listed RPM | Ticks | Predicted | Measured | Error |
|--------|------|---------|-----------|-------|-----------|----------|-------|
| Suckerpunch S1 | Cannon (1 entry) | 1 | 100 | n/a | 100 | 103 | 3% |
| Mantis GT-220 | Gatling (Rapid) | n/a | 1600 | n/a | 1600 | 1599 | 0.1% |
| Buzzsaw S1 | Seq Repeater | 2 | 900 | 2 | 900 | 906 | 0.7% |
| Sawbuck S2 | Seq Repeater | 2 | 825 | 3 | 600 | 608 | 1.3% |
| Panther S3 | Seq Repeater | 3 | 750 | 3 | 600 | 595 | 0.8% |
| Badger S2 | Seq Repeater | 3 | 750 | 3 | 600 | 590 | 1.7% |
| Yeng'tu S3 | Seq Repeater | 2 | 750 | 3 | 600 | 591 | 1.5% |
| NDB-28 S2 | Seq Repeater | 2 | 500 | 4 | 450 | 446 | 0.9% |
| Attrition-4 S4 | Seq Repeater | 2 | 350 | 6 | 300 | 299 | 0.3% |

All measured values within 1.7% of prediction (human stopwatch error).

### Key Findings

1. **Buzzsaw (900 RPM)** sits exactly on a tick boundary and fires at full rate. This is the strongest evidence for tick quantization.
2. **Sawbuck (825) and Panther (750)** both fire at ~600 RPM despite different listed rates — they both need 3 ticks per shot.
3. **Entry count (barrel count) doesn't matter** — Yeng'tu (2 entries) and Panther (3 entries) at 750 RPM fire at the same real rate.
4. This is server-side (30 Hz is a standard server tick rate, not client FPS). Client frame rate does not affect weapon fire rate.

### DCB Locations

Fire mode can be found in each weapon's XML:

```
weapon XML -> Components -> SCItemWeaponComponentParams -> fireActions
  -> SWeaponActionFireRapidParams    = gatling (has fireRate= directly)
  -> SWeaponActionSequenceParams     = repeater/cannon (has sequenceEntries with delay=)
```

### Status

Under community validation. Multiple users are being asked to independently time their weapons to confirm the 30 Hz tick theory before the correction is deployed site-wide.

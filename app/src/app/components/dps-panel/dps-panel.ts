import { Component, computed, signal } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Hardpoint, Item, calcWeaponAmmo, calcMaxPips, bandModAt, coolerSupply, componentCoolingDemand } from '../../models/db.models';

@Component({
  selector: 'app-dps-panel',
  standalone: true,
  imports: [],
  templateUrl: './dps-panel.html',
  styleUrl: './dps-panel.scss',
})
export class DpsPanelComponent {
  /** Gimbal mode — shared via DataService so Jane's cards also react. */
  get gimbalMode() { return this.data.gimbalMode; }

  /** Get effective fire rate for a weapon, accounting for gimbal mode penalty. */
  private effectiveFireRate(w: Item): number {
    const base = w.fireRate ?? 0;
    return this.gimbalMode() === 'gimbal' ? base * this.data.GIMBAL_FIRE_RATE_MULT : base;
  }

  /** Get effective DPS for a weapon, accounting for gimbal mode penalty. */
  private effectiveDPS(w: Item): number {
    const base = w.dps ?? 0;
    return this.gimbalMode() === 'gimbal' ? base * this.data.GIMBAL_FIRE_RATE_MULT : base;
  }

  private loadoutEntries = computed(() => Object.entries(this.data.loadout()));
  private equippedItems  = computed(() => this.loadoutEntries().map(([, item]) => item));
  private shipHardpoints  = computed(() => this.data.selectedShip()?.hardpoints ?? []);

  private parentHardpoint(key: string): Hardpoint | undefined {
    const topKey = key.split('.')[0];
    return this.shipHardpoints().find(
      hp => hp.id.toLowerCase() === topKey.toLowerCase()
    );
  }

  // Ship-specific hardpoints that are pilot-controlled despite having turret/remote tags
  private readonly FORCE_PILOT_HARDPOINTS: Record<string, Set<string>> = {
    'aegs_redeemer': new Set(['hardpoint_turret_remote_front']),
  };

  // TurretBase is always crew-operated (has its own manned seat).
  //
  // Turret hardpoints use controllerTag to determine pilot vs crew:
  //   pilotSeat              → pilot  (e.g. Redeemer wing guns)
  //   remote_*_turret        → pilot  (remote turret, pilot-operated from cockpit)
  //   (empty)                → pilot  (default, no explicit controller)
  //   manned_*_turret / any other seat tag → crew
  //
  // Verified on Redeemer:
  //   hardpoint_weapon_gun_right/left  → Turret, controllerTag=pilotSeat     → pilot ✓
  //   hardpoint_turret_remote_rear     → Turret, controllerTag=remote_rear_turret → pilot ✓
  //   hardpoint_turret_manned_rear/front → TurretBase, controllerTag=manned_*  → crew ✓
  private isTurretHardpoint(hp: Hardpoint | undefined): boolean {
    if (!hp) return false;
    const shipCls = this.data.selectedShip()?.className?.toLowerCase() ?? '';
    if (this.FORCE_PILOT_HARDPOINTS[shipCls]?.has(hp.id.toLowerCase())) return false;
    if (hp.type === 'TurretBase') return true;
    if (hp.type === 'Turret') {
      const ct = hp.controllerTag?.toLowerCase() ?? '';
      // gunNacelle = pilot-controlled weapon nacelle (e.g., Constellation nose guns)
      // Note: 'copilotSeat' is crew, 'pilotSeat' is pilot — match exact token, not substring
      return !!ct && !ct.includes('remote_turret') && !ct.startsWith('pilotseat') && !ct.includes('gunnacelle') && !ct.includes('gunnose');
    }
    return false;
  }

  private isGunItem(item: Item): boolean {
    return item.type === 'WeaponGun' || item.type === 'WeaponTachyon';
  }

  private isPdc(key: string): boolean {
    return key.toLowerCase().includes('_pdc');
  }

  directWeapons = computed(() =>
    this.loadoutEntries()
      .filter(([key, item]) =>
        this.isGunItem(item) && !this.isPdc(key) &&
        !this.isTurretHardpoint(this.parentHardpoint(key))
      )
      .map(([, item]) => item)
  );

  turretWeapons = computed(() =>
    this.loadoutEntries()
      .filter(([key, item]) =>
        this.isGunItem(item) && !this.isPdc(key) &&
        this.isTurretHardpoint(this.parentHardpoint(key))
      )
      .map(([, item]) => item)
  );

  missiles = computed(() => this.equippedItems().filter(i => i.type === 'Missile'));
  bombs = computed(() => this.equippedItems().filter(i => i.type === 'Bomb'));

  // Weapons can fire at all only when power > 0 (or there is no power pool).
  private weaponsLive = computed(() => {
    const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 0;
    return poolSize === 0 || this.data.weaponsPower() > 0;
  });

  // Sustained DPS ratio for one weapon at the current weapon power allocation.
  //
  // Energy weapons use the SC ammo-regen model (maxAmmoLoad=75 shots, maxRegenPerSec=15
  // shots/s, maxRestockCount=3 — all universal constants across energy weapons):
  //   sustained_ratio(N) = (300 × N) / (300 × N + fireRateRPM)
  //   where N = weaponBars allocated, 300 = maxAmmoLoad/maxRestockCount × maxRegenPerSec
  //           = (75/3) × 15 / (1/60) = 300 per bar in RPM units
  //
  // Ballistic weapons have enough physical ammo to fire for 160+ seconds,
  // so sustained ≈ burst for any 10-second window.
  // maxRestockCount is 3 for all ship energy weapons (universal SC constant).
  private readonly ENERGY_MAX_RESTOCK = 3;

  private weaponSustainedRatio(weapon: Item, weaponBars: number): number {
    if (weapon.isBallistic || !weapon.fireRate) return 1;
    // Cap effective bars at maxRestockCount — no further gain beyond it.
    const N = Math.min(weaponBars, this.ENERGY_MAX_RESTOCK);
    const f = this.effectiveFireRate(weapon); // RPM with gimbal penalty
    // 300 = (maxAmmoLoad/maxRestockCount) × maxRegenPerSec × 60 = (75/3) × 15
    return (300 * N) / (300 * N + f);
  }

  /**
   * Calculate burst stats for a set of weapons.
   * Energy: burst rounds = ammo count (pip-dependent from shared pool)
   * Ballistic: burst rounds = floor(maxHeat / heatPerShot) (one overheat cycle)
   * Burst damage = sum of (rounds × alphaDamage) across all weapons
   * Burst time = max individual weapon time (weapons fire in parallel)
   */
  private calcBurst(weapons: Item[]): { damage: number; time: number } {
    const allWeapons = this.data.allLoadoutWeapons();
    const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
    const pips = this.data.weaponsPower();
    const mult = this.data.selectedShip()?.ammoLoadMultiplier ?? 1;

    let totalDamage = 0;
    let maxTime = 0;

    for (const w of weapons) {
      const alpha = w.alphaDamage ?? 0;
      const rpm = this.effectiveFireRate(w);
      if (alpha <= 0 || rpm <= 0) continue;
      const rps = rpm / 60;

      let rounds: number;
      if (w.isBallistic) {
        if (!w.heatPerShot || !w.maxHeat || w.heatPerShot <= 0) continue;
        rounds = Math.floor(w.maxHeat / w.heatPerShot);
      } else {
        const ammo = calcWeaponAmmo(w, pips, poolSize, allWeapons, mult);
        if (ammo == null || ammo <= 0) continue;
        rounds = ammo;
      }

      totalDamage += rounds * alpha;
      maxTime = Math.max(maxTime, rounds / rps);
    }

    return { damage: totalDamage, time: maxTime };
  }

  /**
   * Calculate damage in a 10-second window per weapon, accounting for cycles.
   *
   * Energy: fire at full rate until ammo exhausted (ammo drains at rps - regenRPS),
   *   then wait regenCooldown, then fire at regen rate for remainder.
   *   maxRegenPerSec is per-weapon (constant, not pip-dependent).
   *
   * Ballistic: fire until overheat, cooldown, fire again if time remains.
   */
  private readonly DPS_WINDOW = 10; // seconds

  private calcDamageIn10s(weapons: Item[]): number {
    const allWeapons = this.data.allLoadoutWeapons();
    const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
    const pips = this.data.weaponsPower();
    const mult = this.data.selectedShip()?.ammoLoadMultiplier ?? 1;
    const W = this.DPS_WINDOW;
    let total = 0;

    for (const w of weapons) {
      const alpha = w.alphaDamage ?? 0;
      const rpm = this.effectiveFireRate(w);
      if (alpha <= 0 || rpm <= 0) continue;
      const rps = rpm / 60;

      if (w.isBallistic) {
        if (!w.heatPerShot || !w.maxHeat || w.heatPerShot <= 0) continue;
        const rounds = Math.floor(w.maxHeat / w.heatPerShot);
        const burstTime = rounds / rps;
        const cooldown = w.overheatCooldown ?? 0;
        const cycleTime = burstTime + cooldown;
        const burstDmg = rounds * alpha;

        if (burstTime >= W) {
          total += W * rps * alpha;
        } else if (cycleTime <= 0) {
          total += burstDmg;
        } else {
          const fullCycles = Math.floor(W / cycleTime);
          const remaining = W - fullCycles * cycleTime;
          total += fullCycles * burstDmg + Math.min(remaining, burstTime) * rps * alpha;
        }
      } else {
        const ammo = calcWeaponAmmo(w, pips, poolSize, allWeapons, mult);
        if (ammo == null || ammo <= 0) continue;
        // Regen does NOT happen while firing — it's a burst → stop → regen cycle
        const regenRPS = w.maxRegenPerSec ?? 15;
        const regenCooldown = w.regenCooldown ?? 0.25;
        const maxAmmo = w.maxAmmoLoad ?? 75;

        const burstTime = ammo / rps;
        const regenTime = regenCooldown + maxAmmo / regenRPS;
        const cycleTime = burstTime + regenTime;
        const burstDmg = ammo * alpha;

        if (burstTime >= W) {
          total += W * rps * alpha;
        } else if (cycleTime <= 0) {
          total += burstDmg;
        } else {
          const fullCycles = Math.floor(W / cycleTime);
          const remaining = W - fullCycles * cycleTime;
          total += fullCycles * burstDmg + Math.min(remaining, burstTime) * rps * alpha;
        }
      }
    }
    return total;
  }

  pilotBurstDPS = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.directWeapons().reduce((s, w) => s + this.effectiveDPS(w), 0);
  });
  pilotBurst = computed(() => {
    if (!this.weaponsLive()) return { damage: 0, time: 0 };
    return this.calcBurst(this.directWeapons());
  });
  pilotDPS = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.calcDamageIn10s(this.directWeapons()) / this.DPS_WINDOW;
  });
  pilotAlpha = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.directWeapons().reduce((s, w) => s + (w.alphaDamage ?? 0), 0);
  });

  crewBurstDPS = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.turretWeapons().reduce((s, w) => s + this.effectiveDPS(w), 0);
  });
  crewBurst = computed(() => {
    if (!this.weaponsLive()) return { damage: 0, time: 0 };
    return this.calcBurst(this.turretWeapons());
  });
  crewDPS = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.calcDamageIn10s(this.turretWeapons()) / this.DPS_WINDOW;
  });
  crewAlpha = computed(() => {
    if (!this.weaponsLive()) return 0;
    return this.turretWeapons().reduce((s, w) => s + (w.alphaDamage ?? 0), 0);
  });

  totalMissileDmg = computed(() => this.missiles().reduce((s, m) => s + (m.alphaDamage ?? 0), 0));
  totalBombDmg = computed(() => this.bombs().reduce((s, b) => s + (b.alphaDamage ?? 0), 0));

  /** Ammo + regen timer at current weapon pips for each energy weapon. */
  pilotWeaponAmmo = computed(() => {
    const allWeapons = this.data.allLoadoutWeapons();
    const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
    const pips = this.data.weaponsPower();
    const mult = this.data.selectedShip()?.ammoLoadMultiplier ?? 1;
    return this.directWeapons()
      .filter(w => !w.isBallistic && w.costPerBullet)
      .map(w => {
        const ammo = calcWeaponAmmo(w, pips, poolSize, allWeapons, mult);
        const regenRPS = w.maxRegenPerSec ?? 15;
        const maxAmmo = w.maxAmmoLoad ?? 75;
        const regenTime = (w.regenCooldown ?? 0.25) + maxAmmo / regenRPS;
        return { name: w.name, ammo, regenTime: Math.round(regenTime * 10) / 10 };
      });
  });

  // All shields contribute to HP pool (primaries + excess)
  totalShieldHP = computed(() =>
    this.equippedItems().filter(i => i.type === 'Shield').reduce((s, sh) => s + (sh.hp ?? 0), 0)
  );

  // Only first 2 shields (primaries) contribute to regen, scaled by power pips
  // Includes shields from module sub-slots (e.g., Aurora DM Module)
  private primaryShieldEntries = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const loadout = this.data.loadout();
    const shieldEntries: { hpId: string; item: any }[] = [];
    // Top-level shield hardpoints
    for (const hp of ship.hardpoints) {
      if (loadout[hp.id]?.type === 'Shield') {
        shieldEntries.push({ hpId: hp.id, item: loadout[hp.id] });
      }
    }
    // Module sub-slot shields
    for (const [key, item] of Object.entries(loadout)) {
      if (item?.type === 'Shield' && key.includes('.') && !shieldEntries.some(e => e.hpId === key)) {
        shieldEntries.push({ hpId: key, item });
      }
    }
    return shieldEntries.slice(0, 2);
  });

  // Linear model: totalRegen scales as (allocatedPips / maxPips) across the
  // combined shield pool.  Needs in-game validation at
  // non-max pip levels.
  shieldRegenRate = computed(() => {
    const alloc = this.data.powerAlloc();
    const entries = this.primaryShieldEntries();
    if (entries.length === 0) return 0;

    const maxRegen = entries.reduce((s, { item }) => s + (item.regenRate ?? 0), 0);
    const totalAlloc = entries.reduce((s, { hpId }) => s + (alloc[hpId] ?? 0), 0);
    const totalMax = entries.reduce((s, { item }) => s + Math.max(1, (item.powerMax ?? 0) - 1), 0);

    if (totalMax <= 0 || totalAlloc <= 0) return 0;
    return maxRegen * (totalAlloc / totalMax);
  });

  shieldRegenTime = computed(() => {
    const hp = this.totalShieldHP();
    const regen = this.shieldRegenRate();
    return regen > 0 ? hp / regen : 0;
  });


  // Signature — summed from powered-on components, scaled by power pips.
  // Power plant EM scales with power utilization (totalPowerUsed / totalPowerOutput).
  // Validated via Aurora SE cooler-swap test: predicted delta 2,230 vs game delta 2,200.
  totalEM = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return 0;
    const loadout = this.data.loadout();
    const alloc = this.data.powerAlloc();
    const wpnPower = this.data.weaponsPower();
    const powerOut = this.data.totalPowerOut();
    const powerUsed = this.data.totalPowerUsed();
    const utilization = powerOut > 0 ? Math.min(1, powerUsed / powerOut) : 0;
    let em = 0;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (!item) continue;
      const sig = item.emSignature ?? item.emMax ?? 0;
      if (sig <= 0) continue;
      if (item.type === 'WeaponGun' || item.type === 'WeaponTachyon') {
        // Weapons: on if weapons pool has power
        if (wpnPower > 0) em += sig;
      } else if (item.type === 'PowerPlant') {
        // Power plants: EM scales with power utilization
        em += sig * utilization;
      } else {
        // Shields, coolers, QDs, life support, radar: scale by power pips
        const pips = alloc[hp.id] ?? 0;
        em += sig * bandModAt(item, pips);
      }
    }
    // Include module sub-slot components (dotted keys)
    for (const [key, item] of Object.entries(loadout)) {
      if (!key.includes('.') || !item) continue;
      const sig = item.emSignature ?? item.emMax ?? 0;
      if (sig <= 0) continue;
      const pips = alloc[key] ?? 0;
      em += sig * bandModAt(item, pips);
    }
    return em;
  });

  totalIR = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return 0;
    const mult = ship.signalIR ?? 1;
    const loadout = this.data.loadout();
    const alloc = this.data.powerAlloc();
    // Sum nominal cooler IR at current pips, and compute weighted MCF of active coolers
    let irMax = 0;
    let mcfWeighted = 0;
    let irTotal = 0;
    const processIR = (key: string, item: Item | null) => {
      if (!item || !item.irSignature) return;
      const pips = alloc[key] ?? 0;
      const contribution = item.irSignature * bandModAt(item, pips);
      irMax += contribution;
      if (contribution > 0) {
        mcfWeighted += (item.minConsumptionFraction ?? 0.333) * contribution;
        irTotal += contribution;
      }
    };
    for (const hp of ship.hardpoints) processIR(hp.id, loadout[hp.id]);
    // Include module sub-slot components (dotted keys)
    for (const [key, item] of Object.entries(loadout)) {
      if (key.includes('.')) processIR(key, item);
    }
    if (irMax <= 0) return 0;
    const mcf = irTotal > 0 ? mcfWeighted / irTotal : 0.333;
    // Cooling supply and demand — IR is the greater of idle (MCF) or actual load
    let supply = 0;
    let demand = 0;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (!item) continue;
      const pips = alloc[hp.id] ?? 0;
      if (item.type === 'Cooler' && item.coolingRate) {
        supply += coolerSupply(item, pips);
      }
      if (item.type === 'Shield' || item.type === 'Cooler' ||
                 item.type === 'LifeSupportGenerator' || item.type === 'QuantumDrive' ||
                 item.type === 'Radar') {
        demand += pips;
      }
    }
    demand += this.data.weaponsPower();
    demand += this.data.toolPower();
    demand += this.data.tractorPower();
    demand += this.data.thrusterPower();
    demand += supply * 0.12; // PP idle heat fraction
    // Normal operation: coolers idle at MCF. Overloaded: demand/supply takes over.
    const loadRatio = supply > 0 ? Math.min(1, demand / supply) : 0;
    const irFactor = Math.max(mcf, loadRatio);
    return irMax * irFactor * mult;
  });

  crossSection = computed(() => this.data.selectedShip()?.signalCrossSection);

  // ── Armor Check ─────────────────────────────────────────

  private readonly pinnedWeaponNames = ['NDB-26 Repeater', 'NDB-28 Repeater', 'NDB-30 Repeater'];

  armorCheck = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return null;
    const physDeflect = ship.armorDeflectPhys ?? 0;
    const enrgDeflect = ship.armorDeflectEnrg ?? 0;
    if (physDeflect <= 0 && enrgDeflect <= 0) return null;

    const allWeapons = this.data.items().filter(i => i.type === 'WeaponGun' && i.damage && !i.name.includes('PLACEHOLDER'));

    const buildList = (deflect: number, dmgType: 'physical' | 'energy') => {
      if (deflect <= 0) return [];
      const relevant = allWeapons.filter(w => (w.damage![dmgType] ?? 0) >= 1);

      // Pinned weapons
      const pinned = new Set<string>();
      for (const name of this.pinnedWeaponNames) {
        const w = relevant.find(w => w.name === name);
        if (w) pinned.add(w.className);
      }

      // 3 closest weapons to the deflect threshold (by absolute distance to deflect)
      const sorted = [...relevant].sort((a, b) =>
        Math.abs((a.damage![dmgType] ?? 0) - deflect) - Math.abs((b.damage![dmgType] ?? 0) - deflect)
      );
      for (const w of sorted) {
        if (pinned.size >= pinned.size + 3 - (pinned.size - this.pinnedWeaponNames.length)) break;
        pinned.add(w.className);
        if ([...pinned].filter(cn => !this.pinnedWeaponNames.includes(relevant.find(r => r.className === cn)?.name ?? '')).length >= 3) break;
      }

      // Actually, simpler approach: get pinned + 3 closest non-pinned
      const closestNonPinned = sorted.filter(w => !pinned.has(w.className)).slice(0, 3);
      closestNonPinned.forEach(w => pinned.add(w.className));

      const result = relevant
        .filter(w => pinned.has(w.className))
        .map(w => ({
          name: w.name,
          size: w.size ?? 0,
          alpha: w.damage![dmgType] ?? 0,
          penetrates: (w.damage![dmgType] ?? 0) > deflect,
        }))
        .sort((a, b) => a.alpha - b.alpha);

      return result;
    };

    return {
      physDeflect,
      enrgDeflect,
      physical: buildList(physDeflect, 'physical'),
      energy: buildList(enrgDeflect, 'energy'),
    };
  });

  // ── Armor Detail popout ─────────────────────────────────

  showArmorDetail = signal(false);

  armorDetailList = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return { physical: [] as any[], energy: [] as any[], physDeflect: 0, enrgDeflect: 0 };
    const physDeflect = ship.armorDeflectPhys ?? 0;
    const enrgDeflect = ship.armorDeflectEnrg ?? 0;
    const allWeapons = this.data.items().filter(i => i.type === 'WeaponGun' && i.damage && !i.name.includes('PLACEHOLDER'));

    const buildFull = (deflect: number, dmgType: 'physical' | 'energy') => {
      if (deflect <= 0) return [];
      return allWeapons
        .filter(w => (w.damage![dmgType] ?? 0) >= 1)
        .map(w => ({
          name: w.name,
          size: w.size ?? 0,
          alpha: w.damage![dmgType] ?? 0,
          penetrates: (w.damage![dmgType] ?? 0) > deflect,
        }))
        .sort((a, b) => a.size - b.size || a.alpha - b.alpha);
    };

    return {
      physDeflect,
      enrgDeflect,
      physical: buildFull(physDeflect, 'physical'),
      energy: buildFull(enrgDeflect, 'energy'),
    };
  });

  constructor(public data: DataService) {}

  pct(val: number | undefined): string {
    return ((val ?? 0) * 100).toFixed(0) + '%';
  }
}

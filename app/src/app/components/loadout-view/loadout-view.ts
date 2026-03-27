import { Component, computed, signal, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { DpsPanelComponent } from '../dps-panel/dps-panel';
import { HardpointSlotComponent } from '../hardpoint-slot/hardpoint-slot';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { Hardpoint, Item } from '../../models/db.models';

@Component({
  selector: 'app-loadout-view',
  standalone: true,
  imports: [DpsPanelComponent, HardpointSlotComponent, PowerBarsComponent, UpperCasePipe],
  templateUrl: './loadout-view.html',
  styleUrl: './loadout-view.scss',
})
export class LoadoutViewComponent {
  goToSubmit = output<void>();

  needsAccelData = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return false;
    if (!ship.accelTestedDate) return true;
    const tested = new Date(ship.accelTestedDate).getTime();
    return (Date.now() - tested) > 90 * 24 * 60 * 60 * 1000;
  });

  readonly utilityTypes = ['Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar', 'LifeSupportGenerator'];

  collapsedSections = signal<Set<string>>(new Set([
    'pilot-guns', 'crew-guns', 'missiles', 'mining', 'power', 'pdc', 'tractor', 'coolers', 'modules',
  ]));

  isCollapsed(section: string): boolean {
    return this.collapsedSections().has(section);
  }

  toggleSection(section: string): void {
    this.collapsedSections.update(s => {
      const next = new Set(s);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  private isCrewHardpoint(hp: Hardpoint): boolean {
    if (hp.type === 'TurretBase') return true;
    if (hp.type === 'Turret') {
      const ct = hp.controllerTag?.toLowerCase() ?? '';
      // gunNacelle = pilot-controlled weapon nacelle (e.g., Constellation nose guns)
      return !!ct && !ct.includes('remote_turret') && !ct.includes('pilot') && !ct.includes('gunnacelle') && !ct.includes('gunnose');
    }
    return false;
  }

  private isPdc(hp: Hardpoint): boolean {
    return hp.id.toLowerCase().includes('_pdc_') || hp.id.toLowerCase().includes('_pdc');
  }

  private isTractorTurret(hp: Hardpoint): boolean {
    return hp.type === 'Turret' && hp.id.toLowerCase().includes('tractor');
  }

  gunSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => {
      if (hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') return false;
      if (this.isPdc(hp)) return false;
      if (this.isSalvageTurret(hp)) return false;
      if (this.isTractorTurret(hp)) return false;
      return hp.type === 'WeaponGun' || hp.type === 'Turret' || hp.type === 'TurretBase' ||
        hp.allTypes?.some(t => t.type === 'WeaponGun' || t.type === 'Turret' || t.type === 'TurretBase');
    });
  });

  tractorSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => this.isTractorTurret(hp));
  });

  pdcSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp =>
      this.isPdc(hp) && hp.type === 'Turret'
    );
  });

  pilotGunSlots = computed(() => this.gunSlots().filter(hp => !this.isCrewHardpoint(hp)));
  crewGunSlots  = computed(() => this.gunSlots().filter(hp =>  this.isCrewHardpoint(hp)));

  private isSalvageTurret(hp: Hardpoint): boolean {
    return hp.type === 'Turret' && hp.id.toLowerCase().includes('salvage');
  }

  miningSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    // Mining and salvage slots (including Turret-type salvage arms like Reclaimer)
    return ship.hardpoints.filter(hp => {
      if (this.isSalvageTurret(hp)) return true;
      const types = [hp.type, ...(hp.allTypes?.map(t => t.type) ?? [])];
      return types.some(t => ['ToolArm', 'WeaponMining', 'UtilityTurret', 'SalvageHead'].includes(t));
    });
  });

  /** Get combined stats for a specific laser slot ID, or null if no modules equipped. */
  getCombinedForLaser(laserId: string) {
    return this.miningCombinedStats().find(c => c.laserId === laserId) ?? null;
  }

  /** Get combined totals record for a specific laser slot, for passing to hardpoint-slot input. */
  getCombinedTotals(laserId: string): Record<string, number> | null {
    return this.miningCombinedStats().find(c => c.laserId === laserId)?.totals ?? null;
  }

  /** True when the ship has mining/salvage equipment — reorders left column to prioritize tools. */
  isMiningShip = computed(() => this.miningSlots().length > 0);

  /** Combined mining stats: base laser + all equipped modules, per laser slot.
   *  Only shown when at least one module is equipped. */
  miningCombinedStats = computed(() => {
    const loadout = this.data.loadout();
    const results: { laserId: string; laserName: string; totals: Record<string, number>; stats: { label: string; value: string }[] }[] = [];

    for (const [slotId, item] of Object.entries(loadout)) {
      if (item?.type !== 'WeaponMining') continue;

      // Check if any modules are equipped under this laser
      const hasModules = Object.entries(loadout).some(
        ([key, mod]) => key.startsWith(slotId + '.') && mod?.type === 'MiningModifier'
      );
      if (!hasModules) continue;

      const modKeys = ['miningInstability', 'miningOptimalWindow', 'miningOptimalRate',
                        'miningResistance', 'miningShatterDamage', 'miningInertMaterials', 'miningOvercharge'] as const;
      const totals: Record<string, number> = {};
      for (const k of modKeys) {
        if ((item as any)[k] != null) totals[k] = (item as any)[k];
      }
      // Sum module modifiers
      for (const [key, mod] of Object.entries(loadout)) {
        if (key.startsWith(slotId + '.') && mod?.type === 'MiningModifier') {
          for (const k of modKeys) {
            if ((mod as any)[k] != null) totals[k] = (totals[k] ?? 0) + (mod as any)[k];
          }
        }
      }
      const fmtPct = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + '%';
      const labels: Record<string, string> = {
        miningInstability: 'Instability', miningOptimalWindow: 'Optimal Window',
        miningOptimalRate: 'Optimal Rate', miningResistance: 'Resistance',
        miningShatterDamage: 'Shatter Dmg', miningInertMaterials: 'Inert Materials',
        miningOvercharge: 'Overcharge',
      };
      // Compute combined power multiplier from active modules
      let powerMult = 1;
      for (const [key, mod] of Object.entries(loadout)) {
        if (key.startsWith(slotId + '.') && mod?.type === 'MiningModifier' && mod.miningPowerMult) {
          powerMult *= mod.miningPowerMult;
        }
      }
      const combinedMinPower = item.miningMinPower ? Math.round(item.miningMinPower * powerMult) : null;
      const combinedMaxPower = item.miningMaxPower ? Math.round(item.miningMaxPower * powerMult) : null;
      if (combinedMinPower != null) totals['miningMinPower'] = combinedMinPower;
      if (combinedMaxPower != null) totals['miningMaxPower'] = combinedMaxPower;

      const stats: { label: string; value: string }[] = [];
      // Power stats (with module multiplier applied)
      if (combinedMinPower != null) stats.push({ label: 'Min Power', value: combinedMinPower.toString() });
      if (combinedMaxPower != null) stats.push({ label: 'Max Power', value: combinedMaxPower.toString() });
      if (item.optimalRange) stats.push({ label: 'Opt Range', value: item.optimalRange + 'm' });
      if (item.maxRange) stats.push({ label: 'Max Range', value: item.maxRange + 'm' });
      // Combined modifier stats
      for (const k of modKeys) {
        if (totals[k] != null) stats.push({ label: labels[k], value: fmtPct(totals[k]) });
      }
      if (stats.length) results.push({ laserId: slotId, laserName: item.name, totals, stats });
    }
    return results;
  });

  moduleSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => hp.type === 'Module');
  });

  missileSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const lo = ship.defaultLoadout ?? {};
    // Only show missile hardpoints that have a default loadout entry
    return ship.hardpoints.filter(hp =>
      (hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') &&
      lo[hp.id.toLowerCase()]
    );
  });

  utilitySlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => this.utilityTypes.includes(hp.type));
  });

  otherSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const guns = this.gunSlots();
    const missiles = this.missileSlots();
    const utilities = this.utilitySlots();
    const pdcs = this.pdcSlots();
    const modules = this.moduleSlots();
    return ship.hardpoints.filter(hp =>
      !guns.includes(hp) && !missiles.includes(hp) && !utilities.includes(hp) &&
      !pdcs.includes(hp) && !modules.includes(hp) && !this.isPdc(hp) &&
      !['Radar', 'Sensor', 'QuantumFuelTank', 'Paints'].includes(hp.type)
    );
  });

  massDisplay = computed(() => {
    const m = this.data.selectedShip()?.mass;
    return m ? (m / 1000).toFixed(0) + 't' : '—';
  });

  shipImageSrc = computed(() => {
    const cls = this.data.selectedShip()?.className ?? '';
    // Try wiki .jpg first, then .webp, then .png (silhouette fallback)
    return `ship-images/${cls}.jpg`;
  });

  onShipImageError(img: HTMLImageElement): void {
    const cls = this.data.selectedShip()?.className ?? '';
    if (img.src.endsWith('.jpg')) {
      img.src = `ship-images/${cls.toLowerCase()}.webp`;
    } else if (img.src.endsWith('.webp')) {
      img.src = `ship-images/${cls}.png`;
    } else {
      img.style.display = 'none';
    }
  }

  /** Effective cargo: base + module cargoBonus (if any). */
  effectiveCargo = computed(() => {
    const base = this.data.selectedShip()?.cargoCapacity ?? 0;
    const loadout = this.data.loadout();
    let bonus = 0;
    for (const item of Object.values(loadout)) {
      if (item?.cargoBonus) bonus += item.cargoBonus;
    }
    return base + bonus;
  });

  /** Two cheapest buy prices for the selected ship. */
  shipBuyPrices = computed(() => {
    const prices = this.data.selectedShip()?.shopPrices;
    if (!prices?.length) return [];
    return [...prices]
      .filter(p => p.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 2);
  });

  fmtPrice(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  /** Build key-value rows from the focused item's data fields. */
  focusRows = computed(() => {
    const item = this.data.focusedItem();
    if (!item) return [];
    const skip = new Set(['className', 'sruRef', 'heatRef', 'psruRef', 'ammoRef',
      'powerBands', 'damage', 'powerMin']);
    const rows: { key: string; value: string }[] = [];
    for (const [k, v] of Object.entries(item)) {
      if (skip.has(k) || v == null || v === '' || v === 0 || v === false) continue;
      if (typeof v === 'object' && k === 'damage') {
        const dmg = v as Record<string, number>;
        for (const [dk, dv] of Object.entries(dmg)) {
          if (dv > 0) rows.push({ key: `dmg.${dk}`, value: String(dv) });
        }
      } else if (typeof v === 'object') {
        continue; // skip complex objects
      } else {
        rows.push({ key: k, value: String(v) });
      }
    }
    // Add damage breakdown
    const dmg = item.damage;
    if (dmg) {
      for (const [dk, dv] of Object.entries(dmg)) {
        if ((dv as number) > 0) rows.push({ key: `dmg.${dk}`, value: String(dv) });
      }
    }
    return rows;
  });

  private _subSlotData = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship?.defaultLoadout) return { slots: {} as Record<string, Hardpoint[]>, rackLeafs: {} as Record<string, string[]> };
    const defaultLoadout = ship.defaultLoadout;
    const currentLoadout = this.data.loadout();
    const allKeys = Object.keys(defaultLoadout);
    const items = this.data.items();
    const slots: Record<string, Hardpoint[]> = {};
    const rackLeafs: Record<string, string[]> = {};

    for (const hp of ship.hardpoints) {
      const parentItem = currentLoadout[hp.id];
      const hpIsTurret = hp.type === 'Turret' || hp.type === 'TurretBase';
      const hpIsRack   = hp.type === 'MissileLauncher' || hp.type === 'BombLauncher';
      const isRack = hpIsRack ||
                     parentItem?.type === 'MissileLauncher' ||
                     parentItem?.type === 'BombLauncher';
      const parentIsDirectWeapon = parentItem?.type === 'WeaponGun' || parentItem?.type === 'WeaponTachyon';
      const hpIsToolArm = hp.type === 'ToolArm' || hp.type === 'UtilityTurret';
      // Modules are handled separately below
      if (hp.type === 'Module') continue;
      const showSubs = !parentIsDirectWeapon && (
                       parentItem?.type === 'WeaponMount' ||
                       parentItem?.type === 'Turret' ||
                       parentItem?.type === 'TurretBase' ||
                       parentItem?.type === 'ToolArm' ||
                       parentItem?.type === 'UtilityTurret' ||
                       hpIsTurret || hpIsToolArm ||
                       isRack);
      if (!showSubs) continue;

      const prefix = hp.id.toLowerCase() + '.';
      // Check both default loadout keys AND current loadout keys (for PDC auto-fill etc.)
      // Exclude dynamic module keys (.module_N) — these are generated, not part of the loadout hierarchy
      const loadoutKeys = Object.keys(currentLoadout)
        .map(k => k.toLowerCase())
        .filter(k => !k.includes('.module_'));
      const childKeys = [...new Set([
        ...allKeys.filter(k => k.startsWith(prefix)),
        ...loadoutKeys.filter(k => k.startsWith(prefix)),
      ])];
      if (!childKeys.length) continue;
      const leaves = childKeys.filter(k => !childKeys.some(k2 => k2.startsWith(k + '.')));

      if (isRack) {
        // Collect all missile leaf keys
        const missileLeaves = leaves.filter(leaf => {
          const cls = defaultLoadout[leaf];
          const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
          return item?.type === 'Missile';
        });
        if (!missileLeaves.length) continue;
        // Derive size and capacity from the currently equipped rack, falling back to default loadout
        const equippedRack = (parentItem?.type === 'MissileLauncher' || parentItem?.type === 'BombLauncher')
          ? parentItem : null;
        const slotSize = equippedRack?.missileSize
          ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeaves[0]] ?? '').toLowerCase())?.size
          ?? hp.maxSize;
        const capacity  = equippedRack?.capacity ?? missileLeaves.length;
        const activeLeaves = missileLeaves.slice(0, capacity);
        const firstLeaf = activeLeaves[0];
        slots[hp.id] = [{
          id: firstLeaf,
          label: `Missiles ×${capacity}`,
          type: 'Missile',
          subtypes: '',
          minSize: slotSize,
          maxSize: slotSize,
          flags: '',
          allTypes: [{ type: 'Missile', subtypes: '' }],
        }];
        rackLeafs[firstLeaf] = activeLeaves;
      } else {
        // WeaponMount / Turret: individual gun sub-slots
        const weaponLock = parentItem?.weaponLock ?? null;
        const lockedWeapon = weaponLock
          ? items.find(i => i.className.toLowerCase() === weaponLock.toLowerCase()) ?? null
          : null;

        const subSlots: Hardpoint[] = [];
        let gunIdx = 1;
        for (const leaf of leaves) {
          const cls = defaultLoadout[leaf] ?? currentLoadout[leaf]?.className;
          if (!cls) continue;
          const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
          if (!item) continue;
          const isGun = item.type === 'WeaponGun';
          const isTractor = item.type === 'TractorBeam';
          const isMiningLaser = item.type === 'WeaponMining';
          const isMiningMod = item.type === 'MiningModifier';
          const isSalvageHead = item.type === 'SalvageHead';
          const isSalvageMod = item.type === 'SalvageModifier';
          if (!isGun && !isTractor && !isMiningLaser && !isMiningMod && !isSalvageHead && !isSalvageMod) continue;
          const slotSize = lockedWeapon ? (lockedWeapon.size ?? hp.maxSize) : (item.size ?? hp.maxSize);
          const isGimbal = parentItem?.type === 'WeaponMount';
          const slotType = isMiningLaser ? 'WeaponMining' : isMiningMod ? 'MiningModifier' : isSalvageHead ? 'SalvageHead' : isSalvageMod ? 'SalvageModifier' : isTractor ? 'TractorBeam' : 'WeaponGun';
          const slotLabel = isMiningLaser ? `Laser ${gunIdx++}` : isMiningMod ? `Module ${gunIdx++}` : isSalvageHead ? `Salvage Head ${gunIdx++}` : isSalvageMod ? `Salvage Tool ${gunIdx++}` : `Gun ${gunIdx++}`;
          subSlots.push({
            id: leaf,
            label: slotLabel,
            type: slotType,
            subtypes: '',
            minSize: weaponLock ? slotSize : (isGimbal && isGun ? Math.max(1, slotSize - 1) : slotSize),
            maxSize: slotSize,
            flags: weaponLock ? `weaponLock:${weaponLock}` : '',
            allTypes: [{ type: slotType, subtypes: '' }],
          });
        }

        // Generate dynamic module slots for mining lasers
        for (const sub of subSlots) {
          if (sub.type !== 'WeaponMining') continue;
          const equippedLaser = currentLoadout[sub.id];
          const numModules = equippedLaser?.moduleSlots ?? 0;
          if (numModules > 0) {
            const moduleSubSlots: Hardpoint[] = [];
            for (let mi = 1; mi <= numModules; mi++) {
              const modId = `${sub.id}.module_${mi}`;
              moduleSubSlots.push({
                id: modId,
                label: `Module ${mi}`,
                type: 'MiningModifier',
                subtypes: '',
                minSize: 1,
                maxSize: 1,
                flags: '',
                allTypes: [{ type: 'MiningModifier', subtypes: '' }],
              });
            }
            slots[sub.id] = moduleSubSlots;
          }
        }

        // Check for nested missile racks — only when the default turret is equipped,
        // since the rack belongs to that specific turret, not a replacement like the TMSB-5
        const defaultParentCls = defaultLoadout[hp.id.toLowerCase()];
        const equippedParentCls = currentLoadout[hp.id]?.className?.toLowerCase();
        const isDefaultTurretEquipped = !equippedParentCls || !defaultParentCls ||
          equippedParentCls === defaultParentCls.toLowerCase();

        const hpDepth = hp.id.split('.').length;
        const directChildKeys = isDefaultTurretEquipped
          ? childKeys.filter(k => k.split('.').length === hpDepth + 1)
          : [];
        for (const childKey of directChildKeys) {
          const rackCls = defaultLoadout[childKey];
          if (!rackCls) continue;
          const rackDefaultItem = items.find(i => i.className.toLowerCase() === rackCls.toLowerCase());
          if (!rackDefaultItem || (rackDefaultItem.type !== 'MissileLauncher' && rackDefaultItem.type !== 'BombLauncher')) continue;

          // Find missile leaves under this rack
          const rackPrefix = childKey.toLowerCase() + '.';
          const rackChildKeys = allKeys.filter(k => k.startsWith(rackPrefix));
          const rackLeafKeys = rackChildKeys.filter(k => !rackChildKeys.some(k2 => k2.startsWith(k + '.')));
          const missileLeafKeys = rackLeafKeys.filter(leaf => {
            const missileCls = defaultLoadout[leaf];
            const missileItem = items.find(i => i.className.toLowerCase() === missileCls?.toLowerCase());
            return missileItem?.type === 'Missile';
          });
          if (!missileLeafKeys.length) continue;

          // Use the currently equipped rack if available, otherwise fall back to default
          const equippedRack = currentLoadout[childKey];
          const rackItem = (equippedRack?.type === 'MissileLauncher' || equippedRack?.type === 'BombLauncher')
            ? equippedRack : rackDefaultItem;
          const slotSize = rackItem.missileSize
            ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeafKeys[0]] ?? '').toLowerCase())?.size
            ?? hp.maxSize;
          const capacity = rackItem.capacity ?? missileLeafKeys.length;
          const activeLeaves = missileLeafKeys.slice(0, capacity);
          const firstMissileLeaf = activeLeaves[0];

          subSlots.push({
            id: firstMissileLeaf,
            label: `Missiles ×${capacity}`,
            type: 'Missile',
            subtypes: '',
            minSize: slotSize,
            maxSize: slotSize,
            flags: '',
            allTypes: [{ type: 'Missile', subtypes: '' }],
          });
          rackLeafs[firstMissileLeaf] = activeLeaves;
        }

        if (subSlots.length) slots[hp.id] = subSlots;
      }
    }
    // Module sub-slots: build from equipped module's subPorts + default loadout
    for (const hp of ship.hardpoints) {
      if (hp.type !== 'Module') continue;
      const equippedModule = currentLoadout[hp.id];
      if (!equippedModule?.subPorts?.length) continue;

      const moduleSubs: Hardpoint[] = [];
      const prefix = hp.id.toLowerCase() + '.';

      // Group missile sub-ports into a single collapsed rack entry
      const missilePorts = equippedModule.subPorts.filter((sp: any) => sp.type === 'Missile' || sp.type === 'MissileLauncher');
      if (missilePorts.length) {
        // Find missile leaves from both defaultLoadout AND current loadout
        const missileLeaves: string[] = [];
        const allLoadoutKeys = [...new Set([...allKeys, ...Object.keys(currentLoadout).map(k => k.toLowerCase())])];
        for (const sp of missilePorts) {
          const rackKey = `${hp.id}.${sp.id}`;
          const rackPrefix = rackKey.toLowerCase() + '.';
          const rackChildren = allLoadoutKeys.filter(k => k.startsWith(rackPrefix));
          if (rackChildren.length) {
            const leaves = rackChildren.filter(k => !rackChildren.some(k2 => k2.startsWith(k + '.')));
            missileLeaves.push(...leaves);
          } else {
            // No children found — check if the rack itself is equipped and use its capacity
            const equippedRack = currentLoadout[rackKey];
            if (equippedRack?.type === 'MissileLauncher' && equippedRack.capacity) {
              for (let mi = 1; mi <= equippedRack.capacity; mi++) {
                missileLeaves.push(`${rackKey}.missile_0${mi}_attach`);
              }
            }
          }
        }
        if (missileLeaves.length) {
          const firstMissileItem = currentLoadout[missileLeaves[0]] ??
            items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeaves[0]] ?? '').toLowerCase());
          const missileSize = firstMissileItem?.size ?? 9;
          const firstLeaf = missileLeaves[0];
          moduleSubs.push({
            id: firstLeaf,
            label: `Torpedoes ×${missileLeaves.length}`,
            type: 'Missile',
            subtypes: '',
            minSize: missileSize,
            maxSize: missileSize,
            flags: '',
            allTypes: [{ type: 'Missile', subtypes: '' }],
          });
          rackLeafs[firstLeaf] = missileLeaves;
        }
      }

      // Non-missile/door sub-ports (e.g. shield)
      for (const sp of equippedModule.subPorts) {
        if (sp.type === 'Missile' || sp.type === 'MissileLauncher' || sp.type === 'Door' || sp.type === 'Misc') continue;
        const subId = `${hp.id}.${sp.id}`;
        moduleSubs.push({
          id: subId,
          label: sp.type === 'Shield' ? 'Shield' : sp.id.replace(/_/g, ' '),
          type: sp.type,
          subtypes: '',
          minSize: sp.minSize,
          maxSize: sp.maxSize,
          flags: '',
          allTypes: sp.allTypes.map((t: any) => ({ type: t.type, subtypes: '' })),
        });
      }

      if (moduleSubs.length) slots[hp.id] = moduleSubs;
    }

    return { slots, rackLeafs };
  });

  subSlotsMap    = computed(() => this._subSlotData().slots);
  rackLeafIdsMap = computed(() => this._subSlotData().rackLeafs);

  // Type-specific system slot groups
  shieldSlots = computed(() => this.utilitySlots().filter(hp => hp.type === 'Shield'));
  primaryShieldSlots = computed(() => this.shieldSlots().slice(0, 2));
  excessShieldSlots = computed(() => this.shieldSlots().slice(2));
  ppSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'PowerPlant'));
  coolerSlots = computed(() => this.utilitySlots().filter(hp => hp.type === 'Cooler'));
  qdSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'QuantumDrive'));
  radarSlots  = computed(() => this.utilitySlots().filter(hp => hp.type === 'Radar'));
  lsSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'LifeSupportGenerator'));

  // Thruster-power-scaled rotation values.
  // thrusterMult = 0 at bar 1 (min), 1 at bar max (full).
  // Boosted at bar i = pitch + thrusterMult × (pitchBoosted - pitch)
  // Non-boosted at bar i = boostedAtPower × (pitch / pitchBoosted)
  private thrusterMult = computed(() => {
    const ship = this.data.selectedShip();
    const maxBars = ship?.thrusterPowerBars ?? 0;
    if (!maxBars || maxBars <= 1) return 1;
    return (this.data.thrusterPower() - 1) / (maxBars - 1);
  });

  private rotAtPower(base: number | undefined, boosted: number | undefined): { base: number; boosted: number } | null {
    if (!base) return null;
    const b = boosted ?? base;
    const m = this.thrusterMult();
    const boostedVal = base + m * (b - base);
    return { base: Math.round(base * 10) / 10, boosted: Math.round(boostedVal * 10) / 10 };
  }

  pitchRot = computed(() => {
    const s = this.data.selectedShip();
    return this.rotAtPower(s?.pitch, s?.pitchBoosted);
  });
  yawRot = computed(() => {
    const s = this.data.selectedShip();
    return this.rotAtPower(s?.yaw, s?.yawBoosted);
  });
  rollRot = computed(() => {
    const s = this.data.selectedShip();
    return this.rotAtPower(s?.roll, s?.rollBoosted);
  });

  constructor(public data: DataService) {}

  signalPct(val: number | undefined): string {
    if (val === undefined) return '—';
    const pct = Math.round((val - 1) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
}
